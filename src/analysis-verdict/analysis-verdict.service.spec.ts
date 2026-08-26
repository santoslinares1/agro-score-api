import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisVerdictService } from './analysis-verdict.service';
import { ClaudeTechnicalVerdictGenerator } from './generators/claude-technical-verdict.generator';
import { DeterministicTechnicalVerdictGenerator } from './generators/deterministic-technical-verdict.generator';
import { TECHNICAL_VERDICT_PROMPT_VERSION } from './generators/technical-verdict-prompt';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';

type MockRepo = {
  findOne: jest.Mock;
  create: jest.Mock;
  merge: jest.Mock;
  save: jest.Mock;
};

const DETERMINISTIC_RESULT = {
  verdict: 'favorable' as const,
  confidence: 'high' as const,
  summary: 'deterministic summary',
  keyFindings: ['finding'],
  possibleCauses: ['cause'],
  recommendations: ['recommendation'],
  limitations: ['limitation'],
};

const CLAUDE_RESULT = {
  verdict: 'attention' as const,
  confidence: 'medium' as const,
  summary: 'claude summary',
  keyFindings: ['claude finding'],
  possibleCauses: ['claude cause'],
  recommendations: ['claude recommendation'],
  limitations: ['claude limitation'],
};

describe('AnalysisVerdictService', () => {
  let service: AnalysisVerdictService;
  let verdictRepository: MockRepo;
  let configGetMock: jest.Mock;
  let deterministicGenerate: jest.Mock;
  let claudeGenerate: jest.Mock;

  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis =>
    ({
      id: 'analysis-1',
      globalScore: 80,
      ndviAverageMax: 0.7,
      ndviVariability: 'Media',
      resultJson: {
        mode: 'python-worker-v2',
        message: '',
        totalsByZone: [{ zone: 0, name: 'Alta', hectares: 10, percent: 100 }],
      } as any,
      ...overrides,
    }) as Analysis;

  const setProvider = (value: string | undefined) => {
    configGetMock.mockImplementation((key: string) =>
      key === 'TECHNICAL_VERDICT_PROVIDER' ? value : undefined,
    );
  };

  beforeEach(async () => {
    configGetMock = jest.fn().mockReturnValue(undefined);
    deterministicGenerate = jest.fn().mockResolvedValue(DETERMINISTIC_RESULT);
    claudeGenerate = jest.fn().mockResolvedValue(CLAUDE_RESULT);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalysisVerdictService,
        {
          provide: getRepositoryToken(AnalysisTechnicalVerdict),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            merge: jest.fn((existing, data) => ({ ...existing, ...data })),
            save: jest.fn((entity) => Promise.resolve(entity)),
          },
        },
        { provide: ConfigService, useValue: { get: configGetMock } },
        {
          provide: DeterministicTechnicalVerdictGenerator,
          useValue: {
            generatorName: 'deterministic-v1',
            promptVersion: null,
            modelId: null,
            generate: deterministicGenerate,
          },
        },
        {
          provide: ClaudeTechnicalVerdictGenerator,
          useValue: {
            generatorName: 'claude',
            promptVersion: TECHNICAL_VERDICT_PROMPT_VERSION,
            modelId: 'claude-haiku-4-5',
            generate: claudeGenerate,
          },
        },
      ],
    }).compile();

    service = module.get(AnalysisVerdictService);
    verdictRepository = module.get(
      getRepositoryToken(AnalysisTechnicalVerdict),
    );
  });

  describe('provider selection (PR 11B)', () => {
    it('sin TECHNICAL_VERDICT_PROVIDER seteado, usa deterministic', async () => {
      setProvider(undefined);
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildAnalysis());

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });

    it('TECHNICAL_VERDICT_PROVIDER=deterministic explícito usa deterministic', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildAnalysis());

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });

    it('TECHNICAL_VERDICT_PROVIDER=claude usa el generador Claude', async () => {
      setProvider('claude');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildAnalysis());

      expect(claudeGenerate).toHaveBeenCalledTimes(1);
      expect(deterministicGenerate).not.toHaveBeenCalled();
      expect(result.generator).toBe('claude');
      expect(result.promptVersion).toBe(TECHNICAL_VERDICT_PROMPT_VERSION);
    });

    it('TECHNICAL_VERDICT_PROVIDER=claude sin API key (el generador Claude rechaza) → status=failed, no rompe', async () => {
      setProvider('claude');
      verdictRepository.findOne.mockResolvedValue(null);
      claudeGenerate.mockRejectedValue(
        new Error(
          'ANTHROPIC_API_KEY no está configurada (requerida cuando TECHNICAL_VERDICT_PROVIDER=claude).',
        ),
      );

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('failed');
      expect(result.generator).toBe('claude');
      expect(result.errorMessage).toContain('ANTHROPIC_API_KEY');
    });

    it('valor de provider desconocido cae a deterministic (con warning, sin romper)', async () => {
      setProvider('gpt4');
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildAnalysis());

      expect(deterministicGenerate).toHaveBeenCalledTimes(1);
      expect(claudeGenerate).not.toHaveBeenCalled();
    });

    it('provider case-insensitive y con espacios ("Claude ") también resuelve a Claude', async () => {
      setProvider('Claude ');
      verdictRepository.findOne.mockResolvedValue(null);

      await service.generateAndPersist(buildAnalysis());

      expect(claudeGenerate).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateAndPersist — camino feliz', () => {
    it('deterministic: persiste status=generated con generator=deterministic-v1 y promptVersion=null', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('generated');
      expect(result.verdict).toBe('favorable');
      expect(result.generator).toBe('deterministic-v1');
      expect(result.promptVersion).toBeNull();
      expect(result.generatedAt).toBeInstanceOf(Date);
    });

    it('claude: persiste status=generated con generator=claude, promptVersion vigente, e inputSnapshot.model', async () => {
      setProvider('claude');
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('generated');
      expect(result.verdict).toBe('attention');
      expect(result.generator).toBe('claude');
      expect(result.promptVersion).toBe(TECHNICAL_VERDICT_PROMPT_VERSION);
      expect((result.inputSnapshot as any).model).toBe('claude-haiku-4-5');
    });

    it('si ya existe una fila para el analysisId, la actualiza en vez de crear una nueva (idempotente)', async () => {
      setProvider('deterministic');
      const existing = {
        id: 'verdict-1',
        analysisId: 'analysis-1',
        status: 'generated',
      } as AnalysisTechnicalVerdict;
      verdictRepository.findOne.mockResolvedValue(existing);

      await service.generateAndPersist(buildAnalysis());

      expect(verdictRepository.create).not.toHaveBeenCalled();
      expect(verdictRepository.merge).toHaveBeenCalledWith(
        existing,
        expect.objectContaining({ status: 'generated' }),
      );
    });
  });

  describe('generateAndPersist — camino de error (PR 11B: shape "seguro" de failed)', () => {
    it('si el generador falla, persiste status=failed con contenido placeholder seguro (nunca null)', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);
      deterministicGenerate.mockRejectedValue(
        new Error('regla de negocio inesperada'),
      );

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('failed');
      expect(result.verdict).toBe('insufficient_data');
      expect(result.confidence).toBe('low');
      expect(result.summary).toBe(
        'No se pudo generar el veredicto técnico automático.',
      );
      expect(result.keyFindings).toEqual([]);
      expect(result.possibleCauses).toEqual([]);
      expect(result.recommendations).toEqual([]);
      expect(result.limitations).toEqual([
        'El análisis satelital finalizó, pero la interpretación automática no pudo generarse.',
      ]);
      expect(result.generatedAt).toBeNull();
      expect(result.errorMessage).toBe('regla de negocio inesperada');
    });

    it('un mensaje de error larguísimo se trunca (mismo criterio que Analysis.errorMessage)', async () => {
      setProvider('deterministic');
      verdictRepository.findOne.mockResolvedValue(null);
      deterministicGenerate.mockRejectedValue(new Error('x'.repeat(1000)));

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.errorMessage!.length).toBeLessThan(1000);
      expect(result.errorMessage!.endsWith('…')).toBe(true);
    });

    it('propaga el error tal cual si hasta guardar la fila failed falla (infraestructura) — AnalysisService pone la red final', async () => {
      setProvider('deterministic');
      deterministicGenerate.mockRejectedValue(
        new Error('regla de negocio inesperada'),
      );
      verdictRepository.findOne.mockRejectedValue(new Error('DB caída'));

      await expect(service.generateAndPersist(buildAnalysis())).rejects.toThrow(
        'DB caída',
      );
    });
  });

  describe('findResponseByAnalysisId', () => {
    it('devuelve null si no hay veredicto para ese analysisId', async () => {
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.findResponseByAnalysisId('analysis-1');

      expect(result).toBeNull();
    });

    it('mapea la entidad al shape de respuesta pública (arrays nunca null, generatedAt como ISO string)', async () => {
      verdictRepository.findOne.mockResolvedValue({
        status: 'generated',
        verdict: 'favorable',
        confidence: 'high',
        summary: 'ok',
        keyFindings: ['a'],
        possibleCauses: null,
        recommendations: ['b'],
        limitations: ['c'],
        generator: 'deterministic-v1',
        promptVersion: null,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      } as any);

      const result = await service.findResponseByAnalysisId('analysis-1');

      expect(result).toEqual({
        status: 'generated',
        verdict: 'favorable',
        confidence: 'high',
        summary: 'ok',
        keyFindings: ['a'],
        possibleCauses: [],
        recommendations: ['b'],
        limitations: ['c'],
        generatedAt: '2026-01-01T00:00:00.000Z',
        generator: 'deterministic-v1',
        promptVersion: null,
      });
    });
  });
});
