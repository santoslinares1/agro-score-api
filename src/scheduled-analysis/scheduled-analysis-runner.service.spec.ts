import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisService } from '../analysis/analysis.service';
import { FieldAnalysisSummary } from '../analysis/dto/field-analysis-summary.dto';
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
import { AnalysisTechnicalVerdictResponse } from '../analysis-verdict/dto/analysis-technical-verdict.dto';
import { EmailService } from '../email/email.service';
import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import { ScheduledAnalysisRun } from './entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from './entities/weekly-analysis-snapshot.entity';
import { computeScheduledAnalysisDateRange } from './scheduled-analysis-date-range.util';
import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';
import { WeeklyTechnicalVerdictService } from '../weekly-technical-verdict/weekly-technical-verdict.service';
import { WeeklyTechnicalVerdict } from '../weekly-technical-verdict/entities/weekly-technical-verdict.entity';
import { WeeklyTechnicalVerdictResponse } from '../weekly-technical-verdict/dto/weekly-technical-verdict.dto';

/**
 * Barrera de sincronización real (no un truco de awaits consecutivos): `n` llamadas concurrentes
 * a `arrive()` quedan todas suspendidas hasta que la n-ésima llega, y solo entonces las `n`
 * continúan juntas. Se usa para forzar una intercalación genuina entre dos reconcileRun() del
 * mismo run — ambos deben leer "no existe snapshot" ANTES de que cualquiera de los dos intente
 * crearlo (la ventana TOCTOU real que la reconciliación puede sufrir en producción), en vez de
 * simular la carrera con dos `await` consecutivos sobre un único objeto mutable compartido.
 */
function createBarrier(n: number): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    async arrive() {
      arrived += 1;
      if (arrived >= n) {
        release();
      }
      await gate;
    },
  };
}

describe('ScheduledAnalysisRunnerService', () => {
  let service: ScheduledAnalysisRunnerService;
  let scheduleRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let runRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let fieldsService: jest.Mocked<
    Pick<FieldsService, 'findOne' | 'findByIdOrFail'>
  >;
  let analysisService: jest.Mocked<
    Pick<AnalysisService, 'runFieldAnalysis' | 'findOne' | 'findByField'>
  >;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;
  let emailService: jest.Mocked<
    Pick<EmailService, 'sendScheduledAnalysisEmail'>
  >;
  let configService: { get: jest.Mock };
  let weeklySnapshotService: jest.Mocked<
    Pick<
      WeeklyAnalysisSnapshotService,
      'createFromAnalysis' | 'findByScheduledRunId'
    >
  >;
  let analysisVerdictService: jest.Mocked<
    Pick<AnalysisVerdictService, 'findResponseByAnalysisId'>
  >;
  let weeklyTechnicalVerdictService: jest.Mocked<
    Pick<
      WeeklyTechnicalVerdictService,
      'generateAndPersist' | 'findResponseBySnapshotId'
    >
  >;

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo A',
      startDate: '2024-01-01',
      endDate: '2026-08-21',
      maxCloudiness: 30,
      lots: [],
      ...overrides,
    }) as Field;

  const buildSchedule = (
    overrides: Partial<FieldAnalysisSchedule> = {},
  ): FieldAnalysisSchedule => ({
    id: 'schedule-1',
    fieldId: 'field-1',
    userId: 'user-A',
    enabled: true,
    frequency: 'weekly',
    dayOfWeek: 1,
    hour: 9,
    minute: 0,
    timezone: 'America/Argentina/Cordoba',
    analysisScope: 'field',
    includeMapAssets: true,
    includeIndexImages: true,
    includeImageSeries: true,
    lastAnalysisId: null,
    lastRunAt: null,
    nextRunAt: new Date('2026-08-24T12:00:00Z'),
    lastStatus: null,
    lastErrorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const buildRun = (
    overrides: Partial<ScheduledAnalysisRun> = {},
  ): ScheduledAnalysisRun => ({
    id: 'run-1',
    scheduleId: 'schedule-1',
    fieldId: 'field-1',
    userId: 'user-A',
    analysisId: null,
    status: 'pending',
    scheduledFor: '2026-08-24',
    startedAt: null,
    completedAt: null,
    failedAt: null,
    emailSentAt: null,
    errorMessage: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis =>
    ({
      id: 'analysis-1',
      status: 'Procesando',
      errorMessage: null,
      ...overrides,
    }) as Analysis;

  const buildAnalysisSummary = (
    overrides: Partial<FieldAnalysisSummary> = {},
  ): FieldAnalysisSummary =>
    ({
      id: 'other-analysis-1',
      status: 'Procesando',
      ...overrides,
    }) as FieldAnalysisSummary;

  const DEFAULT_BASE_URL = 'https://app.agroscore.test';

  const buildUser = (overrides: Partial<User> = {}): User =>
    ({
      id: 'user-A',
      email: 'user@example.com',
      fullName: 'Ana Productora',
      ...overrides,
    }) as User;

  const buildTechnicalVerdict = (
    overrides: Partial<AnalysisTechnicalVerdictResponse> = {},
  ): AnalysisTechnicalVerdictResponse => ({
    status: 'generated',
    verdict: 'favorable',
    confidence: 'high',
    summary: 'El campo muestra una respuesta satelital favorable.',
    keyFindings: [],
    possibleCauses: [],
    recommendations: [],
    limitations: [],
    generatedAt: '2026-08-24T12:00:00.000Z',
    generator: 'claude-technical-verdict',
    promptVersion: 'technical-verdict-v1',
    ...overrides,
  });

  const buildSnapshot = (
    overrides: Partial<WeeklyAnalysisSnapshot> = {},
  ): WeeklyAnalysisSnapshot =>
    ({
      id: 'snapshot-1',
      fieldId: 'field-1',
      userId: 'user-A',
      analysisId: 'analysis-1',
      scheduledRunId: 'run-1',
      weekStart: '2026-08-17',
      weekEnd: '2026-08-24',
      source: 'scheduled_analysis',
      score: 78,
      scoreLabel: 'Buena aptitud productiva',
      dataQualityStatus: 'sufficient',
      hasRgbImage: true,
      hasNdviImage: true,
      hasNdmiImage: true,
      hasImageSeries: false,
      comparisonVsPrevious: {
        summary: ['Primer reporte semanal disponible para este campo.'],
      },
      ...overrides,
    }) as WeeklyAnalysisSnapshot;

  const buildWeeklyTechnicalVerdict = (
    overrides: Partial<WeeklyTechnicalVerdict> = {},
  ): WeeklyTechnicalVerdict =>
    ({
      id: 'weekly-verdict-1',
      snapshotId: 'snapshot-1',
      status: 'generated',
      verdict: 'favorable',
      trend: 'stable',
      confidence: 'high',
      summary: 'Diagnóstico semanal.',
      keyChanges: [],
      areasToReview: [],
      recommendations: [],
      limitations: [],
      previousSnapshotId: null,
      generator: 'deterministic-v1',
      promptVersion: null,
      errorMessage: null,
      generatedAt: new Date('2026-08-24T12:00:00.000Z'),
      ...overrides,
    }) as WeeklyTechnicalVerdict;

  // PR 16C: shape que devuelve WeeklyTechnicalVerdictService.findResponseBySnapshotId (DTO,
  // generatedAt como ISO string) — distinto de buildWeeklyTechnicalVerdict (la entidad, con
  // generatedAt como Date), que ya usaban los tests de PR 16B para generateAndPersist.
  const buildWeeklyTechnicalVerdictResponse = (
    overrides: Partial<WeeklyTechnicalVerdictResponse> = {},
  ): WeeklyTechnicalVerdictResponse => ({
    status: 'generated',
    verdict: 'favorable',
    trend: 'stable',
    confidence: 'high',
    summary: 'Respecto del reporte anterior, el campo se mantiene estable.',
    keyChanges: [],
    areasToReview: [],
    recommendations: [],
    limitations: [],
    previousSnapshotId: null,
    generator: 'deterministic-v1',
    promptVersion: null,
    errorMessage: null,
    generatedAt: '2026-08-24T12:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledAnalysisRunnerService,
        {
          provide: getRepositoryToken(FieldAnalysisSchedule),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(ScheduledAnalysisRun),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            save: jest.fn((data) =>
              Promise.resolve({ id: data.id ?? 'run-1', ...data }),
            ),
          },
        },
        {
          provide: FieldsService,
          useValue: { findOne: jest.fn(), findByIdOrFail: jest.fn() },
        },
        {
          provide: AnalysisService,
          useValue: {
            runFieldAnalysis: jest.fn(),
            findOne: jest.fn(),
            findByField: jest.fn(),
          },
        },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        {
          provide: EmailService,
          useValue: { sendScheduledAnalysisEmail: jest.fn() },
        },
        {
          provide: ConfigService,
          // DEFAULT_BASE_URL: valor por defecto para que los tests existentes (que ejercitan el
          // envío de email) sigan viendo un link armable — el caso "falta APP_PUBLIC_URL" tiene
          // su propio test que pisa este mock puntualmente.
          useValue: {
            get: jest.fn((key: string) =>
              key === 'APP_PUBLIC_URL' ? DEFAULT_BASE_URL : undefined,
            ),
          },
        },
        {
          provide: WeeklyAnalysisSnapshotService,
          useValue: {
            createFromAnalysis: jest.fn(),
            findByScheduledRunId: jest.fn(),
          },
        },
        {
          provide: AnalysisVerdictService,
          useValue: { findResponseByAnalysisId: jest.fn() },
        },
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: {
            generateAndPersist: jest.fn(),
            findResponseBySnapshotId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(ScheduledAnalysisRunnerService);
    scheduleRepository = module.get(getRepositoryToken(FieldAnalysisSchedule));
    runRepository = module.get(getRepositoryToken(ScheduledAnalysisRun));
    fieldsService = module.get(FieldsService);
    analysisService = module.get(AnalysisService);
    usersService = module.get(UsersService);
    emailService = module.get(EmailService);
    configService = module.get(ConfigService);
    weeklySnapshotService = module.get(WeeklyAnalysisSnapshotService);
    analysisVerdictService = module.get(AnalysisVerdictService);
    weeklyTechnicalVerdictService = module.get(WeeklyTechnicalVerdictService);

    // findByField: por defecto "sin otros análisis en curso" — el nuevo chequeo defensivo de
    // triggerRun (fix crítico de la auditoría) lo llama siempre antes de runFieldAnalysis.
    analysisService.findByField.mockResolvedValue([]);

    // scheduleRepository.findOne: por defecto un schedule activo — reconcileRun ahora relee el
    // schedule antes de mandar el email (fix de la auditoría) y los tests existentes de envío de
    // email no esperaban tener que mockear esto explícitamente.
    scheduleRepository.findOne.mockResolvedValue(buildSchedule());

    // Fase 5: por defecto hay un snapshot disponible para que los tests existentes de envío de
    // email (que no son sobre snapshots en sí) sigan pasando sin tener que mockear esto cada vez.
    weeklySnapshotService.createFromAnalysis.mockResolvedValue(buildSnapshot());
    weeklySnapshotService.findByScheduledRunId.mockResolvedValue(
      buildSnapshot(),
    );

    // PR 12A: por defecto hay un veredicto ya generado, para que los tests de envío de email
    // preexistentes (que no son sobre el veredicto en sí) sigan pasando sin tener que mockear esto
    // cada vez — mismo criterio ya usado acá para weeklySnapshotService.
    analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
      buildTechnicalVerdict(),
    );

    // PR 16B: mismo criterio — por defecto el campo resuelve y el diagnóstico semanal se genera
    // bien, para que los tests preexistentes (que no son sobre weeklyTechnicalVerdict en sí) sigan
    // pasando sin tener que mockear esto cada vez. Los tests dedicados de esta sección pisan estos
    // mocks puntualmente.
    fieldsService.findByIdOrFail.mockResolvedValue(buildField());
    weeklyTechnicalVerdictService.generateAndPersist.mockResolvedValue(
      buildWeeklyTechnicalVerdict(),
    );

    // PR 16C: mismo criterio — por defecto ya hay un diagnóstico semanal 'generated' persistido,
    // para que los tests preexistentes (envío de email) sigan pasando sin mockear esto cada vez.
    weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
      buildWeeklyTechnicalVerdictResponse(),
    );
  });

  describe('processDueSchedules', () => {
    it('procesa cada schedule vencido (enabled=true, nextRunAt<=now)', async () => {
      const schedule = buildSchedule();
      scheduleRepository.find.mockResolvedValue([schedule]);
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      const now = new Date('2026-08-24T12:05:00Z');
      await service.processDueSchedules(now);

      expect(scheduleRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ enabled: true }),
        }),
      );
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledTimes(1);
    });

    it('no dispara nada si no hay schedules vencidos', async () => {
      scheduleRepository.find.mockResolvedValue([]);

      await service.processDueSchedules(new Date());

      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('un fallo en un schedule no frena el resto', async () => {
      const broken = buildSchedule({
        id: 'schedule-broken',
        fieldId: 'field-broken',
      });
      const healthy = buildSchedule({
        id: 'schedule-healthy',
        fieldId: 'field-healthy',
      });
      scheduleRepository.find.mockResolvedValue([broken, healthy]);
      runRepository.findOne.mockResolvedValue(null);

      fieldsService.findOne.mockImplementation((fieldId: string) => {
        if (fieldId === 'field-broken') {
          return Promise.reject(new NotFoundException('Campo no encontrado.'));
        }
        return Promise.resolve(buildField({ id: fieldId }));
      });
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await expect(
        service.processDueSchedules(new Date()),
      ).resolves.toBeUndefined();

      // El schedule sano igual llegó a llamar a runFieldAnalysis a pesar de que el roto falló.
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-healthy',
        expect.anything(),
        'user-A',
      );
    });
  });

  describe('triggerRun', () => {
    it('crea el Analysis vía AnalysisService.runFieldAnalysis (mismo flujo actual, sin duplicar lógica)', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, new Date('2026-08-24T12:00:00Z'));

      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        expect.objectContaining({ maxCloudiness: 30 }),
        'user-A',
      );
    });

    it('FASE 4D-fix: usa la ventana semanal (hoy - 7 días), NO field.startDate/endDate', async () => {
      const schedule = buildSchedule({ timezone: 'America/Argentina/Cordoba' });
      const now = new Date('2026-08-24T12:00:00Z');
      // El campo tiene fechas propias, bien distintas de lo que calcularía la ventana móvil —
      // si el payload terminara usando estas, el test de abajo lo detectaría.
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(
        buildField({ startDate: '2019-01-01', endDate: '2020-01-01' }),
      );
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, now);

      const expectedRange = computeScheduledAnalysisDateRange(now, {
        timezone: 'America/Argentina/Cordoba',
      });
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        expect.objectContaining({
          startDate: expectedRange.startDate,
          endDate: expectedRange.endDate,
        }),
        'user-A',
      );
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalledWith(
        'field-1',
        expect.objectContaining({
          startDate: '2019-01-01',
          endDate: '2020-01-01',
        }),
        'user-A',
      );
    });

    it('FASE 4D: guarda la ventana usada en run.metadata', async () => {
      const schedule = buildSchedule();
      const now = new Date('2026-08-24T12:00:00Z');
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, now);

      const expectedRange = computeScheduledAnalysisDateRange(now, {
        timezone: schedule.timezone,
      });
      expect(runRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { dateRange: expectedRange } }),
      );
    });

    it('FASE 4D: fuerza includeMapAssets/includeIndexImages/includeImageSeries=true aunque el schedule tenga false', async () => {
      const schedule = buildSchedule({
        includeMapAssets: false,
        includeIndexImages: false,
        includeImageSeries: false,
      });
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, new Date('2026-08-24T12:00:00Z'));

      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        expect.objectContaining({
          includeMapAssets: true,
          includeIndexImages: true,
          includeImageSeries: true,
        }),
        'user-A',
      );
    });

    it('no duplica una corrida ya existente para la misma semana (mismo scheduleId+scheduledFor)', async () => {
      const schedule = buildSchedule();
      const existingRun = buildRun({ status: 'processing' });
      runRepository.findOne.mockResolvedValue(existingRun);

      const result = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );

      expect(result).toBe(existingRun);
      expect(runRepository.create).not.toHaveBeenCalled();
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('marca el run failed si AnalysisService.runFieldAnalysis rechaza', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockRejectedValue(
        new Error('El worker no responde.'),
      );

      const run = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );

      expect(run.status).toBe('failed');
      expect(run.errorMessage).toContain('El worker no responde.');
      expect(scheduleRepository.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ lastStatus: 'failed' }),
      );
    });

    it('FIX CRÍTICO: si ya hay un Analysis Procesando ajeno para el campo, no lo llama y no se le ata', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({
          id: 'manual-analysis-ajeno',
          status: 'Procesando',
        }),
      ]);

      const run = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );

      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(run.status).toBe('failed');
      expect(run.analysisId).not.toBe('manual-analysis-ajeno');
      expect(run.analysisId).toBeFalsy();
      expect(run.errorMessage).toContain(
        'Ya hay un análisis en proceso para este campo',
      );
    });

    it('FIX CRÍTICO: no manda email cuando se rechazó por análisis Procesando ajeno', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({ status: 'Procesando' }),
      ]);

      const run = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );
      runRepository.find.mockResolvedValue([run]); // el run 'failed' ya no lo reconsidera el reconciler

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
    });

    it('OPS-1: un Analysis Procesando stale (más de 20 min) NO bloquea triggerRun — se dispara la corrida', async () => {
      const schedule = buildSchedule();
      const now = new Date('2026-08-24T12:00:00Z');
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({
          id: 'stale-analysis-1',
          status: 'Procesando',
          createdAt: new Date(now.getTime() - 25 * 60 * 1000),
        }),
      ]);
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      const run = await service.triggerRun(schedule, now);

      expect(analysisService.runFieldAnalysis).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('processing');
    });

    it('OPS-1: triggerRun nunca marca el Analysis stale como Error por su cuenta — esa autoridad es de AnalysisService', async () => {
      const schedule = buildSchedule();
      const now = new Date('2026-08-24T12:00:00Z');
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({
          id: 'stale-analysis-1',
          status: 'Procesando',
          createdAt: new Date(now.getTime() - 25 * 60 * 1000),
        }),
      ]);
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, now);

      // ScheduledAnalysisRunnerService no tiene ningún repositorio de Analysis inyectado — la
      // única forma de que el stale se resuelva es que runFieldAnalysis (mockeado acá) lo haga
      // internamente. Este test documenta esa separación de responsabilidad explícitamente.
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        expect.anything(),
        'user-A',
      );
    });

    it('un Analysis Procesando reciente sigue bloqueando triggerRun (comportamiento actual sin cambios)', async () => {
      const schedule = buildSchedule();
      const now = new Date('2026-08-24T12:00:00Z');
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({
          status: 'Procesando',
          createdAt: new Date(now.getTime() - 2 * 60 * 1000),
        }),
      ]);

      const run = await service.triggerRun(schedule, now);

      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(run.status).toBe('failed');
      expect(run.errorMessage).toContain(
        'Ya hay un análisis en proceso para este campo',
      );
    });

    it('FIX: si un análisis manual normal existe pero NO está Procesando, el scheduled run sí se dispara', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.findByField.mockResolvedValue([
        buildAnalysisSummary({ status: 'Finalizado' }),
        buildAnalysisSummary({ status: 'Error' }),
      ]);
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      const run = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );

      expect(analysisService.runFieldAnalysis).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('processing');
    });

    it('FIX: la carrera de unique(scheduleId, scheduledFor) devuelve la corrida existente en vez de un 500', async () => {
      const schedule = buildSchedule();
      const winnerRun = buildRun({ id: 'run-winner', status: 'processing' });

      // Primer findOne (chequeo de dedup al principio de triggerRun): nadie la creó todavía.
      // Segundo findOne (dentro de saveNewRun, tras perder la carrera del insert): ya existe.
      runRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winnerRun);
      runRepository.save.mockRejectedValueOnce(
        Object.assign(
          new Error('duplicate key value violates unique constraint'),
          { code: '23505' },
        ),
      );

      const result = await service.triggerRun(
        schedule,
        new Date('2026-08-24T12:00:00Z'),
      );

      expect(result).toBe(winnerRun);
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      // nextRunAt igual se recalcula, mismo criterio que el branch de existingRun.
      expect(scheduleRepository.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ nextRunAt: expect.any(Date) }),
      );
    });

    it('un error de DB que NO es unique violation se sigue propagando tal cual (no se confunde con la carrera)', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      runRepository.save.mockRejectedValueOnce(
        new Error('connection terminated'),
      );

      await expect(
        service.triggerRun(schedule, new Date('2026-08-24T12:00:00Z')),
      ).rejects.toThrow('connection terminated');
    });

    it('recalcula nextRunAt al terminar (tanto en éxito como en fallo)', async () => {
      const schedule = buildSchedule();
      runRepository.findOne.mockResolvedValue(null);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.triggerRun(schedule, new Date('2026-08-24T12:00:00Z'));

      const nextRunAtCall = scheduleRepository.update.mock.calls.find(
        ([, fields]) => fields && 'nextRunAt' in fields,
      );
      expect(nextRunAtCall).toBeDefined();
      expect(nextRunAtCall[1].nextRunAt).toBeInstanceOf(Date);
      expect(nextRunAtCall[1].nextRunAt.getTime()).toBeGreaterThan(
        new Date('2026-08-24T12:00:00Z').getTime(),
      );
    });
  });

  describe('reconcilePendingRuns / envío de email', () => {
    it('envía el email solo cuando el Analysis está Finalizado', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Finalizado' }),
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({
          fieldName: 'Campo A',
          userName: 'Ana Productora',
        }),
      );
    });

    it('FASE 5: crea el snapshot semanal cuando el Analysis llega a Finalizado', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(analysis);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1' }),
        analysis,
      );
    });

    it('FASE 5: NO crea snapshot si el Analysis falló', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Error', errorMessage: 'Fallo worker' }),
      );

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).not.toHaveBeenCalled();
    });

    describe('PR 16B: diagnóstico semanal (weeklyTechnicalVerdict)', () => {
      it('genera el diagnóstico semanal después de crear el snapshot, con fieldName e individualVerdict como contexto', async () => {
        const run = buildRun({
          status: 'processing',
          analysisId: 'analysis-1',
        });
        const analysis = buildAnalysis({ status: 'Finalizado' });
        const snapshot = buildSnapshot({ id: 'snapshot-42' });
        runRepository.find.mockResolvedValue([run]);
        analysisService.findOne.mockResolvedValue(analysis);
        weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
        fieldsService.findByIdOrFail.mockResolvedValue(
          buildField({ name: 'Campo Norte' }),
        );
        analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
          buildTechnicalVerdict({
            verdict: 'attention',
            confidence: 'medium',
            summary: 'resumen individual',
          }),
        );
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.generateAndPersist,
        ).toHaveBeenCalledWith(snapshot, {
          fieldName: 'Campo Norte',
          individualVerdict: {
            verdict: 'attention',
            confidence: 'medium',
            summary: 'resumen individual',
          },
        });
      });

      it('no genera el diagnóstico semanal si el snapshot no se pudo crear', async () => {
        const run = buildRun({
          status: 'processing',
          analysisId: 'analysis-1',
        });
        const analysis = buildAnalysis({ status: 'Finalizado' });
        runRepository.find.mockResolvedValue([run]);
        analysisService.findOne.mockResolvedValue(analysis);
        weeklySnapshotService.createFromAnalysis.mockRejectedValue(
          new Error('DB caída'),
        );

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.generateAndPersist,
        ).not.toHaveBeenCalled();
      });

      it('no depende de que el technicalVerdict individual exista — genera igual pasando individualVerdict=null', async () => {
        const run = buildRun({
          status: 'processing',
          analysisId: 'analysis-1',
        });
        const analysis = buildAnalysis({ status: 'Finalizado' });
        const snapshot = buildSnapshot();
        runRepository.find.mockResolvedValue([run]);
        analysisService.findOne.mockResolvedValue(analysis);
        weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
        analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(null);
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.generateAndPersist,
        ).toHaveBeenCalledWith(
          snapshot,
          expect.objectContaining({ individualVerdict: null }),
        );
      });

      it('si generateAndPersist falla, no bloquea el run ni el envío del email (best-effort, propio try/catch)', async () => {
        const run = buildRun({
          status: 'processing',
          analysisId: 'analysis-1',
        });
        const analysis = buildAnalysis({ status: 'Finalizado' });
        const snapshot = buildSnapshot();
        runRepository.find.mockResolvedValue([run]);
        analysisService.findOne.mockResolvedValue(analysis);
        weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
        weeklyTechnicalVerdictService.generateAndPersist.mockRejectedValue(
          new Error('falló la generación'),
        );
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await expect(service.reconcilePendingRuns()).resolves.toBeUndefined();

        expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(
          1,
        );
        expect(runRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed' }),
        );
      });

      it('no llama a Claude real — todo pasa por el mock de WeeklyTechnicalVerdictService', async () => {
        const run = buildRun({
          status: 'processing',
          analysisId: 'analysis-1',
        });
        const analysis = buildAnalysis({ status: 'Finalizado' });
        runRepository.find.mockResolvedValue([run]);
        analysisService.findOne.mockResolvedValue(analysis);
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.generateAndPersist,
        ).toHaveBeenCalledTimes(1);
      });
    });

    describe('PR 16C: Diagnóstico semanal en el mail (lee, nunca regenera)', () => {
      it('sendCompletionEmail lee WeeklyTechnicalVerdictService.findResponseBySnapshotId(snapshot.id)', async () => {
        const run = buildRun({
          status: 'completed',
          analysisId: 'analysis-1',
          emailSentAt: null,
        });
        const snapshot = buildSnapshot({ id: 'snapshot-77' });
        runRepository.find.mockResolvedValue([run]);
        weeklySnapshotService.findByScheduledRunId.mockResolvedValue(snapshot);
        fieldsService.findByIdOrFail.mockResolvedValue(buildField());
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.findResponseBySnapshotId,
        ).toHaveBeenCalledWith('snapshot-77');
      });

      it('si existe generated, lo pasa tal cual al EmailService', async () => {
        const run = buildRun({
          status: 'completed',
          analysisId: 'analysis-1',
          emailSentAt: null,
        });
        const weeklyVerdict = buildWeeklyTechnicalVerdictResponse({
          trend: 'worsening',
          summary: 'El campo retrocedió respecto de la semana anterior.',
        });
        runRepository.find.mockResolvedValue([run]);
        fieldsService.findByIdOrFail.mockResolvedValue(buildField());
        usersService.findById.mockResolvedValue(buildUser());
        weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
          weeklyVerdict,
        );
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
          'user@example.com',
          expect.objectContaining({ weeklyTechnicalVerdict: weeklyVerdict }),
        );
      });

      it('si no existe (null), pasa null y el mail sigue saliendo con normalidad', async () => {
        const run = buildRun({
          status: 'completed',
          analysisId: 'analysis-1',
          emailSentAt: null,
        });
        runRepository.find.mockResolvedValue([run]);
        fieldsService.findByIdOrFail.mockResolvedValue(buildField());
        usersService.findById.mockResolvedValue(buildUser());
        weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
          null,
        );
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
          'user@example.com',
          expect.objectContaining({ weeklyTechnicalVerdict: null }),
        );
        expect(runRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ emailSentAt: expect.any(Date) }),
        );
      });

      it('nunca llama a WeeklyTechnicalVerdictService.generateAndPersist desde sendCompletionEmail', async () => {
        const run = buildRun({
          status: 'completed',
          analysisId: 'analysis-1',
          emailSentAt: null,
        });
        runRepository.find.mockResolvedValue([run]);
        fieldsService.findByIdOrFail.mockResolvedValue(buildField());
        usersService.findById.mockResolvedValue(buildUser());
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(
          weeklyTechnicalVerdictService.generateAndPersist,
        ).not.toHaveBeenCalled();
      });

      it('no bloquea emailSentAt — el email se manda y se marca igual sin importar el diagnóstico semanal', async () => {
        const run = buildRun({
          status: 'completed',
          analysisId: 'analysis-1',
          emailSentAt: null,
        });
        runRepository.find.mockResolvedValue([run]);
        fieldsService.findByIdOrFail.mockResolvedValue(buildField());
        usersService.findById.mockResolvedValue(buildUser());
        weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
          buildWeeklyTechnicalVerdictResponse({ status: 'failed' }),
        );
        emailService.sendScheduledAnalysisEmail.mockResolvedValue({
          sent: true,
          provider: 'resend',
          dryRun: false,
        });

        await service.reconcilePendingRuns();

        expect(runRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ emailSentAt: expect.any(Date) }),
        );
      });
    });

    it('FASE 5: el email usa weekStart/weekEnd/summary/dataQualityStatus del snapshot, no una promesa fija', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(
        buildSnapshot({
          weekStart: '2026-08-17',
          weekEnd: '2026-08-24',
          dataQualityStatus: 'partial',
          hasRgbImage: false,
          comparisonVsPrevious: {
            summary: [
              'El score subió 4 puntos respecto de la semana anterior.',
            ],
          },
        }),
      );
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({
          weekStart: '2026-08-17',
          weekEnd: '2026-08-24',
          dataQualityStatus: 'partial',
          hasRgbImage: false,
          summary: ['El score subió 4 puntos respecto de la semana anterior.'],
        }),
      );
    });

    it('FASE 5 (ampliado por el FIX de snapshot faltante): si falla la recuperación del snapshot en este ciclo, no manda email — pero SÍ la intenta usando el Analysis persistido', async () => {
      // Antes del FIX, este test solo comprobaba "no email" para un run 'completed' sin
      // snapshot, sin verificar que el sistema intentara resolverlo — un run así se quedaba
      // huérfano para siempre (ver docstring de la clase). Ahora se verifica explícitamente que
      // SÍ se reintenta (createFromAnalysis es llamado, con el Analysis re-leído por
      // analysisService.findOne) y que, si ese intento también falla, el run sigue 'completed'
      // (nunca se lo convierte en 'failed' por esto — es recuperable en el próximo ciclo).
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Finalizado' }),
      );
      weeklySnapshotService.createFromAnalysis.mockRejectedValue(
        new Error('DB caída'),
      );

      await service.reconcilePendingRuns();

      expect(analysisService.findOne).toHaveBeenCalledWith('analysis-1');
      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1' }),
        expect.objectContaining({ id: 'analysis-1', status: 'Finalizado' }),
      );
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(runRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('no envía email si el Analysis falló (status=Error)', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Error', errorMessage: 'Fallo worker' }),
      );

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'Fallo worker',
        }),
      );
    });

    it('no hace nada mientras el Analysis sigue Procesando', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Procesando' }),
      );

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(runRepository.save).not.toHaveBeenCalled();
    });

    it('reintenta el email en el próximo ciclo si un run quedó completed sin emailSentAt', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });

    it('no reintenta el email si ya se mandó (emailSentAt seteado) — nunca dos mails para el mismo run', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: new Date(),
      });
      runRepository.find.mockResolvedValue([run]);

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
    });

    it('FIX: no manda email si el schedule fue desactivado antes de completar la corrida', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: expect.stringContaining('desactivado'),
        }),
      );
    });

    it('FIX: releído el schedule sigue activo, el email se manda con normalidad', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: true }),
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });

    it('FIX: sin APP_PUBLIC_URL ni FRONTEND_URL, no manda un email con link relativo (reintenta después)', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: true }),
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      configService.get.mockReturnValue(undefined); // ni APP_PUBLIC_URL ni FRONTEND_URL configurados

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      // Queda 'completed' sin emailSentAt (no se transforma en 'failed'): un problema de config es
      // corregible, así que el próximo ciclo debe poder reintentarlo solo.
      expect(runRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('PR 12A: lee el veredicto ya persistido por analysisId y lo pasa al EmailService, sin regenerarlo', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      const verdict = buildTechnicalVerdict({
        verdict: 'attention',
        confidence: 'medium',
      });
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
        verdict,
      );
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(
        analysisVerdictService.findResponseByAnalysisId,
      ).toHaveBeenCalledWith('analysis-1');
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ technicalVerdict: verdict }),
      );
      // El mock de AnalysisVerdictService solo expone findResponseByAnalysisId — si el runner
      // llamara a generateAndPersist (regenerar), esta llamada rompería con un TypeError acá.
    });

    it('PR 12A: veredicto status=failed se pasa tal cual — el runner no decide el contenido, solo lee', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      const verdict = buildTechnicalVerdict({
        status: 'failed',
        verdict: null,
        confidence: null,
        summary: null,
      });
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
        verdict,
      );
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ technicalVerdict: verdict }),
      );
    });

    it('PR 12A: sin veredicto todavía y el run terminó hace menos de 10 minutos, NO manda el mail (espera al próximo ciclo)', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
        completedAt: new Date(Date.now() - 60 * 1000), // hace 1 minuto
      });
      runRepository.find.mockResolvedValue([run]);
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(null);

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      // No es un fallo: el run sigue 'completed' sin emailSentAt para que el próximo ciclo reintente.
      expect(runRepository.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('PR 12A: sin veredicto y pasados los 10 minutos de espera, manda el mail igual sin la sección', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
        completedAt: new Date(Date.now() - 11 * 60 * 1000), // hace 11 minutos
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(null);
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ technicalVerdict: null }),
      );
    });

    it('PR 12A: sin veredicto y sin completedAt (dato inesperado), no bloquea — manda el mail sin veredicto', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
        completedAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(null);
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ technicalVerdict: null }),
      );
    });

    it('un fallo reconciliando un run no frena la reconciliación del resto', async () => {
      const broken = buildRun({
        id: 'run-broken',
        status: 'processing',
        analysisId: 'analysis-broken',
      });
      const healthy = buildRun({
        id: 'run-healthy',
        status: 'processing',
        analysisId: 'analysis-healthy',
      });
      runRepository.find.mockResolvedValue([broken, healthy]);

      analysisService.findOne.mockImplementation((id: string) => {
        if (id === 'analysis-broken') {
          return Promise.reject(new Error('DB caída'));
        }
        return Promise.resolve(buildAnalysis({ id, status: 'Finalizado' }));
      });
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await expect(service.reconcilePendingRuns()).resolves.toBeUndefined();

      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });
  });

  // FIX: recuperación de snapshot faltante después de una falla transitoria de
  // createFromAnalysis. Ver docstring de la clase para el detalle del bug original: un run que
  // pasaba a 'completed' antes de que el snapshot terminara de crearse quedaba huérfano para
  // siempre, porque la creación solo vivía dentro de la rama 'processing' de reconcileRun.
  describe('FIX: recuperación de snapshot faltante entre ciclos de reconciliación', () => {
    it('CASO 1/9 — dos ciclos reales: processing+Finalizado con falla inicial del snapshot, el segundo ciclo lo recupera y manda el email sin volver a llamar a runFieldAnalysis', async () => {
      const run = buildRun({ status: 'processing', analysisId: 'analysis-1' });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const recoveredSnapshot = buildSnapshot({ id: 'snapshot-recovered' });

      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(analysis);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      // Ciclo 1: el Analysis ya está Finalizado, pero createFromAnalysis falla transitoriamente
      // (ej. DB caída un instante) — no hay snapshot todavía visible para nadie.
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      weeklySnapshotService.createFromAnalysis.mockRejectedValueOnce(
        new Error('DB caída'),
      );

      await service.reconcilePendingRuns();

      // Estado realista tras el ciclo 1 — el mismo objeto `run` que reconcileRun mutó
      // directamente, no un estado inventado a mano para el ciclo 2.
      expect(run.status).toBe('completed');
      expect(run.emailSentAt).toBeNull();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();

      // Ciclo 2: mismo run, ya persistido 'completed' — reconcilePendingRuns vuelve a encontrarlo
      // (el query de arriba incluye 'completed'). createFromAnalysis ahora funciona. El chequeo de
      // existencia de ensureSnapshot (primera llamada de este ciclo) todavía debe ver "no existe"
      // — recién después de crearlo, la lectura de sendCompletionEmail lo debe ver disponible.
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.createFromAnalysis.mockResolvedValueOnce(
        recoveredSnapshot,
      );
      weeklySnapshotService.findByScheduledRunId
        .mockResolvedValueOnce(null)
        .mockResolvedValue(recoveredSnapshot);

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(2);
      // La recuperación usa el Analysis YA persistido (mismo id, releído dos veces por
      // analysisService.findOne) — nunca dispara un análisis satelital nuevo.
      expect(analysisService.findOne).toHaveBeenCalledTimes(2);
      expect(analysisService.findOne).toHaveBeenLastCalledWith('analysis-1');
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('completed');
      expect(run.emailSentAt).toBeInstanceOf(Date);
    });

    it('CASO 2 — run ya persistido como completed sin snapshot (equivalente a un reinicio del proceso): recupera usando el Analysis persistido', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        completedAt: new Date('2026-08-24T12:00:00Z'),
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-restart' });

      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId
        .mockResolvedValueOnce(null) // ensureSnapshot: todavía no existe
        .mockResolvedValue(snapshot); // sendCompletionEmail: ya se acaba de crear
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(analysisService.findOne).toHaveBeenCalledWith('analysis-1');
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1' }),
        analysis,
      );
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });

    it('CASO 3 — si el snapshot ya existe para esta corrida, se reutiliza y no se vuelve a crear ni a releer el Analysis', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const existingSnapshot = buildSnapshot({ id: 'snapshot-existing' });
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(
        existingSnapshot,
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).not.toHaveBeenCalled();
      expect(analysisService.findOne).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledWith(
        'user@example.com',
        expect.objectContaining({ weekStart: existingSnapshot.weekStart }),
      );
    });

    it('CASO 4 — falla persistente de createFromAnalysis a través de varios ciclos: nunca manda el email de éxito ni reintenta el análisis satelital', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });

      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockRejectedValue(
        new Error('DB caída permanentemente'),
      );

      await service.reconcilePendingRuns();
      await service.reconcilePendingRuns();
      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(3);
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      // El Analysis exitoso no se convierte en Error por esto, y la corrida sigue siendo
      // recuperable en el próximo ciclo (no se la marca 'failed').
      expect(run.status).toBe('completed');
    });

    it('CASO 5a — dos ciclos SECUENCIALES (no concurrentes) para la misma corrida no duplican la creación del snapshot', async () => {
      // Este test corre dos reconcilePendingRuns() uno detrás del otro (await consecutivos) — NO
      // demuestra concurrencia real, solo que el segundo ciclo reutiliza lo que el primero ya
      // creó. La intercalación genuina de dos reconciliaciones REALMENTE solapadas (con la ventana
      // TOCTOU real de "ambas ven 'no existe' antes de que cualquiera cree") está en CASO 9 más
      // abajo, con una barrera de sincronización — no con awaits consecutivos sobre un único
      // objeto mutable compartido.
      //
      // La protección exacta contra la carrera a nivel fila (unique(fieldId, weekStart, weekEnd)
      // + catch de 23505) vive en WeeklyAnalysisSnapshotService.createFromAnalysis y ya está
      // cubierta en weekly-analysis-snapshot.service.spec.ts; también se reprodujo el error 23505
      // real contra PostgreSQL en una transacción aislada (ver entrega) — eso prueba que el índice
      // único rechaza filas duplicadas, no que la reconciliación completa (snapshot + diagnóstico +
      // email) sea libre de duplicados bajo concurrencia real: ver CASO 9 para esa distinción.
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-race' });

      runRepository.find.mockResolvedValue([run]);
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      // Ciclo "1": todavía no hay snapshot en ninguna de las dos lecturas de este mismo tick.
      weeklySnapshotService.findByScheduledRunId
        .mockResolvedValueOnce(null) // ensureSnapshot
        .mockResolvedValueOnce(null) // sendCompletionEmail (simula que la escritura del create
        //   todavía no es visible para esta lectura — mismo tick, sin reordenar mágicamente)
        .mockResolvedValue(snapshot); // desde acá en adelante, ya visible.

      await service.reconcilePendingRuns();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();

      // Ciclo "2" (siguiente, secuencial): el snapshot ya está visible.
      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(1);
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });

    it('CASO 9 — dos reconciliaciones REALMENTE solapadas (barrera de sincronización, dos instancias independientes de la misma fila) con schedule ACTIVO: la creación y el diagnóstico se disparan dos veces (idempotentes por su cuenta, no por el runner) y el email SÍ puede duplicarse — riesgo preexistente, no introducido ni ampliado por este fix', async () => {
      // "Dos instancias independientes de la misma fila" — rowA y rowB NO son el mismo objeto: así
      // como dos SELECTs concurrentes en Postgres devolverían dos copias independientes de la
      // misma fila, este test no comparte un único run mutable entre las dos reconciliaciones, así
      // que ninguna mutación de un lado se filtra mágicamente al otro.
      const rowA = buildRun({
        id: 'run-1',
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const rowB = buildRun({
        id: 'run-1',
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-concurrent' });

      analysisService.findOne.mockResolvedValue(analysis);
      // createFromAnalysis mockeado como éxito para AMBAS llamadas (nunca como un 23505 crudo):
      // así se comporta la implementación real bajo una carrera — el "perdedor" no ve un error,
      // WeeklyAnalysisSnapshotService.createFromAnalysis atrapa el 23505 y vuelve a leer la fila
      // ganadora (ver su propio catch, cubierto en weekly-analysis-snapshot.service.spec.ts) — acá
      // se mockea directamente ese resultado final en vez de reimplementar ese catch en este spec.
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      // Barrera real: las DOS primeras llamadas a findByScheduledRunId (el chequeo de existencia
      // de ensureSnapshot, una por cada reconciliación) quedan suspendidas hasta que ambas
      // lleguen — ninguna ve el snapshot creado por la otra todavía. Llamadas posteriores (las de
      // sendCompletionEmail, después de que ambas ya crearon/confirmaron el snapshot) sí lo ven.
      const existenceCheckBarrier = createBarrier(2);
      let findByScheduledRunIdCalls = 0;
      weeklySnapshotService.findByScheduledRunId.mockImplementation(
        async () => {
          findByScheduledRunIdCalls += 1;
          if (findByScheduledRunIdCalls <= 2) {
            await existenceCheckBarrier.arrive();
            return null;
          }
          return snapshot;
        },
      );

      runRepository.find
        .mockImplementationOnce(() => Promise.resolve([rowA]))
        .mockImplementationOnce(() => Promise.resolve([rowB]));

      await Promise.all([
        service.reconcilePendingRuns(),
        service.reconcilePendingRuns(),
      ]);

      // Ambas reconciliaciones vieron "no existe" antes de que cualquiera creara — el runner NO
      // deduplica esto por su cuenta (no hay un chequeo adicional entre el existence-check y el
      // create), así que createFromAnalysis se llama dos veces. Que esto no produzca dos filas
      // reales es una garantía de WeeklyAnalysisSnapshotService (unique(fieldId, weekStart,
      // weekEnd) + catch de 23505), no de este método — no se reafirma acá, ya está cubierta por
      // separado (ver comentario de CASO 5a).
      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(2);

      // El diagnóstico semanal también se dispara dos veces por la misma razón. No se duplica en
      // la fila real porque WeeklyTechnicalVerdictService.generateAndPersist es un find-then-merge
      // idempotente por unique(snapshotId) (ver su propio docstring) — una garantía preexistente y
      // ajena a este fix, no algo que el runner deduplique.
      expect(
        weeklyTechnicalVerdictService.generateAndPersist,
      ).toHaveBeenCalledTimes(2);

      // Riesgo preexistente, NO introducido ni ampliado por este fix: sendCompletionEmail no tiene
      // ninguna escritura atómica tipo "UPDATE ... WHERE emailSentAt IS NULL" — solo lee
      // emailSentAt en memoria y escribe después. Dos instancias independientes de la misma fila
      // que llegan a este punto en paralelo pueden, ambas, ver emailSentAt=null y mandar el email.
      // Este test lo hace visible en vez de esconderlo: documenta el estado ACTUAL (sin cambios de
      // este fix), no una garantía nueva. Ver entrega: "riesgos preexistentes".
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(2);
    });

    it('CASO 9b — dos reconciliaciones REALMENTE solapadas con schedule DESHABILITADO: el snapshot histórico se recupera en ambas, pero el email NUNCA se envía bajo ninguna intercalación', async () => {
      const rowA = buildRun({
        id: 'run-1',
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const rowB = buildRun({
        id: 'run-1',
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-concurrent-disabled' });

      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      const existenceCheckBarrier = createBarrier(2);
      let findByScheduledRunIdCalls = 0;
      weeklySnapshotService.findByScheduledRunId.mockImplementation(
        async () => {
          findByScheduledRunIdCalls += 1;
          if (findByScheduledRunIdCalls <= 2) {
            await existenceCheckBarrier.arrive();
            return null;
          }
          return snapshot;
        },
      );

      runRepository.find
        .mockImplementationOnce(() => Promise.resolve([rowA]))
        .mockImplementationOnce(() => Promise.resolve([rowB]));

      await Promise.all([
        service.reconcilePendingRuns(),
        service.reconcilePendingRuns(),
      ]);

      // La garantía que SÍ aporta este fix: sin importar la intercalación, con el schedule
      // deshabilitado nunca se llega a sendCompletionEmail — a diferencia del riesgo de CASO 9,
      // acá no hay ninguna ventana de doble envío posible porque directamente no hay envío.
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();

      // Ambas instancias recuperaron (o confirmaron) el snapshot histórico igual, a pesar del
      // schedule desactivado — el objetivo central de este fix.
      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(2);

      // Ambas instancias, al ver el snapshot resuelto y el schedule desactivado, se retiran de
      // reconciliación futura — no queda nada más pendiente para esta corrida.
      expect(rowA.status).toBe('failed');
      expect(rowB.status).toBe('failed');
    });

    it('CASO 6a — Analysis inexistente para el analysisId persistido: tratamiento explícito, no crashea, no manda email, y SIGUE consultándose en el ciclo siguiente (no se deja de reintentar)', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-borrado',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockRejectedValue(
        new NotFoundException('Análisis no encontrado.'),
      );

      await expect(service.reconcilePendingRuns()).resolves.toBeUndefined();

      expect(weeklySnapshotService.createFromAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(run.status).toBe('completed');
      expect(analysisService.findOne).toHaveBeenCalledTimes(1);

      // No hay ninguna marca en el run que lo excluya de reconcilePendingRuns por esto — sigue
      // 'completed', así que el ciclo siguiente vuelve a intentarlo. Se demuestra en vez de
      // afirmarlo: la dependencia inexistente se sigue consultando, con el mismo costo que
      // cualquier otra dependencia todavía sin resolver (no hay "dejar de reintentar" real, solo
      // un mensaje de log más explícito que el de una falla transitoria genérica).
      await service.reconcilePendingRuns();
      expect(analysisService.findOne).toHaveBeenCalledTimes(2);
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
    });

    it('CASO 6b — Analysis persistido en un estado incompatible (no Finalizado): tratamiento explícito (mensaje propio, distinto del genérico de falla transitoria), sin convertir el run en failed', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockResolvedValue(
        buildAnalysis({ status: 'Error', errorMessage: 'Fallo worker' }),
      );

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      // ScheduledAnalysisRun.status y Analysis.status son máquinas de estado distintas (ver
      // 13-weekly-monitoring.md) — esto no "corrige" retroactivamente un run ya completado.
      expect(run.status).toBe('completed');
    });

    it('CASO 7 — schedule deshabilitado: conserva la política de no enviar email, pero igual crea el snapshot como registro histórico del Analysis', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-disabled-schedule' });

      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1' }),
        analysis,
      );
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: expect.stringContaining('desactivado'),
        }),
      );
    });

    it('CASO 7b — schedule deshabilitado + falla inicial del snapshot: el run NO se marca failed en el primer ciclo (repetiría el bug original encubierto por el schedule apagado), y el segundo ciclo recupera el snapshot histórico sin mandar nunca el email', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-disabled-recovered' });

      analysisService.findOne.mockResolvedValue(analysis);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());

      // Ciclo 1: schedule ya deshabilitado, y createFromAnalysis falla transitoriamente.
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      weeklySnapshotService.createFromAnalysis.mockRejectedValueOnce(
        new Error('DB caída'),
      );

      await service.reconcilePendingRuns();

      // ANTES de este fix, esta rama marcaba 'failed' sin importar si ensureSnapshot había
      // conseguido el snapshot — eso sacaba el run para siempre de reconcilePendingRuns y el
      // registro histórico quedaba huérfano. Ahora, sin snapshot todavía, el run se conserva
      // 'completed' para poder reintentarlo.
      expect(run.status).toBe('completed');
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();

      // Ciclo 2: mismo run, ya persistido 'completed' (mutado directamente en el ciclo 1, estado
      // realista entre ciclos) — createFromAnalysis ahora funciona.
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.createFromAnalysis.mockResolvedValueOnce(snapshot);

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(2);
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      // El snapshot histórico se recuperó — ya no queda nada pendiente para este run, así que
      // recién ahora es seguro sacarlo de reconciliación futura.
      expect(run.status).toBe('failed');
      // En NINGÚN momento, en ninguno de los dos ciclos, se mandó el email.
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
    });

    it('CASO 7c — el schedule se deshabilita ENTRE el primer y el segundo ciclo: el snapshot se recupera en el segundo pero el email nunca sale', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-disabled-mid-flight' });

      analysisService.findOne.mockResolvedValue(analysis);
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());

      // Ciclo 1: schedule TODAVÍA activo, pero createFromAnalysis falla transitoriamente (el
      // usuario ni siquiera desactivó nada todavía — la falla es independiente de eso).
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      weeklySnapshotService.createFromAnalysis.mockRejectedValueOnce(
        new Error('DB caída'),
      );
      scheduleRepository.findOne.mockResolvedValueOnce(
        buildSchedule({ enabled: true }),
      );

      await service.reconcilePendingRuns();

      expect(run.status).toBe('completed');
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();

      // Entre ciclo 1 y ciclo 2, el usuario desactiva el seguimiento semanal. Ciclo 2:
      // createFromAnalysis ahora funciona, pero el schedule ya está desactivado.
      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.createFromAnalysis.mockResolvedValueOnce(snapshot);
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'run-1' }),
        analysis,
      );
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      expect(run.status).toBe('failed');
      expect(run.errorMessage).toContain('desactivado');
    });

    it('CASO 7d — falla persistente de createFromAnalysis con schedule deshabilitado a través de varios ciclos: nunca se marca failed (conserva la posibilidad de recuperación) y nunca envía email', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });

      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId.mockResolvedValue(null);
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockRejectedValue(
        new Error('DB caída permanentemente'),
      );
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      await service.reconcilePendingRuns();
      await service.reconcilePendingRuns();
      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(3);
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
      // Sigue 'completed' — nunca se la marca 'failed' mientras el snapshot siga sin resolverse,
      // así que la posibilidad de recuperación se conserva indefinidamente.
      expect(run.status).toBe('completed');
    });

    it('CASO 8 — si el diagnóstico semanal falla durante la recuperación, el snapshot igual queda disponible y el email sale con normalidad', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: null,
      });
      const analysis = buildAnalysis({ status: 'Finalizado' });
      const snapshot = buildSnapshot({ id: 'snapshot-diag-fails' });

      runRepository.find.mockResolvedValue([run]);
      weeklySnapshotService.findByScheduledRunId
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot);
      analysisService.findOne.mockResolvedValue(analysis);
      weeklySnapshotService.createFromAnalysis.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.generateAndPersist.mockRejectedValue(
        new Error('falló la generación'),
      );
      fieldsService.findByIdOrFail.mockResolvedValue(buildField());
      usersService.findById.mockResolvedValue(buildUser());
      emailService.sendScheduledAnalysisEmail.mockResolvedValue({
        sent: true,
        provider: 'resend',
        dryRun: false,
      });

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.createFromAnalysis).toHaveBeenCalledTimes(1);
      expect(emailService.sendScheduledAnalysisEmail).toHaveBeenCalledTimes(1);
    });

    it('CASO 10 — si el email ya se mandó, no vuelve a chequear/crear el snapshot ni a releer el Analysis (nunca una segunda oportunidad de envío)', async () => {
      const run = buildRun({
        status: 'completed',
        analysisId: 'analysis-1',
        emailSentAt: new Date(),
      });
      runRepository.find.mockResolvedValue([run]);

      await service.reconcilePendingRuns();

      expect(weeklySnapshotService.findByScheduledRunId).not.toHaveBeenCalled();
      expect(weeklySnapshotService.createFromAnalysis).not.toHaveBeenCalled();
      expect(analysisService.findOne).not.toHaveBeenCalled();
      expect(emailService.sendScheduledAnalysisEmail).not.toHaveBeenCalled();
    });
  });

  describe('runNow', () => {
    it('rechaza un campo ajeno', async () => {
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(service.runNow('field-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rechaza si el campo no tiene schedule configurado', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(null);

      await expect(service.runNow('field-1', 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('FIX: rechaza con 400 si el schedule existe pero está desactivado, sin llamar a AnalysisService', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ enabled: false }),
      );

      await expect(service.runNow('field-1', 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
      expect(runRepository.create).not.toHaveBeenCalled();
      expect(runRepository.save).not.toHaveBeenCalled();
    });

    it('dispara triggerRun forzando el informe completo (fase 4D), sin importar los flags guardados', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({
          includeMapAssets: false,
          includeIndexImages: false,
          includeImageSeries: false,
        }),
      );
      runRepository.findOne.mockResolvedValue(null);
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      await service.runNow('field-1', 'user-A');

      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        expect.objectContaining({
          includeMapAssets: true,
          includeIndexImages: true,
          includeImageSeries: true,
        }),
        'user-A',
      );
    });

    it('FASE 4D: "Ejecutar ahora" usa la misma ventana móvil que el dispatcher automático', async () => {
      fieldsService.findOne.mockResolvedValue(
        buildField({ startDate: '2019-01-01', endDate: '2020-01-01' }),
      );
      scheduleRepository.findOne.mockResolvedValue(
        buildSchedule({ timezone: 'America/Argentina/Cordoba' }),
      );
      runRepository.findOne.mockResolvedValue(null);
      analysisService.runFieldAnalysis.mockResolvedValue(buildAnalysis());

      const before = new Date();
      await service.runNow('field-1', 'user-A');

      const [, payload] = analysisService.runFieldAnalysis.mock.calls[0];
      const expectedRange = computeScheduledAnalysisDateRange(before, {
        timezone: 'America/Argentina/Cordoba',
      });
      // runNow usa `new Date()` internamente — comparamos contra una ventana calculada con un
      // timestamp tomado inmediatamente antes, que cae en el mismo día salvo un cruce de
      // medianoche exactamente durante el test (ventana infinitesimal, no vale la pena mockear
      // el reloj acá solo para eso).
      expect(payload).toEqual(
        expect.objectContaining({
          startDate: expectedRange.startDate,
          endDate: expectedRange.endDate,
        }),
      );
    });

    it('no duplica si ya hay una corrida para la semana actual', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(buildSchedule());
      const existingRun = buildRun({ status: 'processing' });
      runRepository.findOne.mockResolvedValue(existingRun);

      const result = await service.runNow('field-1', 'user-A');

      expect(result).toBe(existingRun);
      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
    });
  });
});
