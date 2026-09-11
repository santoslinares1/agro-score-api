// MEASUREMENT GAP P1-02 ("Cobertura completa lote × índice"): snapshot histórico de
// WeeklyFieldReport.expectedLotIds — contra PostgreSQL real, en una base aislada y desechable
// creada por esta misma ejecución (nunca `agro_score` ni las variables DB_* generales del
// backend, ver test/support/isolated-postgres-database.ts).
//
// Dos bloques:
// 1. La migración 1789140136424 en sí — mismo patrón que
//    test/field-analysis-schedule-transition-migration-baseline.e2e-spec.ts: `synchronize: true`
//    arma el esquema completo desde las entidades reales (que YA incluyen `expectedLotIds`, a
//    diferencia del caso de esa migración anterior no hay tabla nueva que dejarle a la migración
//    entera) y luego se elimina manualmente la columna nueva para simular el esquema "de antes
//    del rollout", se siembra un reporte preexistente DIRECTO por SQL (nunca vía el servicio —
//    para ese reporte, el servicio nunca corrió con esta columna), y recién ahí se invoca la
//    migración real (`.up()`/`.down()`) contra esos datos.
// 2. WeeklyReportsService.create() en sí — contra Postgres real, para demostrar que el snapshot
//    persistido sobrevive genuinamente a la eliminación física de un FieldLot (GEOMETRY-1) después
//    de creado el reporte, algo que un mock no puede demostrar con la misma fuerza (no hay ON
//    DELETE que reconstruir: expectedLotIds no tiene FK por elemento, a propósito).
//
// PythonWorkerService se stubea (dependencia externa) — lo que se quiere probar acá es
// persistencia, no el pipeline del Worker en sí.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { AddWeeklyFieldReportExpectedLotIds1789140136424 } from '../src/migrations/1789140136424-AddWeeklyFieldReportExpectedLotIds';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { WeeklyReportWorkerResult } from '../src/python-worker/types';
import { User } from '../src/users/user.entity';
import { WeeklyFieldReport } from '../src/weekly-reports/entities/weekly-field-report.entity';
import { WeeklyLotIndexObservation } from '../src/weekly-reports/entities/weekly-lot-index-observation.entity';
import { WeeklyReportsService } from '../src/weekly-reports/weekly-reports.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('MEASUREMENT GAP P1-02 — migración 1789140136424 sobre reportes preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'gap_p1_02_migration',
    );
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [
        User,
        Field,
        FieldLot,
        WeeklyFieldReport,
        WeeklyLotIndexObservation,
      ],
      synchronize: true, // esquema completo desde las entidades reales (ya incluyen expectedLotIds).
    });
    await dataSource.initialize();

    // Simula el esquema "de antes del rollout": la única diferencia real es esta columna — se
    // elimina manualmente para que la migración de abajo tenga algo genuino que agregar.
    await dataSource.query(
      `ALTER TABLE "weekly_field_reports" DROP COLUMN "expectedLotIds"`,
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
        'Fallo(s) durante la limpieza de recursos de esta suite — ver causas.',
      );
    }
  });

  it('up() agrega la columna sin tocar filas preexistentes (quedan NULL); down() la elimina sin tocar nada más', async () => {
    const ds = dataSource as DataSource;

    const [user] = await ds.query(
      `INSERT INTO "users" ("email", "passwordHash", "fullName") VALUES ($1, $2, $3) RETURNING "id"`,
      ['gap-p1-02-user@example.com', 'hash-no-usado', 'Usuario preexistente'],
    );
    const [field] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "totalAreaHa", "startDate", "endDate")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
      [user.id, 'Campo preexistente', 10, '2026-01-01', '2026-12-31'],
    );

    // Reporte preexistente al rollout — sembrado DIRECTO por SQL, sin la columna nueva todavía
    // (el esquema en este punto no la tiene, ver beforeAll).
    const [preexistingReport] = await ds.query(
      `INSERT INTO "weekly_field_reports"
         ("fieldId", "userId", "campaignStart", "targetDate", "weekAnchorDate", "methodologyVersion",
          "status", "source", "indices")
       VALUES ($1, $2, $3, $3, $3, 'weekly-v1', 'completed', 'manual', $4::jsonb)
       RETURNING "id"`,
      [field.id, user.id, '2026-01-05', JSON.stringify(['NDVI'])],
    );

    const migration = new AddWeeklyFieldReportExpectedLotIds1789140136424();
    const queryRunner = ds.createQueryRunner();

    try {
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    const [afterUp] = await ds.query(
      `SELECT "expectedLotIds", "indices", "status" FROM "weekly_field_reports" WHERE "id" = $1`,
      [preexistingReport.id],
    );
    expect(afterUp.expectedLotIds).toBeNull(); // preexistente: sin cobertura histórica conocida.
    expect(afterUp.indices).toEqual(['NDVI']); // ninguna otra columna se tocó.
    expect(afterUp.status).toBe('completed');

    // Columna aceptando escritura real para filas NUEVAS.
    await ds.query(
      `UPDATE "weekly_field_reports" SET "expectedLotIds" = $1::jsonb WHERE "id" = $2`,
      [JSON.stringify(['lot-x', 'lot-y']), preexistingReport.id],
    );
    const [afterWrite] = await ds.query(
      `SELECT "expectedLotIds" FROM "weekly_field_reports" WHERE "id" = $1`,
      [preexistingReport.id],
    );
    expect(afterWrite.expectedLotIds).toEqual(['lot-x', 'lot-y']);

    const queryRunnerDown = ds.createQueryRunner();
    try {
      await migration.down(queryRunnerDown);
    } finally {
      await queryRunnerDown.release();
    }

    const columns: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'weekly_field_reports'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('expectedLotIds');

    // down() no borró la fila ni ninguna otra columna — solo la nueva.
    const [afterDown] = await ds.query(
      `SELECT "indices", "status" FROM "weekly_field_reports" WHERE "id" = $1`,
      [preexistingReport.id],
    );
    expect(afterDown.indices).toEqual(['NDVI']);
    expect(afterDown.status).toBe('completed');
  });
});

describe('MEASUREMENT GAP P1-02 — WeeklyReportsService.create() persiste expectedLotIds real (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let service: WeeklyReportsService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let fieldLotRepo: Repository<FieldLot>;
  let reportRepo: Repository<WeeklyFieldReport>;
  let pythonWorkerService: jest.Mocked<
    Pick<PythonWorkerService, 'runWeeklyReport'>
  >;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'gap_p1_02_service',
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
          entities: [
            User,
            Field,
            FieldLot,
            WeeklyFieldReport,
            WeeklyLotIndexObservation,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          User,
          Field,
          FieldLot,
          WeeklyFieldReport,
          WeeklyLotIndexObservation,
        ]),
      ],
      providers: [
        WeeklyReportsService,
        FieldsService, // real: la resolución de field.lots (relación real) es justamente lo que se quiere probar.
        {
          provide: PythonWorkerService,
          // Nunca se le pide que resuelva de verdad — cada test que la necesita pisa el mock.
          useValue: { runWeeklyReport: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(WeeklyReportsService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    fieldLotRepo = moduleRef.get(getRepositoryToken(FieldLot));
    reportRepo = moduleRef.get(getRepositoryToken(WeeklyFieldReport));
    pythonWorkerService = moduleRef.get(PythonWorkerService);
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

  async function seedUserAndField(
    lots: Array<{ includeInProductivityClassification: boolean }>,
  ): Promise<{ user: User; field: Field; lots: FieldLot[] }> {
    seedCounter += 1;
    const user = await userRepo.save(
      userRepo.create({
        email: `gap-p1-02-user-${seedCounter}-${Date.now()}@example.com`,
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
    const savedLots: FieldLot[] = [];
    for (let i = 0; i < lots.length; i += 1) {
      const saved = await fieldLotRepo.save(
        fieldLotRepo.create({
          fieldId: field.id,
          name: `Lote ${i + 1}`,
          geojson: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [1, 0],
                [0, 0],
              ],
            ],
          },
          areaHa: 5,
          displayOrder: i,
          includeInProductivityClassification:
            lots[i].includeInProductivityClassification,
        }),
      );
      savedLots.push(saved);
    }
    return { user, field, lots: savedLots };
  }

  /**
   * `create()` dispara `processInBackground` fire-and-forget (mismo patrón que
   * AnalysisService.runFieldAnalysis) — esperar un tick fijo (setImmediate) para que termine es
   * intrínsecamente frágil contra Postgres real (persistResult hace varios round-trips reales
   * antes de resolver), y se demostró flaky en la práctica. En vez de adivinar cuántos ticks
   * hacen falta, se espía `processInBackground` (jest.spyOn conserva la implementación real por
   * default) para capturar y esperar la MISMA promesa que `create()` deja correr en segundo
   * plano, de forma determinística.
   */
  async function createAndWaitForBackground(
    fieldId: string,
    dto: { campaignStart: string; targetDate: string },
    userId: string,
  ): Promise<WeeklyFieldReport> {
    const spy = jest.spyOn(service as any, 'processInBackground');
    const report = await service.create(fieldId, dto, userId);
    await spy.mock.results[spy.mock.results.length - 1].value;
    spy.mockRestore();
    return report;
  }

  function workerResult(): WeeklyReportWorkerResult {
    return {
      methodologyVersion: 'weekly-v1',
      campaign: {
        start: '2026-01-01',
        targetDate: '2026-01-08',
        weekAnchorDate: '2026-01-05',
        stepDays: 7,
      },
      indices: ['NDVI'],
      experimentalIndices: [],
      lots: [],
      warnings: [],
    };
  }

  it('persiste expectedLotIds reales y la eliminación posterior del FieldLot (GEOMETRY-1) NO lo altera', async () => {
    const { user, field, lots } = await seedUserAndField([
      { includeInProductivityClassification: true },
      { includeInProductivityClassification: true },
    ]);
    pythonWorkerService.runWeeklyReport.mockResolvedValue(workerResult());

    const report = await createAndWaitForBackground(
      field.id,
      { campaignStart: '2026-01-01', targetDate: '2026-01-08' },
      user.id,
    );

    const expectedIds = lots.map((lot) => lot.id).sort();
    const persisted = await reportRepo.findOneOrFail({
      where: { id: report.id },
    });
    expect([...persisted.expectedLotIds!].sort()).toEqual(expectedIds);

    // GEOMETRY-1: borrado físico real de uno de los lotes — sin FK desde expectedLotIds, no debe
    // pasar nada con el snapshot ya persistido.
    await fieldLotRepo.delete(lots[0].id);

    const afterDelete = await reportRepo.findOneOrFail({
      where: { id: report.id },
    });
    expect([...afterDelete.expectedLotIds!].sort()).toEqual(expectedIds); // intacto.
  });

  it('lotes excluidos de la clasificación productiva no entran a expectedLotIds', async () => {
    const { user, field, lots } = await seedUserAndField([
      { includeInProductivityClassification: true },
      { includeInProductivityClassification: false },
    ]);
    pythonWorkerService.runWeeklyReport.mockResolvedValue(workerResult());

    const report = await createAndWaitForBackground(
      field.id,
      { campaignStart: '2026-02-01', targetDate: '2026-02-08' },
      user.id,
    );

    const persisted = await reportRepo.findOneOrFail({
      where: { id: report.id },
    });
    expect(persisted.expectedLotIds).toEqual([lots[0].id]);
  });
});
