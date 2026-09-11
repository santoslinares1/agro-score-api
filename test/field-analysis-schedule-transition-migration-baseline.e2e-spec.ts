// Gap P0 (auditoría de KPIs — "denominador histórico de campos esperados"): backfill de baseline
// de la migración 1789129703443-CreateFieldAnalysisScheduleStatusTransitions contra schedules
// PREEXISTENTES reales, en una base PostgreSQL aislada y desechable creada por esta misma
// ejecución (nunca `agro_score` ni las variables DB_* generales del backend — ver
// test/support/isolated-postgres-database.ts). Mismo patrón que
// test/analysis-dedup-migration.e2e-spec.ts: `synchronize: true` arma el esquema "de antes del
// rollout" (todo excepto la tabla nueva) a partir de las entidades reales, se seedean filas
// preexistentes directamente por SQL (nunca a través del servicio — el servicio no existía para
// estos schedules antes del rollout), y recién ahí se invoca la migración REAL (`.up`/`.down`)
// contra esos datos.
import { DataSource } from 'typeorm';

import { CreateFieldAnalysisScheduleStatusTransitions1789129703443 } from '../src/migrations/1789129703443-CreateFieldAnalysisScheduleStatusTransitions';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('Gap P0 — baseline de migración 1789129703443 sobre schedules preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'gap_p0_migration_baseline');
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [User, Field, FieldLot, Analysis, FieldAnalysisSchedule],
      // Esquema "de antes del rollout": todo lo que la migración da por existente
      // (field_analysis_schedules incluido), pero SIN field_analysis_schedule_status_transitions
      // todavía — esa es, a propósito, la única tabla que esta suite deja en manos de la migración
      // real de abajo, nunca de `synchronize`.
      synchronize: true,
    });
    await dataSource.initialize();
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

  it('crea la tabla/índices/FKs, y la baseline cubre CADA schedule preexistente con source=migration_baseline, actorUserId NULL y effectiveAt del rollout (nunca el createdAt original del schedule); el down elimina solo lo introducido', async () => {
    const ds = dataSource as DataSource;

    // --- Seed DIRECTO por SQL de datos "preexistentes al rollout" — nunca vía el servicio, que
    // para estos schedules no corrió nunca (por eso no hay historial previo que reconstruir). ---
    const [user] = await ds.query(
      `INSERT INTO "users" ("email", "passwordHash", "fullName") VALUES ($1, $2, $3) RETURNING "id"`,
      ['gap-p0-baseline-user@example.com', 'hash-no-usado', 'Usuario preexistente'],
    );

    const [fieldEnabled] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "totalAreaHa", "startDate", "endDate")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
      [user.id, 'Campo habilitado preexistente', 10, '2026-01-01', '2026-12-31'],
    );
    const [fieldDisabled] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "totalAreaHa", "startDate", "endDate")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
      [user.id, 'Campo deshabilitado preexistente', 10, '2026-01-01', '2026-12-31'],
    );

    // createdAt deliberadamente MUY anterior al rollout — la aserción de abajo prueba que
    // `effectiveAt` de la baseline NUNCA reutiliza este valor (afirmaría, sin evidencia, que el
    // estado actual rigió desde la creación).
    const longAgoCreatedAt = '2020-01-01T00:00:00.000Z';
    const [scheduleEnabled] = await ds.query(
      `INSERT INTO "field_analysis_schedules" ("fieldId", "userId", "enabled", "createdAt", "updatedAt")
       VALUES ($1, $2, true, $3, $3) RETURNING "id"`,
      [fieldEnabled.id, user.id, longAgoCreatedAt],
    );
    const [scheduleDisabled] = await ds.query(
      `INSERT INTO "field_analysis_schedules" ("fieldId", "userId", "enabled", "createdAt", "updatedAt")
       VALUES ($1, $2, false, $3, $3) RETURNING "id"`,
      [fieldDisabled.id, user.id, longAgoCreatedAt],
    );

    // Bracket de "antes/después" tomado DENTRO de Postgres, con el mismo cast a `timestamp` (sin
    // zona) que usa la columna `effectiveAt` — nunca `Date.now()` de Node comparado directo contra
    // un valor leído de una columna `timestamp`: node-postgres parsea "timestamp without time
    // zone" con los componentes de reloj LOCALES del proceso (no UTC), así que comparar eso contra
    // un epoch UTC de Node introduciría un desfasaje constante (el offset horario local) que no
    // tiene nada que ver con la corrección real de la migración. Usando el mismo round-trip para
    // los tres valores, cualquier desfasaje de interpretación se cancela igual en los tres.
    const [{ n: beforeRolloutRaw }]: Array<{ n: Date }> = await ds.query('SELECT now()::timestamp AS n');
    const beforeRollout = beforeRolloutRaw.getTime();

    // --- Corre la migración REAL (nunca contra una base real: esta es la base aislada de esta
    // ejecución) ---
    const queryRunner = ds.createQueryRunner();
    await queryRunner.connect();
    await new CreateFieldAnalysisScheduleStatusTransitions1789129703443().up(queryRunner);
    await queryRunner.release();

    const [{ n: afterRolloutRaw }]: Array<{ n: Date }> = await ds.query('SELECT now()::timestamp AS n');
    const afterRollout = afterRolloutRaw.getTime();

    const transitions: Array<{
      scheduleId: string;
      fieldId: string;
      enabled: boolean;
      effectiveAt: Date;
      source: string;
      actorUserId: string | null;
    }> = await ds.query(
      `SELECT "scheduleId", "fieldId", "enabled", "effectiveAt", "source", "actorUserId"
       FROM "field_analysis_schedule_status_transitions"
       ORDER BY "scheduleId"`,
    );

    // Exactamente una fila por schedule preexistente — ni cero, ni una fabricada de más.
    expect(transitions).toHaveLength(2);

    const byScheduleId = new Map(transitions.map((t) => [t.scheduleId, t]));
    const forEnabled = byScheduleId.get(scheduleEnabled.id);
    const forDisabled = byScheduleId.get(scheduleDisabled.id);

    const cases: Array<[typeof forEnabled, boolean, string]> = [
      [forEnabled, true, fieldEnabled.id],
      [forDisabled, false, fieldDisabled.id],
    ];

    for (const [row, expectedEnabled, expectedFieldId] of cases) {
      if (!row) {
        throw new Error('La baseline no generó fila para un schedule preexistente.');
      }

      expect(row.enabled).toBe(expectedEnabled);
      expect(row.fieldId).toBe(expectedFieldId);
      // Fuente inequívoca: nunca 'schedule_upsert' — esta fila jamás pasó por
      // FieldAnalysisScheduleService.upsert.
      expect(row.source).toBe('migration_baseline');
      // Sin actor humano: atribuirla a alguien fabricaría historia inexistente.
      expect(row.actorUserId).toBeNull();

      const effectiveAtMs = new Date(row.effectiveAt).getTime();
      // NUNCA el createdAt original (2020) — la baseline no afirma que el estado actual rigiera
      // desde la creación del schedule.
      expect(effectiveAtMs).not.toBe(new Date(longAgoCreatedAt).getTime());
      // Sí el momento del rollout (esta corrida de la migración), con margen de reloj generoso.
      expect(effectiveAtMs).toBeGreaterThanOrEqual(beforeRollout - 5_000);
      expect(effectiveAtMs).toBeLessThanOrEqual(afterRollout + 5_000);
    }

    // --- down(): elimina SOLO lo que esta migración introdujo — field_analysis_schedules y sus
    // filas quedan absolutamente intactos. ---
    const beforeDownSchedules = await ds.query(`SELECT "id", "enabled" FROM "field_analysis_schedules" ORDER BY "id"`);

    const downQueryRunner = ds.createQueryRunner();
    await downQueryRunner.connect();
    await new CreateFieldAnalysisScheduleStatusTransitions1789129703443().down(downQueryRunner);
    await downQueryRunner.release();

    const tableStillExists = await ds.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'field_analysis_schedule_status_transitions'`,
    );
    expect(tableStillExists).toHaveLength(0);

    const afterDownSchedules = await ds.query(`SELECT "id", "enabled" FROM "field_analysis_schedules" ORDER BY "id"`);
    expect(afterDownSchedules).toEqual(beforeDownSchedules); // ni una fila tocada, ni un enabled reinterpretado.
  });
});
