import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { In } from 'typeorm';

import { WeeklyAnalysisSnapshot } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { WeeklyTechnicalVerdictService } from './weekly-technical-verdict.service';
import { ClaudeWeeklyTechnicalVerdictGenerator } from './generators/claude-weekly-technical-verdict.generator';
import { DeterministicWeeklyTechnicalVerdictGenerator } from './generators/deterministic-weekly-technical-verdict.generator';
import { WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION } from './generators/weekly-technical-verdict-prompt';
import { WeeklyTechnicalVerdict } from './entities/weekly-technical-verdict.entity';

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  merge: jest.Mock;
  save: jest.Mock;
};

const DETERMINISTIC_RESULT = {
  verdict: 'favorable' as const,
  trend: 'stable' as const,
  confidence: 'high' as const,
  summary: 'deterministic summary',
  keyChanges: ['change'],
  areasToReview: [],
  recommendations: ['recommendation'],
  limitations: ['limitation'],
};

const CLAUDE_RESULT = {
  verdict: 'attention' as const,
  trend: 'worsening' as const,
  confidence: 'medium' as const,
  summary: 'claude summary',
  keyChanges: ['claude change'],
  areasToReview: ['claude area'],
  recommendations: ['claude recommendation'],
  limitations: ['claude limitation'],
};

describe('WeeklyTechnicalVerdictService', () => {
  let service: WeeklyTechnicalVerdictService;
  let verdictRepository: MockRepo;
  let configGetMock: jest.Mock;
  let deterministicGenerate: jest.Mock;
  let claudeGenerate: jest.Mock;

  const buildSnapshot = (
    overrides: Partial<WeeklyAnalysisSnapshot> = {},
  ): WeeklyAnalysisSnapshot =>
    ({
      id: 'snapshot-1',
      fieldId: 'field-1',
      userId: 'user-1',
      analysisId: 'analysis-1',
      scheduledRunId: 'run-1',
      weekStart: '2026-08-18',
      weekEnd: '2026-08-25',
      score: 60,
      scoreLabel: 'Atención',
      ndviMean: 0.6,
      ndmiMean: 0.2,
      dominantZone: 'Alta',
      dominantZonePercentage: 40,
      analyzedAreaHa: 100,
      lotCount: 3,
      dataQualityStatus: 'sufficient',
      hasRgbImage: true,
      hasNdviImage: true,
      hasNdmiImage: true,
      hasImageSeries: false,
      comparisonVsPrevious: {
        previousSnapshotId: 'snapshot-0',
        previousWeekStart: '2026-08-11',
        previousWeekEnd: '2026-08-18',
        scoreDelta: -5,
        ndviMeanDelta: null,
        ndmiMeanDelta: null,
        dominantZoneChanged: false,
        dominantZoneFrom: 'Alta',
        dominantZoneTo: 'Alta',
        analyzedAreaDeltaHa: null,
        dataQualityChanged: false,
        summary: ['El score bajó 5 puntos respecto de la semana anterior.'],
      },
      ...overrides,
    }) as WeeklyAnalysisSnapshot;

  const setProvider = (value: string | undefined) => {
    configGetMock.mockImplementation((key: string) =>
      key === 'WEEKLY_TECHNICAL_VERDICT_PROVIDER' ? value : undefined,
    );
  };

  beforeEach(async () => {
    configGetMock = jest.fn().mockReturnValue(undefined);
    deterministicGenerate = jest.fn().mockResolvedValue(DETERMINISTIC_RESULT);
    claudeGenerate = jest.fn().mockResolvedValue(CLAUDE_RESULT);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyTechnicalVerdictService,
        {
          provide: getRepositoryToken(WeeklyTechnicalVerdict),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn((data) => data),
            merge: jest.fn((existing, data) => ({ ...existing, ...data })),
            save: jest.fn((entity) => Promise.resolve(entity)),
          },
        },
        { provide: ConfigService, useValue: { get: configGetMock } },
        {
          provide: DeterministicWeeklyTechnicalVerdictGenerator,
          useValue: {
            generatorName: 'deterministic-v1',
            promptVersion: null,
            modelId: null,
            generate: deterministicGenerate,
          },
        },
        {
          provide: ClaudeWeeklyTechnicalVerdictGenerator,
          useValue: {
            generatorName: 'claude',
            promptVersion: WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
            modelId: 'claude-haiku-4-5',
            generate: claudeGenerate,
          },
        },
      ],
    }).compile();

    service = module.get(WeeklyTechnicalVerdictService);
    verdictRepository = module.get(getRepositoryToken(WeeklyTechnicalVerdict));
  });

  describe('provider selection', () => {
    it('sin WEEKLY_TECHNICAL_VERDICT_PROVIDER seteado, usa deterministic', async () => {
      setProvider(undefined);
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildSnapshot(), {
        fieldName: 'Campo Norte',
        individualVerdict: null,
      });

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });

    it('WEEKLY_TECHNICAL_VERDICT_PROVIDER=claude usa el generador Claude', async () => {
      setProvider('claude');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildSnapshot(), {
        fieldName: 'Campo Norte',
        individualVerdict: null,
      });

      expect(claudeGenerate).toHaveBeenCalledTimes(1);
      expect(deterministicGenerate).not.toHaveBeenCalled();
      expect(result.generator).toBe('claude');
      expect(result.promptVersion).toBe(
        WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
      );
    });

    it('provider desconocido cae a deterministic con warning, sin romper', async () => {
      setProvider('gpt4');
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });

    it('no depende de TECHNICAL_VERDICT_PROVIDER (env distinta, nunca leída acá)', async () => {
      configGetMock.mockImplementation((key: string) =>
        key === 'TECHNICAL_VERDICT_PROVIDER' ? 'claude' : undefined,
      );
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });
  });

  describe('generateAndPersist — camino feliz', () => {
    it('guarda status=generated con los campos del generador', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildSnapshot(), {
        fieldName: 'Campo Norte',
        individualVerdict: null,
      });

      expect(result.status).toBe('generated');
      expect(result.verdict).toBe('favorable');
      expect(result.trend).toBe('stable');
      expect(result.generator).toBe('deterministic-v1');
      expect(result.generatedAt).toBeInstanceOf(Date);
    });

    it('persiste previousSnapshotId/analysisId/scheduledRunId denormalizados desde el snapshot', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(
        buildSnapshot({ analysisId: 'analysis-9', scheduledRunId: 'run-9' }),
        { fieldName: null, individualVerdict: null },
      );

      expect(result.analysisId).toBe('analysis-9');
      expect(result.scheduledRunId).toBe('run-9');
      expect(result.previousSnapshotId).toBe('snapshot-0');
    });

    it('no depende del technicalVerdict individual — genera igual con individualVerdict=null', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(result.status).toBe('generated');
    });

    it('unique/upsert por snapshotId: si ya existe una fila, la actualiza en vez de crear una nueva', async () => {
      setProvider('deterministic');
      const existing = {
        id: 'weekly-verdict-1',
        snapshotId: 'snapshot-1',
        status: 'generated',
      } as WeeklyTechnicalVerdict;
      verdictRepository.findOne.mockResolvedValue(existing);

      await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(verdictRepository.create).not.toHaveBeenCalled();
      expect(verdictRepository.merge).toHaveBeenCalledWith(
        existing,
        expect.objectContaining({ status: 'generated' }),
      );
    });
  });

  describe('generateAndPersist — camino de error', () => {
    it('si el generador falla, persiste status=failed con contenido placeholder seguro (nunca null)', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);
      deterministicGenerate.mockRejectedValue(
        new Error('regla de negocio inesperada'),
      );

      const result = await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(result.status).toBe('failed');
      expect(result.verdict).toBe('insufficient_data');
      expect(result.trend).toBe('insufficient_data');
      expect(result.confidence).toBe('low');
      expect(result.keyChanges).toEqual([]);
      expect(result.generatedAt).toBeNull();
      expect(result.errorMessage).toBe('regla de negocio inesperada');
    });

    it('no relanza el error del generador — generateAndPersist resuelve igual', async () => {
      setProvider('claude');
      verdictRepository.findOne.mockResolvedValue(null);
      claudeGenerate.mockRejectedValue(
        new Error('ANTHROPIC_API_KEY no está configurada'),
      );

      await expect(
        service.generateAndPersist(buildSnapshot(), {
          fieldName: null,
          individualVerdict: null,
        }),
      ).resolves.toMatchObject({ status: 'failed' });
    });

    it('un mensaje de error larguísimo se trunca', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);
      deterministicGenerate.mockRejectedValue(new Error('x'.repeat(1000)));

      const result = await service.generateAndPersist(buildSnapshot(), {
        fieldName: null,
        individualVerdict: null,
      });

      expect(result.errorMessage!.length).toBeLessThan(1000);
      expect(result.errorMessage!.endsWith('…')).toBe(true);
    });

    it('propaga el error tal cual si hasta guardar la fila failed falla (infraestructura) — el caller pone la red final', async () => {
      setProvider('deterministic');
      deterministicGenerate.mockRejectedValue(
        new Error('regla de negocio inesperada'),
      );
      verdictRepository.findOne.mockRejectedValue(new Error('DB caída'));

      await expect(
        service.generateAndPersist(buildSnapshot(), {
          fieldName: null,
          individualVerdict: null,
        }),
      ).rejects.toThrow('DB caída');
    });
  });

  describe('findResponseBySnapshotId', () => {
    it('devuelve null si no hay diagnóstico semanal para ese snapshotId', async () => {
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.findResponseBySnapshotId('snapshot-1');

      expect(result).toBeNull();
    });

    it('mapea la entidad al shape de respuesta (arrays nunca null, generatedAt como ISO string)', async () => {
      verdictRepository.findOne.mockResolvedValue({
        status: 'generated',
        verdict: 'favorable',
        trend: 'stable',
        confidence: 'high',
        summary: 'ok',
        keyChanges: ['a'],
        areasToReview: null,
        recommendations: ['b'],
        limitations: ['c'],
        previousSnapshotId: 'snapshot-0',
        generator: 'deterministic-v1',
        promptVersion: null,
        errorMessage: null,
        generatedAt: new Date('2026-08-25T00:00:00.000Z'),
      } as any);

      const result = await service.findResponseBySnapshotId('snapshot-1');

      expect(result).toEqual({
        status: 'generated',
        verdict: 'favorable',
        trend: 'stable',
        confidence: 'high',
        summary: 'ok',
        keyChanges: ['a'],
        areasToReview: [],
        recommendations: ['b'],
        limitations: ['c'],
        previousSnapshotId: 'snapshot-0',
        generatedAt: '2026-08-25T00:00:00.000Z',
        generator: 'deterministic-v1',
        promptVersion: null,
        errorMessage: null,
      });
    });
  });

  describe('findResponsesBySnapshotIds (batch)', () => {
    it('con la lista vacía, no consulta la DB (evita un IN vacío)', async () => {
      const result = await service.findResponsesBySnapshotIds([]);

      expect(result.size).toBe(0);
      expect(verdictRepository.find).not.toHaveBeenCalled();
    });

    it('devuelve un Map<snapshotId, respuesta> con una sola query', async () => {
      verdictRepository.find.mockResolvedValue([
        {
          snapshotId: 'snapshot-1',
          status: 'generated',
          verdict: 'favorable',
          trend: 'stable',
          confidence: 'high',
          summary: 'ok',
          keyChanges: [],
          areasToReview: [],
          recommendations: [],
          limitations: [],
          previousSnapshotId: null,
          generator: 'deterministic-v1',
          promptVersion: null,
          errorMessage: null,
          generatedAt: null,
        },
        {
          snapshotId: 'snapshot-2',
          status: 'failed',
          verdict: 'insufficient_data',
          trend: 'insufficient_data',
          confidence: 'low',
          summary: 'no',
          keyChanges: [],
          areasToReview: [],
          recommendations: [],
          limitations: [],
          previousSnapshotId: null,
          generator: 'claude',
          promptVersion: WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
          errorMessage: 'boom',
          generatedAt: null,
        },
      ] as any);

      const result = await service.findResponsesBySnapshotIds([
        'snapshot-1',
        'snapshot-2',
      ]);

      expect(verdictRepository.find).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(2);
      expect(result.get('snapshot-1')?.status).toBe('generated');
      expect(result.get('snapshot-2')?.errorMessage).toBe('boom');
    });
  });

  describe('findResponsesByScheduledRunIds (batch, PR 16D)', () => {
    it('con la lista vacía, no consulta la DB (evita un IN vacío)', async () => {
      const result = await service.findResponsesByScheduledRunIds([]);

      expect(result.size).toBe(0);
      expect(verdictRepository.find).not.toHaveBeenCalled();
    });

    it('devuelve un Map<scheduledRunId, respuesta> con una sola query', async () => {
      verdictRepository.find.mockResolvedValue([
        {
          snapshotId: 'snapshot-1',
          scheduledRunId: 'run-1',
          status: 'generated',
          verdict: 'favorable',
          trend: 'stable',
          confidence: 'high',
          summary: 'ok',
          keyChanges: [],
          areasToReview: [],
          recommendations: [],
          limitations: [],
          previousSnapshotId: null,
          generator: 'deterministic-v1',
          promptVersion: null,
          errorMessage: null,
          generatedAt: null,
        },
        {
          snapshotId: 'snapshot-2',
          scheduledRunId: 'run-2',
          status: 'failed',
          verdict: 'insufficient_data',
          trend: 'insufficient_data',
          confidence: 'low',
          summary: 'no',
          keyChanges: [],
          areasToReview: [],
          recommendations: [],
          limitations: [],
          previousSnapshotId: null,
          generator: 'claude',
          promptVersion: WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
          errorMessage: 'boom',
          generatedAt: null,
        },
      ] as any);

      const result = await service.findResponsesByScheduledRunIds([
        'run-1',
        'run-2',
      ]);

      expect(verdictRepository.find).toHaveBeenCalledTimes(1);
      expect(verdictRepository.find).toHaveBeenCalledWith({
        where: { scheduledRunId: In(['run-1', 'run-2']) },
      });
      expect(result.size).toBe(2);
      expect(result.get('run-1')?.status).toBe('generated');
      expect(result.get('run-2')?.errorMessage).toBe('boom');
    });

    it('nunca incluye una fila con scheduledRunId null (defensivo, no debería pasar en la práctica)', async () => {
      verdictRepository.find.mockResolvedValue([
        {
          snapshotId: 'snapshot-1',
          scheduledRunId: null,
          status: 'generated',
          verdict: 'favorable',
          trend: 'stable',
          confidence: 'high',
          summary: 'ok',
          keyChanges: [],
          areasToReview: [],
          recommendations: [],
          limitations: [],
          previousSnapshotId: null,
          generator: 'deterministic-v1',
          promptVersion: null,
          errorMessage: null,
          generatedAt: null,
        },
      ] as any);

      const result = await service.findResponsesByScheduledRunIds(['run-1']);

      expect(result.size).toBe(0);
    });
  });
});
