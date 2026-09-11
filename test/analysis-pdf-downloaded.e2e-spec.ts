// MEASUREMENT GAP P1-04 ("PDF descargado"): set-once real de Analysis.firstPdfDownloadedAt vía
// AnalysisService.markPdfDownloaded, y la migración 1789150026874 en sí — contra PostgreSQL
// real, en una base aislada y desechable creada por esta misma ejecución (nunca `agro_score` ni
// las variables DB_* generales del backend, ver test/support/isolated-postgres-database.ts).
//
// Alcance deliberado de este archivo: prueba la escritura atómica contra Postgres real (lo que
// un mock no puede demostrar — que dos llamadas concurrentes disputando la misma fila dejan
// EXACTAMENTE un timestamp) y la migración en sí. El lifecycle HTTP real (`finish` vs. `close`,
// carrera de listener registrado antes de pipe/end) ya se prueba en
// analysis.controller.spec.ts con un `EventEmitter` real de Node — `http.ServerResponse` (y la
// `Response` de Express que lo extiende) ES un EventEmitter, así que emitir 'finish'/'close' ahí
// ejercita el mismo contrato de eventos que usa Node en producción; levantar un servidor HTTP
// real con sockets para este ticket no agrega evidencia proporcional al costo (ver el
// razonamiento en el reporte de la revisión de este ticket).
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { AddAnalysisFirstPdfDownloadedAt1789150026874 } from '../src/migrations/1789150026874-AddAnalysisFirstPdfDownloadedAt';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisService } from '../src/analysis/analysis.service';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { ReportPdfService } from '../src/analysis/report-pdf/report-pdf.service';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('MEASUREMENT GAP P1-04 — migración 1789150026874 sobre Analysis preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'pdf_downloaded_p1_04_migration',
    );
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [User, Field, FieldLot, Analysis],
      synchronize: true, // esquema completo desde las entidades reales (ya incluyen firstPdfDownloadedAt).
    });
    await dataSource.initialize();

    // Simula el esquema "de antes del rollout": la única diferencia real es esta columna — se
    // elimina manualmente para que la migración de abajo tenga algo genuino que agregar.
    await dataSource.query(
      `ALTER TABLE "analysis" DROP COLUMN "firstPdfDownloadedAt"`,
    );
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
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

  it('up() agrega la columna sin tocar filas preexistentes (quedan NULL); down() la elimina sin tocar nada más', async () => {
    const ds = dataSource as DataSource;

    const [user] = await ds.query(
      `INSERT INTO "users" ("email", "passwordHash", "fullName") VALUES ($1, $2, $3) RETURNING "id"`,
      ['gap-p1-04-user@example.com', 'hash-no-usado', 'Usuario preexistente'],
    );
    const [field] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "totalAreaHa", "startDate", "endDate")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
      [user.id, 'Campo preexistente', 10, '2026-01-01', '2026-12-31'],
    );

    // Analysis preexistente al rollout — sembrado DIRECTO por SQL, sin la columna nueva todavía
    // (el esquema en este punto no la tiene, ver beforeAll). scope='field' + status='Finalizado'
    // no importan para esta migración en sí, pero mantienen la fila representativa de un
    // Analysis real.
    const [preexistingAnalysis] = await ds.query(
      `INSERT INTO "analysis" ("fieldId", "scope", "lotName", "status", "startDate", "endDate")
       VALUES ($1, 'field', $2, 'Finalizado', $3, $4)
       RETURNING "id"`,
      [field.id, 'Campo completo', '2026-01-01', '2026-01-08'],
    );

    const migration = new AddAnalysisFirstPdfDownloadedAt1789150026874();
    const queryRunner = ds.createQueryRunner();

    try {
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    const [afterUp] = await ds.query(
      `SELECT "firstPdfDownloadedAt", "status", "lotName" FROM "analysis" WHERE "id" = $1`,
      [preexistingAnalysis.id],
    );
    expect(afterUp.firstPdfDownloadedAt).toBeNull(); // preexistente: sin cobertura histórica conocida.
    expect(afterUp.status).toBe('Finalizado'); // ninguna otra columna se tocó.
    expect(afterUp.lotName).toBe('Campo completo');

    // Columna aceptando escritura real para filas NUEVAS.
    await ds.query(
      `UPDATE "analysis" SET "firstPdfDownloadedAt" = now() WHERE "id" = $1`,
      [preexistingAnalysis.id],
    );
    const [afterWrite] = await ds.query(
      `SELECT "firstPdfDownloadedAt" FROM "analysis" WHERE "id" = $1`,
      [preexistingAnalysis.id],
    );
    expect(afterWrite.firstPdfDownloadedAt).not.toBeNull();

    const queryRunnerDown = ds.createQueryRunner();
    try {
      await migration.down(queryRunnerDown);
    } finally {
      await queryRunnerDown.release();
    }

    const columns: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'analysis'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain(
      'firstPdfDownloadedAt',
    );

    // down() no borró la fila ni ninguna otra columna — solo la nueva.
    const [afterDown] = await ds.query(
      `SELECT "status", "lotName" FROM "analysis" WHERE "id" = $1`,
      [preexistingAnalysis.id],
    );
    expect(afterDown.status).toBe('Finalizado');
    expect(afterDown.lotName).toBe('Campo completo');
  });
});

describe('MEASUREMENT GAP P1-04 — markPdfDownloaded set-once real (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let service: AnalysisService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let analysisRepo: Repository<Analysis>;
  let dataSource: DataSource;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'pdf_downloaded_p1_04_service',
    );
    createdDatabaseName = created.name;

    moduleRef = await Test.createTestingModule({
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
      ],
      providers: [
        AnalysisService,
        FieldsService,
        { provide: PythonWorkerService, useValue: {} },
        { provide: ReportPdfService, useValue: {} },
        {
          provide: AnalysisVerdictService,
          useValue: {
            findResponseByAnalysisId: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(AnalysisService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    analysisRepo = moduleRef.get(getRepositoryToken(Analysis));
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (moduleRef) {
      try {
        await moduleRef.close();
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

  async function seedUserAndField(): Promise<{ user: User; field: Field }> {
    seedCounter += 1;
    const user = await userRepo.save(
      userRepo.create({
        email: `pdf-downloaded-user-${seedCounter}-${Date.now()}@example.com`,
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

  async function seedAnalysis(
    field: Field,
    overrides: Partial<Analysis> = {},
  ): Promise<Analysis> {
    return analysisRepo.save(
      analysisRepo.create({
        fieldId: field.id,
        scope: 'field',
        lotName: 'Campo completo',
        status: 'Finalizado',
        startDate: '2026-01-01',
        endDate: '2026-01-08',
        ...overrides,
      }),
    );
  }

  it('CONCURRENCIA REAL — dos llamadas concurrentes a markPdfDownloaded sobre el mismo Analysis dejan EXACTAMENTE un timestamp', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    await expect(
      Promise.all([
        service.markPdfDownloaded(analysis.id),
        service.markPdfDownloaded(analysis.id),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstPdfDownloadedAt).not.toBeNull();
  });

  it('reutilización secuencial: la segunda llamada no reescribe el timestamp original', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    await service.markPdfDownloaded(analysis.id);
    const afterFirst = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    const originalTimestamp = afterFirst.firstPdfDownloadedAt;
    expect(originalTimestamp).not.toBeNull();

    await service.markPdfDownloaded(analysis.id); // "descarga" posterior.

    const afterSecond = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(afterSecond.firstPdfDownloadedAt!.toISOString()).toBe(
      originalTimestamp!.toISOString(),
    );
  });

  it('usa el timestamp del SERVIDOR (now() de Postgres) — el valor persistido cae dentro de una ventana real alrededor de la llamada', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    // Mismo bracket "antes/después" DENTRO de Postgres que analysis-result-viewed.e2e-spec.ts —
    // nunca Date.now() de Node comparado directo contra una columna timestamp (desfasaje de
    // interpretación de timezone del driver, ver el comentario completo en ese archivo).
    const [{ n: beforeRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const before = beforeRaw.getTime();

    await service.markPdfDownloaded(analysis.id);

    const [{ n: afterRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const after = afterRaw.getTime();

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    const downloadedAtMs = persisted.firstPdfDownloadedAt!.getTime();
    expect(downloadedAtMs).toBeGreaterThanOrEqual(before);
    expect(downloadedAtMs).toBeLessThanOrEqual(after);
  });

  it('FRONTERA DELIBERADA: un id inexistente resuelve sin error (0 filas afectadas, nunca una excepción) — no hay ownership que validar en este método', async () => {
    await expect(
      service.markPdfDownloaded('00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });
});
