// MEASUREMENT GAP P1-05 ("Monitoreo semanal consultado"): set-once real de
// WeeklyAnalysisSnapshot.firstViewedAt vía WeeklyAnalysisSnapshotService.markViewed, y la
// migración 1789153704863 en sí — contra PostgreSQL real, en una base aislada y desechable
// creada por esta misma ejecución (nunca `agro_score` ni las variables DB_* generales del
// backend, ver test/support/isolated-postgres-database.ts).
//
// Por qué un test aparte de weekly-analysis-snapshot.service.spec.ts (unitario, con repos
// mockeados): un mock puede demostrar que el service arma el UPDATE con el guard
// `"firstViewedAt" IS NULL`, pero no puede demostrar que Postgres real serializa dos llamadas
// concurrentes disputando esa misma fila y deja EXACTAMENTE un timestamp. FieldsService es real
// (ownership real contra Postgres); WeeklyTechnicalVerdictService no participa de markViewed —
// no se instancia en este archivo salvo lo mínimo para satisfacer el constructor del service.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { AddWeeklyAnalysisSnapshotFirstViewedAt1789153704863 } from '../src/migrations/1789153704863-AddWeeklyAnalysisSnapshotFirstViewedAt';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { ScheduledAnalysisRun } from '../src/scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from '../src/scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { WeeklyAnalysisSnapshotService } from '../src/scheduled-analysis/weekly-analysis-snapshot.service';
import { WeeklyTechnicalVerdictService } from '../src/weekly-technical-verdict/weekly-technical-verdict.service';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('MEASUREMENT GAP P1-05 — migración 1789153704863 sobre WeeklyAnalysisSnapshot preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'snapshot_viewed_p1_05_migration',
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
        Analysis,
        FieldAnalysisSchedule,
        ScheduledAnalysisRun,
        WeeklyAnalysisSnapshot,
      ],
      synchronize: true, // esquema completo desde las entidades reales (ya incluyen firstViewedAt).
    });
    await dataSource.initialize();

    // Simula el esquema "de antes del rollout": la única diferencia real es esta columna — se
    // elimina manualmente para que la migración de abajo tenga algo genuino que agregar.
    await dataSource.query(
      `ALTER TABLE "weekly_analysis_snapshots" DROP COLUMN "firstViewedAt"`,
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
      ['gap-p1-05-user@example.com', 'hash-no-usado', 'Usuario preexistente'],
    );
    const [field] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "totalAreaHa", "startDate", "endDate")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
      [user.id, 'Campo preexistente', 10, '2026-01-01', '2026-12-31'],
    );

    // Snapshot preexistente al rollout — sembrado DIRECTO por SQL, sin la columna nueva todavía
    // (el esquema en este punto no la tiene, ver beforeAll).
    const [preexistingSnapshot] = await ds.query(
      `INSERT INTO "weekly_analysis_snapshots"
         ("fieldId", "userId", "weekStart", "weekEnd", "score", "dataQualityStatus")
       VALUES ($1, $2, $3, $4, $5, 'sufficient')
       RETURNING "id"`,
      [field.id, user.id, '2026-01-01', '2026-01-08', 78],
    );

    const migration = new AddWeeklyAnalysisSnapshotFirstViewedAt1789153704863();
    const queryRunner = ds.createQueryRunner();

    try {
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    const [afterUp] = await ds.query(
      `SELECT "firstViewedAt", "score", "dataQualityStatus" FROM "weekly_analysis_snapshots" WHERE "id" = $1`,
      [preexistingSnapshot.id],
    );
    expect(afterUp.firstViewedAt).toBeNull(); // preexistente: sin cobertura histórica conocida.
    expect(afterUp.score).toBe(78); // ninguna otra columna se tocó.
    expect(afterUp.dataQualityStatus).toBe('sufficient');

    // Columna aceptando escritura real para filas NUEVAS.
    await ds.query(
      `UPDATE "weekly_analysis_snapshots" SET "firstViewedAt" = now() WHERE "id" = $1`,
      [preexistingSnapshot.id],
    );
    const [afterWrite] = await ds.query(
      `SELECT "firstViewedAt" FROM "weekly_analysis_snapshots" WHERE "id" = $1`,
      [preexistingSnapshot.id],
    );
    expect(afterWrite.firstViewedAt).not.toBeNull();

    const queryRunnerDown = ds.createQueryRunner();
    try {
      await migration.down(queryRunnerDown);
    } finally {
      await queryRunnerDown.release();
    }

    const columns: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'weekly_analysis_snapshots'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('firstViewedAt');

    // down() no borró la fila ni ninguna otra columna — solo la nueva.
    const [afterDown] = await ds.query(
      `SELECT "score", "dataQualityStatus" FROM "weekly_analysis_snapshots" WHERE "id" = $1`,
      [preexistingSnapshot.id],
    );
    expect(afterDown.score).toBe(78);
    expect(afterDown.dataQualityStatus).toBe('sufficient');
  });
});

describe('MEASUREMENT GAP P1-05 — markViewed set-once real (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let service: WeeklyAnalysisSnapshotService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let snapshotRepo: Repository<WeeklyAnalysisSnapshot>;
  let dataSource: DataSource;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'snapshot_viewed_p1_05_service',
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
            Analysis,
            FieldAnalysisSchedule,
            ScheduledAnalysisRun,
            WeeklyAnalysisSnapshot,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          User,
          Field,
          FieldLot,
          Analysis,
          ScheduledAnalysisRun,
          WeeklyAnalysisSnapshot,
        ]),
      ],
      providers: [
        WeeklyAnalysisSnapshotService,
        FieldsService, // real — ownership real es justo lo que se quiere probar.
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: {
            findResponseBySnapshotId: jest.fn().mockResolvedValue(null),
            findResponsesBySnapshotIds: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(WeeklyAnalysisSnapshotService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    snapshotRepo = moduleRef.get(getRepositoryToken(WeeklyAnalysisSnapshot));
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
        email: `snapshot-viewed-user-${seedCounter}-${Date.now()}@example.com`,
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

  async function seedSnapshot(field: Field): Promise<WeeklyAnalysisSnapshot> {
    seedCounter += 1;
    return snapshotRepo.save(
      snapshotRepo.create({
        fieldId: field.id,
        userId: field.userId,
        weekStart: '2026-01-01',
        weekEnd: '2026-01-08',
        score: 78,
        dataQualityStatus: 'sufficient',
      }),
    );
  }

  it('CONCURRENCIA REAL — dos llamadas concurrentes a markViewed sobre el mismo snapshot dejan EXACTAMENTE un timestamp, ambas responden éxito con el mismo valor', async () => {
    const { user, field } = await seedUserAndField();
    const snapshot = await seedSnapshot(field);

    const [resultA, resultB] = await Promise.all([
      service.markViewed(field.id, snapshot.id, user.id),
      service.markViewed(field.id, snapshot.id, user.id),
    ]);

    expect(resultA.firstViewedAt).toBe(resultB.firstViewedAt); // mismo valor para ambas.

    const persisted = await snapshotRepo.findOneOrFail({
      where: { id: snapshot.id },
    });
    expect(persisted.firstViewedAt).not.toBeNull();
    expect(persisted.firstViewedAt!.toISOString()).toBe(resultA.firstViewedAt);
  });

  it('reutilización secuencial: la segunda llamada responde éxito y conserva el timestamp original, sin reescribirlo', async () => {
    const { user, field } = await seedUserAndField();
    const snapshot = await seedSnapshot(field);

    const first = await service.markViewed(field.id, snapshot.id, user.id);
    const second = await service.markViewed(field.id, snapshot.id, user.id);

    expect(second.firstViewedAt).toBe(first.firstViewedAt);
  });

  it('usa el timestamp del SERVIDOR (now() de Postgres) — el valor persistido cae dentro de una ventana real alrededor de la llamada, nunca un valor arbitrario', async () => {
    const { user, field } = await seedUserAndField();
    const snapshot = await seedSnapshot(field);

    // Bracket de "antes/después" tomado DENTRO de Postgres, con el mismo cast a `timestamp` (sin
    // zona) que usa la columna — nunca `Date.now()` de Node comparado directo contra un valor
    // leído de una columna `timestamp` (mismo hallazgo de node-postgres/timezone ya documentado
    // en analysis-result-viewed.e2e-spec.ts).
    const [{ n: beforeRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const before = beforeRaw.getTime();

    const result = await service.markViewed(field.id, snapshot.id, user.id);

    const [{ n: afterRaw }]: Array<{ n: Date }> = await dataSource.query(
      'SELECT now()::timestamp AS n',
    );
    const after = afterRaw.getTime();

    const viewedAtMs = new Date(result.firstViewedAt).getTime();
    expect(viewedAtMs).toBeGreaterThanOrEqual(before);
    expect(viewedAtMs).toBeLessThanOrEqual(after);
  });

  it('NEGATIVO: snapshot ajeno (Field de otro usuario) sigue la semántica 404 real de findOne, sin escribir', async () => {
    const { field } = await seedUserAndField();
    const snapshot = await seedSnapshot(field);
    const other = await seedUserAndField(); // otro usuario, otro field.

    await expect(
      service.markViewed(field.id, snapshot.id, other.user.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const persisted = await snapshotRepo.findOneOrFail({
      where: { id: snapshot.id },
    });
    expect(persisted.firstViewedAt).toBeNull();
  });

  it('NEGATIVO: snapshotId pertenece a otro fieldId — 404 real, sin escribir', async () => {
    const { user, field } = await seedUserAndField();
    const other = await seedUserAndField();
    const foreignSnapshot = await seedSnapshot(other.field); // snapshot de OTRO field.

    await expect(
      service.markViewed(field.id, foreignSnapshot.id, user.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    const persisted = await snapshotRepo.findOneOrFail({
      where: { id: foreignSnapshot.id },
    });
    expect(persisted.firstViewedAt).toBeNull();
  });

  it('NEGATIVO: snapshot inexistente devuelve 404 real', async () => {
    const { user, field } = await seedUserAndField();

    await expect(
      service.markViewed(
        field.id,
        '00000000-0000-0000-0000-000000000000',
        user.id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ninguna otra columna del snapshot cambia como efecto de markViewed', async () => {
    const { user, field } = await seedUserAndField();
    const snapshot = await seedSnapshot(field);

    await service.markViewed(field.id, snapshot.id, user.id);

    const persisted = await snapshotRepo.findOneOrFail({
      where: { id: snapshot.id },
    });
    expect(persisted.score).toBe(78);
    expect(persisted.dataQualityStatus).toBe('sufficient');
    expect(persisted.weekStart).toBe('2026-01-01');
    expect(persisted.weekEnd).toBe('2026-01-08');
  });
});
