// Gap P0 (auditoría de KPIs — "denominador histórico de campos esperados"): atomicidad,
// concurrencia REAL e idempotencia semántica del historial de transiciones de
// FieldAnalysisSchedule.enabled — contra PostgreSQL real, en una base aislada y desechable creada
// por esta misma ejecución (nunca `agro_score` ni las variables DB_* generales del backend, ver
// test/support/isolated-postgres-database.ts). Mismo criterio que
// test/auth-reset-password-atomicity.e2e-spec.ts.
//
// Por qué un test aparte de field-analysis-schedule.service.spec.ts (unitario, con repos
// mockeados): un mock no puede demostrar que dos transacciones reales compitiendo por la misma
// fila (SELECT ... FOR UPDATE) efectivamente se serializan, ni que un fallo a mitad de transacción
// revierte de verdad una escritura que ya se había ejecutado (no solo "nunca se intentó", que es
// lo único que un mock puede probar). Correr acá, vía `npm run test:e2e` — necesita
// Docker/Postgres corriendo y TEST_DB_* configuradas, cosa que `npm test` no requiere.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { Analysis } from '../src/analysis/entities/analysis.entity';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from '../src/scheduled-analysis/entities/field-analysis-schedule-status-transition.entity';
import { FieldAnalysisScheduleService } from '../src/scheduled-analysis/field-analysis-schedule.service';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('Gap P0 — atomicidad, concurrencia e idempotencia del historial de FieldAnalysisSchedule.enabled (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let scheduleService: FieldAnalysisScheduleService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let scheduleRepo: Repository<FieldAnalysisSchedule>;
  let transitionRepo: Repository<FieldAnalysisScheduleStatusTransition>;
  let dataSource: DataSource;
  let seedCounter = 0;

  beforeAll(async () => {
    // Configuración EXPLÍCITA del destino de test — nunca las DB_* generales del backend.
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'gap_p0_schedule_transitions',
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
          entities: [User, Field, FieldLot, Analysis, FieldAnalysisSchedule, FieldAnalysisScheduleStatusTransition],
          synchronize: true, // esquema desde las entidades reales — el mismo shape que produce la migración.
        }),
        TypeOrmModule.forFeature([
          User,
          Field,
          FieldLot,
          FieldAnalysisSchedule,
          FieldAnalysisScheduleStatusTransition,
        ]),
      ],
      providers: [FieldAnalysisScheduleService, FieldsService],
    }).compile();

    scheduleService = moduleRef.get(FieldAnalysisScheduleService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    scheduleRepo = moduleRef.get(getRepositoryToken(FieldAnalysisSchedule));
    transitionRepo = moduleRef.get(getRepositoryToken(FieldAnalysisScheduleStatusTransition));
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
        'Fallo(s) durante la limpieza de recursos de esta suite — ver causas.',
      );
    }
  });

  /** Cada test crea su propio usuario + campo — nunca comparten fila entre tests. */
  async function seedUserAndField(): Promise<{ user: User; field: Field }> {
    seedCounter += 1;

    const user = await userRepo.save(
      userRepo.create({
        email: `gap-p0-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado-en-este-test',
        fullName: 'Usuario de prueba Gap P0',
      }),
    );

    const field = await fieldRepo.save(
      fieldRepo.create({
        userId: user.id,
        name: `Campo de prueba Gap P0 #${seedCounter}`,
        totalAreaHa: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        lots: [],
      }),
    );

    return { user, field };
  }

  it('CASO 1 — creación habilitada registra exactamente una fila inicial enabled=true', async () => {
    const { user, field } = await seedUserAndField();

    const schedule = await scheduleService.upsert(field.id, { enabled: true }, user.id);

    const transitions = await transitionRepo.find({ where: { scheduleId: schedule.id } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fieldId: field.id,
      enabled: true,
      source: 'schedule_upsert',
      actorUserId: user.id,
    });
  });

  it('CASO 2 — creación deshabilitada también registra exactamente una fila inicial enabled=false', async () => {
    const { user, field } = await seedUserAndField();

    const schedule = await scheduleService.upsert(field.id, { enabled: false }, user.id);

    const transitions = await transitionRepo.find({ where: { scheduleId: schedule.id } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ enabled: false, source: 'schedule_upsert' });
  });

  it('CASO 3 — true→false→true secuencial agrega exactamente dos transiciones adicionales, en el orden correcto', async () => {
    const { user, field } = await seedUserAndField();

    const created = await scheduleService.upsert(field.id, { enabled: true }, user.id);
    await scheduleService.upsert(field.id, { enabled: false }, user.id);
    await scheduleService.upsert(field.id, { enabled: true }, user.id);

    const transitions = await transitionRepo.find({
      where: { scheduleId: created.id },
      order: { effectiveAt: 'ASC' },
    });
    expect(transitions.map((t) => t.enabled)).toEqual([true, false, true]);
  });

  it('CASO 4 — reintento HTTP con el mismo body (o doble click) secuencial no infla el historial', async () => {
    const { user, field } = await seedUserAndField();

    await scheduleService.upsert(field.id, { enabled: true }, user.id);
    const schedule = await scheduleService.upsert(field.id, { enabled: true }, user.id); // idéntico

    const transitions = await transitionRepo.find({ where: { scheduleId: schedule.id } });
    expect(transitions).toHaveLength(1);
  });

  it('CASO 5 — un cambio de horario sin cambio de enabled no agrega fila', async () => {
    const { user, field } = await seedUserAndField();

    const created = await scheduleService.upsert(field.id, { enabled: true, dayOfWeek: 1 }, user.id);
    await scheduleService.upsert(field.id, { dayOfWeek: 3, hour: 14 }, user.id);

    const transitions = await transitionRepo.find({ where: { scheduleId: created.id } });
    expect(transitions).toHaveLength(1);

    const updated = await scheduleRepo.findOneByOrFail({ id: created.id });
    expect(updated.dayOfWeek).toBe(3);
    expect(updated.hour).toBe(14);
    expect(updated.enabled).toBe(true);
  });

  it('CONCURRENCIA REAL — creación concurrente del schedule de un mismo campo (nunca existía antes): exactamente un schedule y una transición inicial, nunca dos', async () => {
    const { user, field } = await seedUserAndField();

    const [outcomeA, outcomeB] = await Promise.allSettled([
      scheduleService.upsert(field.id, { enabled: true }, user.id),
      scheduleService.upsert(field.id, { enabled: true }, user.id),
    ]);

    // El mecanismo de reintento ante unique_violation (ver upsertWithCreateRaceRetry) hace que
    // AMBOS requests terminen resolviendo bien — ninguno debería propagar un 500 al caller.
    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const schedules = await scheduleRepo.find({ where: { fieldId: field.id } });
    expect(schedules).toHaveLength(1); // unique(fieldId) respetado, sin excepción no manejada.

    const transitions = await transitionRepo.find({ where: { scheduleId: schedules[0].id } });
    expect(transitions).toHaveLength(1); // una sola fila inicial, no una por request.
    expect(transitions[0].enabled).toBe(true);
  });

  it('CONCURRENCIA REAL — dos upserts concurrentes pidiendo el MISMO estado ya vigente: cero transiciones adicionales', async () => {
    const { user, field } = await seedUserAndField();
    const created = await scheduleService.upsert(field.id, { enabled: true }, user.id);

    const [outcomeA, outcomeB] = await Promise.allSettled([
      scheduleService.upsert(field.id, { enabled: true }, user.id),
      scheduleService.upsert(field.id, { enabled: true }, user.id),
    ]);

    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const transitions = await transitionRepo.find({ where: { scheduleId: created.id } });
    expect(transitions).toHaveLength(1); // seguía siendo la fila inicial — nadie detectó un cambio real.
  });

  it('CONCURRENCIA REAL — dos upserts concurrentes con estados OPUESTOS sobre el mismo schedule ya existente: se serializan vía SELECT...FOR UPDATE, sin transiciones consecutivas duplicadas y con el estado final coincidiendo con la última transición', async () => {
    const { user, field } = await seedUserAndField();
    const created = await scheduleService.upsert(field.id, { enabled: true }, user.id); // estado inicial: true

    const [outcomeA, outcomeB] = await Promise.allSettled([
      scheduleService.upsert(field.id, { enabled: false }, user.id),
      scheduleService.upsert(field.id, { enabled: true }, user.id),
    ]);

    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    // Orden real, sin depender de qué transacción ganó la carrera: se pide por effectiveAt y,
    // ante empate exacto de timestamp, por createdAt (inserción) como desempate estable.
    const ordered = await transitionRepo
      .createQueryBuilder('t')
      .where('t.scheduleId = :scheduleId', { scheduleId: created.id })
      .orderBy('t.effectiveAt', 'ASC')
      .addOrderBy('t.createdAt', 'ASC')
      .getMany();

    // Invariante independiente del orden real de la carrera: nunca dos transiciones consecutivas
    // con el mismo `enabled` — cada fila representa un cambio REAL respecto de la anterior.
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].enabled).not.toBe(ordered[i - 1].enabled);
    }
    expect(ordered.length).toBeGreaterThanOrEqual(2); // la inicial + al menos un cambio real neto.

    const finalSchedule = await scheduleRepo.findOneByOrFail({ id: created.id });
    expect(finalSchedule.enabled).toBe(ordered[ordered.length - 1].enabled);
  });

  it('NO-SIDE-EFFECT — actualizar lastRunAt/lastStatus/nextRunAt (lo que hace el runner) nunca agrega una transición', async () => {
    const { user, field } = await seedUserAndField();
    const created = await scheduleService.upsert(field.id, { enabled: true }, user.id);

    // Mismo mecanismo EXACTO que usa ScheduledAnalysisRunnerService (Repository<FieldAnalysisSchedule>.update,
    // nunca a través de FieldAnalysisScheduleService.upsert ni de un manager transaccional propio) —
    // ver scheduled-analysis-runner.service.ts. El runner nunca toca `enabled`.
    await scheduleRepo.update(created.id, {
      lastRunAt: new Date(),
      lastStatus: 'completed',
      nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const transitions = await transitionRepo.find({ where: { scheduleId: created.id } });
    expect(transitions).toHaveLength(1); // solo la inicial — el runner no escribió `enabled`.
  });

  describe('rollback real ante fallo a mitad de transacción', () => {
    // Envenena field_analysis_schedule_status_transitions: cualquier INSERT cuyo "fieldId" figure
    // en gap_p0_poisoned_field_ids falla. Instalado UNA vez (inocuo mientras la tabla esté vacía);
    // cada test que lo necesita agrega y quita su propio fieldId — nunca afecta a los demás tests
    // de esta suite.
    beforeAll(async () => {
      await dataSource.query(`CREATE TABLE gap_p0_poisoned_field_ids ("fieldId" uuid PRIMARY KEY)`);
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION gap_p0_fail_transition_insert() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM gap_p0_poisoned_field_ids WHERE "fieldId" = NEW."fieldId") THEN
            RAISE EXCEPTION 'gap_p0: fallo forzado por el test (fieldId envenenado)';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await dataSource.query(`
        CREATE TRIGGER gap_p0_fail_transition_insert_trigger
        BEFORE INSERT ON field_analysis_schedule_status_transitions
        FOR EACH ROW EXECUTE FUNCTION gap_p0_fail_transition_insert()
      `);
    });

    afterAll(async () => {
      await dataSource.query(`DROP TRIGGER IF EXISTS gap_p0_fail_transition_insert_trigger ON field_analysis_schedule_status_transitions`);
      await dataSource.query(`DROP FUNCTION IF EXISTS gap_p0_fail_transition_insert()`);
      await dataSource.query(`DROP TABLE IF EXISTS gap_p0_poisoned_field_ids`);
    });

    it('CASO — creación: si la inserción de la transición inicial falla, el schedule recién creado NUNCA queda persistido', async () => {
      const { user, field } = await seedUserAndField();

      await dataSource.query('INSERT INTO gap_p0_poisoned_field_ids VALUES ($1)', [field.id]);
      try {
        await expect(scheduleService.upsert(field.id, { enabled: true }, user.id)).rejects.toThrow(
          /gap_p0: fallo forzado/,
        );
      } finally {
        await dataSource.query('DELETE FROM gap_p0_poisoned_field_ids WHERE "fieldId" = $1', [field.id]);
      }

      const schedules = await scheduleRepo.find({ where: { fieldId: field.id } });
      expect(schedules).toHaveLength(0); // el INSERT del schedule, ya ejecutado, se revirtió junto con la transición.
    });

    it('CASO — update: si la inserción de la transición falla, el UPDATE del schedule (ya ejecutado dentro de la misma transacción) también se revierte, y no queda una transición huérfana', async () => {
      const { user, field } = await seedUserAndField();
      // Se crea SIN el veneno todavía activo, para que la transición inicial se persista normal.
      const created = await scheduleService.upsert(field.id, { enabled: true }, user.id);

      await dataSource.query('INSERT INTO gap_p0_poisoned_field_ids VALUES ($1)', [field.id]);
      try {
        await expect(scheduleService.upsert(field.id, { enabled: false }, user.id)).rejects.toThrow(
          /gap_p0: fallo forzado/,
        );
      } finally {
        await dataSource.query('DELETE FROM gap_p0_poisoned_field_ids WHERE "fieldId" = $1', [field.id]);
      }

      // El UPDATE a enabled=false SÍ se ejecutó dentro de la transacción (antes del INSERT
      // envenenado que la hizo fallar) — desde AFUERA, después del rollback real, debe seguir
      // valiendo `true`: la prueba real de que Postgres revirtió una escritura ya ejecutada, no
      // solo de que el código nunca la intentó.
      const untouched = await scheduleRepo.findOneByOrFail({ id: created.id });
      expect(untouched.enabled).toBe(true);

      const transitions = await transitionRepo.find({ where: { scheduleId: created.id } });
      expect(transitions).toHaveLength(1); // sigue siendo solo la inicial — nada huérfano.
      expect(transitions[0].enabled).toBe(true);
    });
  });
});
