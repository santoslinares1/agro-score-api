// MEASUREMENT GAP P1-01 ("Dispatcher automático vs 'Ejecutar ahora'"): concurrencia REAL entre
// los dos entry points que llegan a ScheduledAnalysisRunnerService.triggerRun — contra PostgreSQL
// real, en una base aislada y desechable creada por esta misma ejecución (nunca `agro_score` ni
// las variables DB_* generales del backend, ver test/support/isolated-postgres-database.ts).
// Mismo criterio que test/field-analysis-schedule-transition-atomicity.e2e-spec.ts.
//
// Por qué un test aparte de scheduled-analysis-runner.service.spec.ts (unitario, con repos
// mockeados): un mock puede demostrar que el CALLER que pierde la carrera no vuelve a escribir su
// origen, pero no puede demostrar que dos INSERTs concurrentes reales contra
// unique(scheduleId, scheduledFor) efectivamente dejan una sola fila en la base, con el
// triggerSource de quien ganó la carrera de verdad — eso solo lo prueba Postgres real.
//
// AnalysisService/FieldsService/etc. se stubean livianos a propósito: lo que se quiere aislar acá
// es la escritura de ScheduledAnalysisRun.triggerSource en la sección crítica de triggerRun (dedup
// findOne → INSERT), no el pipeline de análisis completo (eso ya lo cubre el spec unitario).
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisService } from '../src/analysis/analysis.service';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { EmailService } from '../src/email/email.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { FieldsService } from '../src/fields/fields.service';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { ScheduledAnalysisRun } from '../src/scheduled-analysis/entities/scheduled-analysis-run.entity';
import { ScheduledAnalysisRunnerService } from '../src/scheduled-analysis/scheduled-analysis-runner.service';
import { UsersService } from '../src/users/users.service';
import { User } from '../src/users/user.entity';
import { WeeklyAnalysisSnapshot } from '../src/scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { WeeklyAnalysisSnapshotService } from '../src/scheduled-analysis/weekly-analysis-snapshot.service';
import { WeeklyTechnicalVerdictService } from '../src/weekly-technical-verdict/weekly-technical-verdict.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

describe('MEASUREMENT GAP P1-01 — triggerSource: carrera real dispatcher vs. run-now (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let runnerService: ScheduledAnalysisRunnerService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let scheduleRepo: Repository<FieldAnalysisSchedule>;
  let runRepo: Repository<ScheduledAnalysisRun>;
  let analysisRepo: Repository<Analysis>;
  let seedCounter = 0;
  /** Analysis real y única, sembrada una vez en beforeAll — run.analysisId es una FK real contra
   * "analysis" (ver ScheduledAnalysisRunnerService.triggerRun: `run.analysisId = analysis.id`),
   * así que el stub de AnalysisService.runFieldAnalysis tiene que devolver un id que exista de
   * verdad, no cualquier string. Una sola fila alcanza — nada en este archivo le importa su
   * contenido, solo que la FK resuelva. */
  let seededAnalysisId: string;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'trigger_source_race',
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
          synchronize: true, // esquema desde las entidades reales — el mismo shape que produce la migración.
        }),
        TypeOrmModule.forFeature([
          User,
          Field,
          FieldLot,
          Analysis,
          FieldAnalysisSchedule,
          ScheduledAnalysisRun,
        ]),
      ],
      providers: [
        ScheduledAnalysisRunnerService,
        {
          // Livianos a propósito — ver comentario de cabecera: la sección crítica que se quiere
          // probar (dedup findOne → INSERT de ScheduledAnalysisRun) ocurre ANTES de que triggerRun
          // llegue a llamar a ninguno de estos.
          provide: FieldsService,
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ id: 'field-x', maxCloudiness: 40 }),
          },
        },
        {
          provide: AnalysisService,
          useValue: {
            findByField: jest.fn().mockResolvedValue([]), // sin Analysis Procesando ajeno que bloquee.
            // FK real (run.analysisId → analysis.id) — devuelve el id de la Analysis sembrada en
            // beforeAll, leído en el momento de la llamada (closure), nunca un id inventado.
            runFieldAnalysis: jest
              .fn()
              .mockImplementation(() =>
                Promise.resolve({ id: seededAnalysisId } as Analysis),
              ),
          },
        },
        { provide: UsersService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: WeeklyAnalysisSnapshotService, useValue: {} },
        { provide: AnalysisVerdictService, useValue: {} },
        { provide: WeeklyTechnicalVerdictService, useValue: {} },
      ],
    }).compile();

    runnerService = moduleRef.get(ScheduledAnalysisRunnerService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    scheduleRepo = moduleRef.get(getRepositoryToken(FieldAnalysisSchedule));
    runRepo = moduleRef.get(getRepositoryToken(ScheduledAnalysisRun));
    analysisRepo = moduleRef.get(getRepositoryToken(Analysis));

    const seededAnalysis = await analysisRepo.save(
      analysisRepo.create({
        lotName: 'Campo completo (stub, no usado por estos tests)',
        status: 'Finalizado',
        startDate: '2026-08-17',
        endDate: '2026-08-24',
      }),
    );
    seededAnalysisId = seededAnalysis.id;
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

  async function seedUserFieldAndSchedule(): Promise<{
    schedule: FieldAnalysisSchedule;
  }> {
    seedCounter += 1;
    const user = await userRepo.save(
      userRepo.create({
        email: `trigger-source-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado',
        fullName: `Usuario Trigger Source ${seedCounter}`,
      }),
    );
    const field = await fieldRepo.save(
      fieldRepo.create({
        userId: user.id,
        name: `Campo Trigger Source ${seedCounter}`,
        totalAreaHa: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        lots: [],
      }),
    );
    const schedule = await scheduleRepo.save(
      scheduleRepo.create({
        fieldId: field.id,
        userId: user.id,
        enabled: true,
      }),
    );
    return { schedule };
  }

  it('CONCURRENCIA REAL — dispatcher y run-now compiten por el mismo schedule/semana: queda exactamente una fila, con el triggerSource de quien ganó la carrera', async () => {
    const { schedule } = await seedUserFieldAndSchedule();
    const now = new Date('2026-08-24T12:05:00Z');

    const [outcomeA, outcomeB] = await Promise.allSettled([
      runnerService.triggerRun(schedule, now, 'automatic_dispatcher'),
      runnerService.triggerRun(schedule, now, 'user_run_now'),
    ]);

    // El mecanismo de reintento ante unique_violation (ver saveNewRun) hace que ambos triggers
    // terminen resolviendo bien — ninguno propaga un 500 al caller, gane o pierda la carrera.
    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const rows = await runRepo.find({ where: { scheduleId: schedule.id } });
    expect(rows).toHaveLength(1); // unique(scheduleId, scheduledFor) respetado — nunca dos filas.

    const persisted = rows[0];
    expect(['automatic_dispatcher', 'user_run_now']).toContain(
      persisted.triggerSource,
    );

    // Ambos callers deben terminar viendo el MISMO triggerSource persistido — el del ganador real,
    // nunca una vista distinta cada uno (el loser tiene que haber releído la fila del ganador, no
    // fabricar la suya con su propio origen).
    const runA =
      outcomeA.status === 'fulfilled' ? outcomeA.value : (undefined as never);
    const runB =
      outcomeB.status === 'fulfilled' ? outcomeB.value : (undefined as never);
    expect(runA.id).toBe(persisted.id);
    expect(runB.id).toBe(persisted.id);
    expect(runA.triggerSource).toBe(persisted.triggerSource);
    expect(runB.triggerSource).toBe(persisted.triggerSource);
  });

  it('reutilización posterior (secuencial) del run ya creado NUNCA reescribe su triggerSource, sin importar qué origen pida el nuevo caller', async () => {
    const { schedule } = await seedUserFieldAndSchedule();
    const now = new Date('2026-08-24T12:05:00Z');

    const created = await runnerService.triggerRun(
      schedule,
      now,
      'automatic_dispatcher',
    );
    expect(created.triggerSource).toBe('automatic_dispatcher');

    // Un "Ejecutar ahora" llega DESPUÉS, para la misma semana — triggerRun lo dedupea, y NO debe
    // pisar el origen ya persistido con 'user_run_now'.
    const reused = await runnerService.triggerRun(
      schedule,
      now,
      'user_run_now',
    );

    expect(reused.id).toBe(created.id);
    expect(reused.triggerSource).toBe('automatic_dispatcher'); // sin cambios.

    const rows = await runRepo.find({ where: { scheduleId: schedule.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].triggerSource).toBe('automatic_dispatcher');
  });
});
