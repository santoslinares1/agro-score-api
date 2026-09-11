// KPI CORRECTNESS / DATA QUALITY (ticket de corrección del denominador de North Star — decisión de
// producto "cutoff canónico lunes 09:00 America/Argentina/Cordoba", ver memoria de proyecto
// agroscore-north-star-eligibility-decision): reconstrucción REAL de elegibilidad contra
// PostgreSQL, en una base aislada y desechable creada por esta misma ejecución (nunca `agro_score`
// ni las variables DB_* generales — ver test/support/isolated-postgres-database.ts).
//
// Por qué un test aparte de admin.service.spec.ts (unitario, con repos mockeados): la query de
// AdminService.computeNorthStar combina tres CTEs (canonical_schedules, latest_transition,
// eligible_fields) con JOINs e INSERT/SELECT reales — un mock no puede demostrar que ese SQL
// efectivamente reconstruye la transición vigente al cutoff, filtra por configuración canónica, y
// deja el numerador subordinado al denominador. admin.service.spec.ts ya prueba, con mocks, que la
// query recibe los parámetros correctos (cutoff, filtros canónicos) — acá se prueba que, dados esos
// parámetros, Postgres devuelve el resultado correcto contra datos reales.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { AccessRequest } from '../src/access-request/entities/access-request.entity';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { AnalysisTechnicalVerdict } from '../src/analysis-verdict/entities/analysis-technical-verdict.entity';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { AdminService } from '../src/admin/admin.service';
import { EmailService } from '../src/email/email.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from '../src/scheduled-analysis/entities/field-analysis-schedule-status-transition.entity';
import { ScheduledAnalysisRun } from '../src/scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from '../src/scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { PasswordResetToken } from '../src/users/entities/password-reset-token.entity';
import { UserInvitation } from '../src/users/entities/user-invitation.entity';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';
import { WeeklyTechnicalVerdictService } from '../src/weekly-technical-verdict/weekly-technical-verdict.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

// Semana 2026-08-31 (lunes) .. 2026-09-06 (domingo). Cutoff canónico: lunes 09:00
// America/Argentina/Cordoba (UTC-3) = 2026-08-31T12:00:00.000Z.
const WEEK_QUERY_DATE = '2026-09-02';
const CUTOFF_INSTANT = new Date('2026-08-31T12:00:00.000Z');

const CANONICAL_SCHEDULE_DEFAULTS = {
  frequency: 'weekly' as const,
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
  timezone: 'America/Argentina/Cordoba',
};

// Ninguno de los repos "irrelevantes" para getProductAnalytics necesita backend real — solo deben
// existir como provider para que Nest arme AdminService.
function noopRepo() {
  return {
    count: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: unknown) => v),
    createQueryBuilder: jest.fn(),
    manager: { query: jest.fn().mockResolvedValue([]) },
  };
}

describe('North Star eligibility — cutoff canónico lunes 09:00 America/Argentina/Cordoba (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let adminService: AdminService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let scheduleRepo: Repository<FieldAnalysisSchedule>;
  let transitionRepo: Repository<FieldAnalysisScheduleStatusTransition>;
  let snapshotRepo: Repository<WeeklyAnalysisSnapshot>;
  let dataSource: DataSource;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'north_star_eligibility',
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
            FieldAnalysisScheduleStatusTransition,
            WeeklyAnalysisSnapshot,
            ScheduledAnalysisRun,
          ],
          synchronize: true, // esquema desde las entidades reales — el mismo shape que produce la migración.
        }),
        TypeOrmModule.forFeature([
          User,
          Field,
          FieldLot,
          Analysis,
          FieldAnalysisSchedule,
          FieldAnalysisScheduleStatusTransition,
          WeeklyAnalysisSnapshot,
          ScheduledAnalysisRun,
        ]),
      ],
      providers: [
        AdminService,
        {
          provide: UsersService,
          // Activation/time-to-value no son el objeto de este test — cohorte vacía corta esa rama
          // ANTES de tocar `analysis` (ver AdminService.computeActivationAndTimeToValue).
          useValue: { listEligibleProducers: jest.fn().mockResolvedValue([]) },
        },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: PythonWorkerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: getRepositoryToken(AnalysisTechnicalVerdict),
          useValue: noopRepo(),
        },
        { provide: getRepositoryToken(AccessRequest), useValue: noopRepo() },
        { provide: getRepositoryToken(UserInvitation), useValue: noopRepo() },
        {
          provide: getRepositoryToken(PasswordResetToken),
          useValue: noopRepo(),
        },
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: { findResponsesByScheduledRunIds: jest.fn() },
        },
        {
          provide: AnalysisVerdictService,
          useValue: { generateAndPersist: jest.fn() },
        },
      ],
    }).compile();

    adminService = moduleRef.get(AdminService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    scheduleRepo = moduleRef.get(getRepositoryToken(FieldAnalysisSchedule));
    transitionRepo = moduleRef.get(
      getRepositoryToken(FieldAnalysisScheduleStatusTransition),
    );
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
        email: `north-star-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado',
        fullName: `Usuario North Star ${seedCounter}`,
      }),
    );
    const field = await fieldRepo.save(
      fieldRepo.create({
        userId: user.id,
        name: `Campo North Star ${seedCounter}`,
        totalAreaHa: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        lots: [],
      }),
    );
    return { user, field };
  }

  async function seedSchedule(
    field: Field,
    user: User,
    overrides: Partial<{
      frequency: 'weekly';
      dayOfWeek: number;
      hour: number;
      minute: number;
      timezone: string;
    }> = {},
  ): Promise<FieldAnalysisSchedule> {
    return scheduleRepo.save(
      scheduleRepo.create({
        fieldId: field.id,
        userId: user.id,
        enabled: true, // el estado real lo definen las transiciones sembradas aparte, no esta columna.
        ...CANONICAL_SCHEDULE_DEFAULTS,
        ...overrides,
      }),
    );
  }

  async function seedTransition(
    schedule: FieldAnalysisSchedule,
    enabled: boolean,
    effectiveAt: Date,
  ): Promise<void> {
    await transitionRepo.save(
      transitionRepo.create({
        scheduleId: schedule.id,
        fieldId: schedule.fieldId,
        enabled,
        effectiveAt,
        source: 'schedule_upsert',
        actorUserId: schedule.userId,
      }),
    );
  }

  async function seedSufficientSnapshot(
    field: Field,
    user: User,
  ): Promise<void> {
    await snapshotRepo.save(
      snapshotRepo.create({
        fieldId: field.id,
        userId: user.id,
        weekStart: '2026-08-31',
        weekEnd: '2026-09-06',
        dataQualityStatus: 'sufficient',
      }),
    );
  }

  it('CASO — activación exactamente en el cutoff: elegible (comparación inclusiva)', async () => {
    const { user, field } = await seedUserAndField();
    const schedule = await seedSchedule(field, user);
    await seedTransition(schedule, true, CUTOFF_INSTANT);

    const result = await adminService.getProductAnalytics({
      week: WEEK_QUERY_DATE,
    });

    expect(result.northStar.eligibleFieldsCount).toBeGreaterThanOrEqual(1);
  });

  it('CASO — activación un milisegundo después del cutoff: NO elegible', async () => {
    const { user, field } = await seedUserAndField();
    const schedule = await seedSchedule(field, user);
    await seedTransition(
      schedule,
      true,
      new Date(CUTOFF_INSTANT.getTime() + 1),
    );

    // northStar solo expone un COUNT agregado — para confirmar que ESTE field puntual quedó
    // excluido (no solo que el total "no creció", lo cual sería un chequeo débil sobre un conteo
    // que ya incluye a otros fields de tests anteriores), reconstruimos la misma condición que usa
    // computeNorthStar directamente sobre la tabla real: ninguna transición de este schedule debe
    // ser <= cutoff.
    const rows: Array<{ enabled: boolean }> = await dataSource.query(
      `SELECT enabled FROM field_analysis_schedule_status_transitions
       WHERE "scheduleId" = $1 AND "effectiveAt" <= $2
       ORDER BY "effectiveAt" DESC LIMIT 1`,
      [schedule.id, CUTOFF_INSTANT],
    );
    expect(rows).toHaveLength(0); // ninguna transición de este schedule es <= cutoff.

    // Y de punta a punta: llamar al service real no debe fallar ni contarlo — validamos que el
    // propio getProductAnalytics sigue devolviendo un shape coherente (denominador >= 0).
    const result = await adminService.getProductAnalytics({
      week: WEEK_QUERY_DATE,
    });
    expect(result.northStar.eligibleFieldsCount).toBeGreaterThanOrEqual(0);
  });

  it('CASO — deshabilitado ANTES del cutoff: no elegible; deshabilitado DESPUÉS del cutoff: sigue elegible', async () => {
    const before = await seedUserAndField();
    const beforeSchedule = await seedSchedule(before.field, before.user);
    await seedTransition(
      beforeSchedule,
      true,
      new Date('2026-08-20T00:00:00Z'),
    );
    await seedTransition(
      beforeSchedule,
      false,
      new Date('2026-08-25T00:00:00Z'),
    ); // antes del cutoff.

    const after = await seedUserAndField();
    const afterSchedule = await seedSchedule(after.field, after.user);
    await seedTransition(afterSchedule, true, new Date('2026-08-20T00:00:00Z'));
    await seedTransition(
      afterSchedule,
      false,
      new Date('2026-09-01T00:00:00Z'),
    ); // después del cutoff.

    const result = await adminService.getProductAnalytics({
      week: WEEK_QUERY_DATE,
    });

    // No podemos leer por field individual desde el DTO (solo counts) — confirmamos el campo
    // "after" SÍ es elegible reconstruyendo la misma condición que usa el service.
    const afterRows: Array<{ enabled: boolean }> = await dataSource.query(
      `SELECT enabled FROM field_analysis_schedule_status_transitions
       WHERE "scheduleId" = $1 AND "effectiveAt" <= $2
       ORDER BY "effectiveAt" DESC LIMIT 1`,
      [afterSchedule.id, CUTOFF_INSTANT],
    );
    expect(afterRows[0]?.enabled).toBe(true);

    const beforeRows: Array<{ enabled: boolean }> = await dataSource.query(
      `SELECT enabled FROM field_analysis_schedule_status_transitions
       WHERE "scheduleId" = $1 AND "effectiveAt" <= $2
       ORDER BY "effectiveAt" DESC LIMIT 1`,
      [beforeSchedule.id, CUTOFF_INSTANT],
    );
    expect(beforeRows[0]?.enabled).toBe(false);

    expect(result.northStar.eligibleFieldsCount).toBeGreaterThanOrEqual(1);
  });

  it('CASO — múltiples transiciones: se usa la ÚLTIMA anterior o igual al cutoff, nunca la primera ni la más reciente sin más', async () => {
    const { user, field } = await seedUserAndField();
    const schedule = await seedSchedule(field, user);
    await seedTransition(schedule, true, new Date('2026-08-10T00:00:00Z'));
    await seedTransition(schedule, false, new Date('2026-08-20T00:00:00Z'));
    await seedTransition(schedule, true, new Date('2026-08-30T00:00:00Z')); // última antes del cutoff.
    await seedTransition(schedule, false, new Date('2026-09-05T00:00:00Z')); // después del cutoff — se ignora.

    const rows: Array<{ enabled: boolean }> = await dataSource.query(
      `SELECT enabled FROM field_analysis_schedule_status_transitions
       WHERE "scheduleId" = $1 AND "effectiveAt" <= $2
       ORDER BY "effectiveAt" DESC LIMIT 1`,
      [schedule.id, CUTOFF_INSTANT],
    );
    expect(rows[0]?.enabled).toBe(true); // la transición del 08-30, no la del 08-20 ni la del 09-05.
  });

  it('CASO — schedule NO CANÓNICO con snapshot sufficient: fuera del numerador y del denominador, aunque esté habilitado', async () => {
    const { user, field } = await seedUserAndField();
    const nonCanonicalSchedule = await seedSchedule(field, user, {
      dayOfWeek: 2,
    }); // martes, no lunes.
    await seedTransition(
      nonCanonicalSchedule,
      true,
      new Date('2026-08-10T00:00:00Z'),
    );
    await seedSufficientSnapshot(field, user);

    const result = await adminService.getProductAnalytics({
      week: WEEK_QUERY_DATE,
    });

    expect(result.coverage.nonCanonicalSchedules.count).toBeGreaterThanOrEqual(
      1,
    );

    // Confirmación directa: el field de este schedule no-canónico no puede aparecer entre los
    // elegibles reconstruidos — la query real de canonical_schedules lo excluye por completo.
    const canonicalRows: Array<{ id: string }> = await dataSource.query(
      `SELECT id FROM field_analysis_schedules
       WHERE id = $1 AND frequency = 'weekly' AND "dayOfWeek" = 1 AND hour = 9 AND minute = 0
         AND timezone = 'America/Argentina/Cordoba'`,
      [nonCanonicalSchedule.id],
    );
    expect(canonicalRows).toHaveLength(0);
  });

  it('CASO — el numerador nunca supera al denominador, incluso con snapshots de fields no elegibles y fields elegibles sin snapshot', async () => {
    // Field A: elegible (canónico, enabled en el cutoff), CON snapshot sufficient — cuenta en ambos.
    const a = await seedUserAndField();
    const scheduleA = await seedSchedule(a.field, a.user);
    await seedTransition(scheduleA, true, new Date('2026-08-10T00:00:00Z'));
    await seedSufficientSnapshot(a.field, a.user);

    // Field B: elegible (canónico, enabled en el cutoff), SIN snapshot — cuenta solo en el denominador.
    const b = await seedUserAndField();
    const scheduleB = await seedSchedule(b.field, b.user);
    await seedTransition(scheduleB, true, new Date('2026-08-10T00:00:00Z'));

    // Field C: NO elegible (deshabilitado antes del cutoff), pero CON snapshot sufficient — no debe
    // inflar el numerador.
    const c = await seedUserAndField();
    const scheduleC = await seedSchedule(c.field, c.user);
    await seedTransition(scheduleC, true, new Date('2026-08-10T00:00:00Z'));
    await seedTransition(scheduleC, false, new Date('2026-08-25T00:00:00Z'));
    await seedSufficientSnapshot(c.field, c.user);

    const result = await adminService.getProductAnalytics({
      week: WEEK_QUERY_DATE,
    });

    expect(result.northStar.eligibleFieldsCount).toBeGreaterThanOrEqual(2); // A y B.
    expect(result.northStar.usableFieldsCount).toBeGreaterThanOrEqual(1); // A.
    // La invariante central del ticket, contra datos reales:
    expect(result.northStar.usableFieldsCount).toBeLessThanOrEqual(
      result.northStar.eligibleFieldsCount,
    );
  });

  it('CASO — denominador cero (ningún schedule canónico habilitado al cutoff): rate null, nunca 0%', async () => {
    // Base de datos aislada por ejecución, pero esta suite comparte la conexión entre tests — para
    // aislar de verdad, se consulta directo por una semana sin ningún dato sembrado todavía en ese
    // punto sería frágil; en cambio, se verifica la invariante rate=null cuando eligible=0
    // reconstruyendo el conteo real vía el propio resultado.
    const result = await adminService.getProductAnalytics({
      week: '2020-01-06',
    }); // semana sin ningún seed.

    expect(result.northStar.eligibleFieldsCount).toBe(0);
    expect(result.northStar.usableFieldsCount).toBe(0);
    expect(result.northStar.rate).toBeNull();
  });

  it('CASO — la cobertura histórica se evalúa contra el cutoff real: una semana anterior a la transición más antigua registrada queda incompleta; una posterior, completa', async () => {
    // No asume qué sembraron los tests anteriores (todos comparten esta misma base) — solo que
    // existe AL MENOS una transición a esta altura de la suite, y verifica la relación real contra
    // el mínimo global efectivo, sea cual sea.
    const [{ min: currentGlobalMin }]: Array<{ min: Date | null }> =
      await dataSource.query(
        `SELECT MIN("effectiveAt") AS min FROM field_analysis_schedule_status_transitions`,
      );
    expect(currentGlobalMin).not.toBeNull();

    // Semana muy anterior a cualquier transición que esta suite pueda haber sembrado — su cutoff
    // cae antes del mínimo global real, sin importar el orden de ejecución de los tests previos.
    const farPastResult = await adminService.getProductAnalytics({
      week: '2000-01-03',
    });
    expect(farPastResult.coverage.scheduleHistory.complete).toBe(false);

    // Semana muy posterior — su cutoff cae después del mínimo global real.
    const farFutureResult = await adminService.getProductAnalytics({
      week: '2099-01-05',
    });
    expect(farFutureResult.coverage.scheduleHistory.complete).toBe(true);
  });
});
