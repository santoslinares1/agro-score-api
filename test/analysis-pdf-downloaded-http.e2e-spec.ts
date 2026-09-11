// MEASUREMENT GAP P1-04 ("PDF descargado") — verificación de CIERRE del STOP-AND-REPORT del
// ticket ("Express/Nest no permite distinguir de forma fiable `finish` de cierre prematuro con
// el streaming vigente"): a diferencia de analysis-pdf-downloaded.e2e-spec.ts (que prueba la
// escritura atómica contra Postgres real) y de analysis.controller.spec.ts (que prueba la LÓGICA
// de la respuesta a 'finish'/'close' con un EventEmitter real de Node, sin un servidor HTTP real
// detrás), este archivo monta una app Nest REAL (`INestApplication` + `supertest`, mismo patrón
// que test/user-compute-throttler.e2e-spec.ts) y hace requests HTTP reales contra
// GET /analysis/:id/report/pdf — incluyendo abortar la conexión a mitad de un stream real, para
// confirmar que Node/Express distinguen 'finish' de un cierre prematuro también con el guard
// chain real (JwtAuthGuard) y el streaming real de por medio, no solo en una simulación aislada.
//
// PostgreSQL real (aislada, desechable) para Analysis/Field/User — PythonWorkerService/
// AnalysisVerdictService se stubean (no participan de este endpoint). ReportPdfService se
// reemplaza por un doble controlable: genera un stream real de Node cuyo ritmo de emisión se
// puede ajustar por test (rápido para el camino feliz, con demora deliberada para poder abortar
// la conexión ANTES de que termine en el caso de interrupción).
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Readable } from 'stream';
import request from 'supertest';
import { Repository } from 'typeorm';

import { AnalysisController } from '../src/analysis/analysis.controller';
import { AnalysisService } from '../src/analysis/analysis.service';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { UserComputeThrottlerGuard } from '../src/common/guards/user-compute-throttler.guard';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { ReportPdfService } from '../src/analysis/report-pdf/report-pdf.service';
import { UserRole } from '../src/users/user-role.enum';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

const TEST_JWT_SECRET =
  'p1-04-pdf-downloaded-http-e2e-test-secret-not-a-real-secret';

/**
 * Doble controlable de ReportPdfService.build: un stream de Node REAL (no un mock de pipe/end)
 * cuyo ritmo de emisión se ajusta por test. `chunkDelayMs=0` completa casi instantáneamente
 * (camino feliz); un delay mayor deja una ventana real para abortar la conexión a mitad de
 * camino (caso de interrupción). Mismo contrato de forma que pdfmake: los datos no empiezan a
 * fluir hasta que se llama a `.end()`.
 */
function buildControllableStream(
  chunkCount: number,
  chunkDelayMs: number,
): NodeJS.ReadableStream & { end(): void } {
  const readable = new Readable({ read() {} });
  let sent = 0;

  const pushNext = () => {
    if (sent >= chunkCount) {
      readable.push(null); // EOF real.
      return;
    }
    readable.push(Buffer.from(`chunk-${sent}-`.padEnd(64, '.')));
    sent += 1;
    setTimeout(pushNext, chunkDelayMs);
  };

  return Object.assign(readable, {
    end: () => {
      pushNext();
    },
  });
}

describe('MEASUREMENT GAP P1-04 — lifecycle HTTP real de GET /analysis/:id/report/pdf (Nest app real + Postgres real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let app: INestApplication | undefined;
  let jwtService: JwtService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let analysisRepo: Repository<Analysis>;
  let reportPdfServiceMock: { build: jest.Mock };
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'pdf_downloaded_p1_04_http',
    );
    createdDatabaseName = created.name;

    reportPdfServiceMock = { build: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          database: createdDatabaseName,
          entities: [User, Field, FieldLot, Analysis],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([User, Field, FieldLot, Analysis]),
        PassportModule,
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
        // AnalysisController también expone runFieldAnalysis (@UseGuards(..., UserComputeThrottlerGuard))
        // — Nest resuelve TODOS los guards del controller al armar el módulo, aunque estos tests
        // nunca llamen a esa ruta. Mismo bucket que app.module.ts real, ver
        // user-compute-throttler.e2e-spec.ts.
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 20 },
          { name: 'compute', ttl: 600_000, limit: 10 },
        ]),
      ],
      controllers: [AnalysisController],
      providers: [
        AnalysisService, // real — el set-once real contra Postgres es justo lo que se quiere probar.
        FieldsService, // real — ownership real.
        JwtStrategy,
        UserComputeThrottlerGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET' ? TEST_JWT_SECRET : undefined,
          },
        },
        {
          // JwtStrategy necesita resolver el usuario del token — no es lo que se prueba acá.
          provide: UsersService,
          useValue: {
            findById: jest.fn((id: string) =>
              Promise.resolve({
                id,
                email: `${id}@example.com`,
                role: UserRole.USER,
                isActive: true,
                tokenVersion: 0,
              }),
            ),
          },
        },
        { provide: PythonWorkerService, useValue: {} },
        {
          provide: AnalysisVerdictService,
          useValue: {
            findResponseByAnalysisId: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: ReportPdfService, useValue: reportPdfServiceMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    jwtService = moduleRef.get(JwtService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    analysisRepo = moduleRef.get(getRepositoryToken(Analysis));
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (app) {
      try {
        await app.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (createdDatabaseName) {
      try {
        await dropIsolatedTestDatabase(target, createdDatabaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Fallo(s) durante la limpieza de esta suite — ver causas.',
      );
    }
  });

  function tokenFor(userId: string): string {
    return jwtService.sign({
      sub: userId,
      email: `${userId}@example.com`,
      role: UserRole.USER,
      tokenVersion: 0,
    });
  }

  async function seedUserAndField(): Promise<{ user: User; field: Field }> {
    seedCounter += 1;
    const user = await userRepo.save(
      userRepo.create({
        email: `pdf-http-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado',
        fullName: `Usuario ${seedCounter}`,
      }),
    );
    const field = await fieldRepo.save(
      fieldRepo.create({
        userId: user.id,
        name: `Campo ${seedCounter}`,
        totalAreaHa: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        lots: [],
      }),
    );
    return { user, field };
  }

  async function seedAnalysis(field: Field): Promise<Analysis> {
    return analysisRepo.save(
      analysisRepo.create({
        fieldId: field.id,
        scope: 'field',
        lotName: 'Campo completo',
        status: 'Finalizado',
        startDate: '2026-01-01',
        endDate: '2026-01-08',
      }),
    );
  }

  it('descarga real completa vía HTTP: 200 con headers correctos, y firstPdfDownloadedAt queda seteado en la base real', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);
    reportPdfServiceMock.build.mockResolvedValue({
      stream: buildControllableStream(3, 0), // rápido — sin ventana de interrupción.
      filename: 'reporte-http.pdf',
    });

    const response = await request(app!.getHttpServer())
      .get(`/analysis/${analysis.id}/report/pdf`)
      .set('Authorization', `Bearer ${tokenFor(user.id)}`)
      .expect(200);

    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain(
      'attachment; filename="reporte-http.pdf"',
    );

    // 'finish' es asíncrono respecto de que supertest ya recibió la respuesta completa — dar
    // margen real para que el listener del servidor corra antes de leer la base.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).not.toBeNull();
  });

  it('ownership fallido: 404 real, nunca genera el PDF ni marca la descarga', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);
    const other = await seedUserAndField(); // otro usuario, otro field — sin relación con `analysis`.
    reportPdfServiceMock.build.mockClear();

    await request(app!.getHttpServer())
      .get(`/analysis/${analysis.id}/report/pdf`)
      .set('Authorization', `Bearer ${tokenFor(other.user.id)}`)
      .expect(404);

    expect(reportPdfServiceMock.build).not.toHaveBeenCalled();

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).toBeNull();
  });

  it('sin JWT: 401 real, nunca marca la descarga', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    await request(app!.getHttpServer())
      .get(`/analysis/${analysis.id}/report/pdf`)
      .expect(401);

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).toBeNull();
  });

  it('INTERRUPCIÓN REAL — el cliente aborta la conexión a mitad del stream: firstPdfDownloadedAt permanece NULL (nunca "finish" sin haber terminado)', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);
    // 40 chunks con 25ms de espera cada uno (~1s total) — ventana real amplia para abortar bien
    // a mitad de camino, sin depender de un timing ajustadísimo.
    reportPdfServiceMock.build.mockResolvedValue({
      stream: buildControllableStream(40, 25),
      filename: 'reporte-interrumpido.pdf',
    });

    const req = request(app!.getHttpServer())
      .get(`/analysis/${analysis.id}/report/pdf`)
      .set('Authorization', `Bearer ${tokenFor(user.id)}`);

    const pending = req.catch((error: unknown) => error); // el abort real rechaza — se captura, no se re-lanza.

    await new Promise((resolve) => setTimeout(resolve, 150)); // ~6 chunks entregados, lejos de terminar.
    req.abort(); // cierra el socket del cliente ANTES de que el servidor llegue a 'finish'.

    await pending;
    // Margen real para que el servidor procese el 'close' (y, crucialmente, para confirmar que
    // NUNCA llega un 'finish' tardío que marcara la descarga de todos modos).
    await new Promise((resolve) => setTimeout(resolve, 300));

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).toBeNull();
  });

  it('CONCURRENCIA REAL vía HTTP — dos descargas concurrentes completas del mismo Analysis conservan un único timestamp', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);
    reportPdfServiceMock.build.mockImplementation(() =>
      Promise.resolve({
        stream: buildControllableStream(3, 0),
        filename: 'reporte-concurrente.pdf',
      }),
    );
    const token = tokenFor(user.id);

    await Promise.all([
      request(app!.getHttpServer())
        .get(`/analysis/${analysis.id}/report/pdf`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
      request(app!.getHttpServer())
        .get(`/analysis/${analysis.id}/report/pdf`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).not.toBeNull();
    // Un solo valor coherente — no hay "dos timestamps" que comparar porque la columna es escalar;
    // la garantía real (un solo UPDATE efectivo) ya se prueba a nivel de Postgres en
    // analysis-pdf-downloaded.e2e-spec.ts. Acá lo que importa es que AMBAS descargas por HTTP
    // real terminan en 200 sin que la segunda falle por la primera.
  });
});
