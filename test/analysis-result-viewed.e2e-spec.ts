// MEASUREMENT GAP P1-03 ("Resultado técnico consultado"): set-once real de
// Analysis.firstResultViewedAt vía AnalysisService.markResultViewed — contra PostgreSQL real, en
// una base aislada y desechable creada por esta misma ejecución (nunca `agro_score` ni las
// variables DB_* generales del backend, ver test/support/isolated-postgres-database.ts).
//
// Por qué un test aparte de analysis.service.spec.ts (unitario, con repos mockeados): un mock
// puede demostrar que el service arma el UPDATE con el guard `"firstResultViewedAt" IS NULL`,
// pero no puede demostrar que Postgres real serializa dos llamadas concurrentes disputando esa
// misma fila y deja EXACTAMENTE un timestamp, nunca dos escrituras ni una condición de carrera
// real. FieldsService es real (ownership real contra Postgres); PythonWorkerService/
// ReportPdfService/AnalysisVerdictService se stubean — no son parte de lo que se prueba acá.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

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

describe('MEASUREMENT GAP P1-03 — markResultViewed set-once real (PostgreSQL real, base aislada por ejecución)', () => {
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
      'result_viewed_p1_03',
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
          synchronize: true, // esquema desde las entidades reales — el mismo shape que produce la migración.
        }),
        TypeOrmModule.forFeature([User, Field, FieldLot, Analysis]),
      ],
      providers: [
        AnalysisService,
        FieldsService, // real: ownership real es justo lo que se quiere probar (findOneOwned).
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
        email: `result-viewed-user-${seedCounter}-${Date.now()}@example.com`,
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

  it('CONCURRENCIA REAL — dos llamadas concurrentes a markResultViewed sobre el mismo Analysis dejan EXACTAMENTE un timestamp, ambas responden éxito con el mismo valor', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    const [resultA, resultB] = await Promise.all([
      service.markResultViewed(analysis.id, user.id),
      service.markResultViewed(analysis.id, user.id),
    ]);

    expect(resultA.firstResultViewedAt).toBe(resultB.firstResultViewedAt); // mismo valor para ambas.

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstResultViewedAt).not.toBeNull();
    expect(persisted.firstResultViewedAt!.toISOString()).toBe(
      resultA.firstResultViewedAt,
    );
  });

  it('reutilización secuencial: la segunda llamada responde éxito y conserva el timestamp original, sin reescribirlo', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    const first = await service.markResultViewed(analysis.id, user.id);
    // Segunda llamada, algo después — si reescribiera, el timestamp cambiaría.
    const second = await service.markResultViewed(analysis.id, user.id);

    expect(second.firstResultViewedAt).toBe(first.firstResultViewedAt);
  });

  it('usa el timestamp del SERVIDOR (now() de Postgres) — el valor persistido cae dentro de una ventana real alrededor de la llamada, nunca un valor arbitrario', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);

    // Bracket de "antes/después" tomado DENTRO de Postgres, con el mismo cast a `timestamp` (sin
    // zona) que usa la columna — nunca `Date.now()` de Node comparado directo contra un valor
    // leído de una columna `timestamp`: node-postgres parsea "timestamp without time zone" con
    // los componentes de reloj LOCALES del proceso (no UTC), así que comparar eso contra un epoch
    // UTC de Node introduce un desfasaje constante (el offset horario local, ver el mismo hallazgo
    // en field-analysis-schedule-transition-migration-baseline.e2e-spec.ts) que no tiene nada que
    // ver con la corrección real de markResultViewed. Con el mismo round-trip para los tres
    // valores, cualquier desfasaje de interpretación se cancela igual en los tres.
    const [{ n: beforeRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const before = beforeRaw.getTime();

    const result = await service.markResultViewed(analysis.id, user.id);

    const [{ n: afterRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const after = afterRaw.getTime();

    const viewedAtMs = new Date(result.firstResultViewedAt).getTime();
    expect(viewedAtMs).toBeGreaterThanOrEqual(before);
    expect(viewedAtMs).toBeLessThanOrEqual(after);
  });

  it('NEGATIVO: Procesando no escribe — la columna permanece NULL en la base real', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field, { status: 'Procesando' });

    await expect(
      service.markResultViewed(analysis.id, user.id),
    ).rejects.toBeInstanceOf(BadRequestException);

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstResultViewedAt).toBeNull();
  });

  it('NEGATIVO: Error no escribe', async () => {
    const { user, field } = await seedUserAndField();
    const analysis = await seedAnalysis(field, { status: 'Error' });

    await expect(
      service.markResultViewed(analysis.id, user.id),
    ).rejects.toBeInstanceOf(BadRequestException);

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstResultViewedAt).toBeNull();
  });

  it('NEGATIVO: análisis ajeno (Field de otro usuario) sigue la semántica 404 real de findOneOwned, sin escribir', async () => {
    const { field } = await seedUserAndField();
    const analysis = await seedAnalysis(field);
    const other = await seedUserAndField(); // otro usuario, otro field.

    await expect(
      service.markResultViewed(analysis.id, other.user.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const persisted = await analysisRepo.findOneOrFail({
      where: { id: analysis.id },
    });
    expect(persisted.firstResultViewedAt).toBeNull();
  });

  it('NEGATIVO: análisis inexistente devuelve 404 real', async () => {
    const { user } = await seedUserAndField();

    await expect(
      service.markResultViewed('00000000-0000-0000-0000-000000000000', user.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
