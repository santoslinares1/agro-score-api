import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisVerdictService } from './analysis-verdict.service';
import { generateTechnicalVerdict } from './analysis-verdict-generator.util';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';

jest.mock('./analysis-verdict-generator.util', () => ({
  generateTechnicalVerdict: jest.fn(),
}));

const mockGenerateTechnicalVerdict = generateTechnicalVerdict as jest.Mock;

const HAPPY_PATH_RESULT = {
  verdict: 'favorable' as const,
  confidence: 'high' as const,
  summary: 'ok',
  keyFindings: ['finding'],
  possibleCauses: ['cause'],
  recommendations: ['recommendation'],
  limitations: ['limitation'],
};

type MockRepo = {
  findOne: jest.Mock;
  create: jest.Mock;
  merge: jest.Mock;
  save: jest.Mock;
};

describe('AnalysisVerdictService', () => {
  let service: AnalysisVerdictService;
  let verdictRepository: MockRepo;

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

  beforeEach(async () => {
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
      ],
    }).compile();

    service = module.get(AnalysisVerdictService);
    verdictRepository = module.get(
      getRepositoryToken(AnalysisTechnicalVerdict),
    );
    mockGenerateTechnicalVerdict.mockReset().mockReturnValue(HAPPY_PATH_RESULT);
  });

  describe('generateAndPersist', () => {
    it('camino feliz: genera y guarda un veredicto status=generated', async () => {
      verdictRepository.findOne.mockResolvedValue(null);

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('generated');
      expect(result.verdict).toBe('favorable');
      expect(result.generator).toBe('deterministic-v1');
      expect(result.generatedAt).toBeInstanceOf(Date);
      expect(verdictRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          analysisId: 'analysis-1',
          status: 'generated',
        }),
      );
    });

    it('si ya existe una fila para el analysisId, la actualiza en vez de crear una nueva (idempotente)', async () => {
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

    it('si el generador determinístico revienta, persiste status=failed con errorMessage en vez de propagar', async () => {
      verdictRepository.findOne.mockResolvedValue(null);
      mockGenerateTechnicalVerdict.mockImplementation(() => {
        throw new Error('regla de negocio inesperada');
      });

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.status).toBe('failed');
      expect(result.verdict).toBeNull();
      expect(result.confidence).toBeNull();
      expect(result.keyFindings).toEqual([]);
      expect(result.errorMessage).toBe('regla de negocio inesperada');
      expect(verdictRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ analysisId: 'analysis-1', status: 'failed' }),
      );
    });

    it('un mensaje de error larguísimo se trunca (mismo criterio que Analysis.errorMessage)', async () => {
      verdictRepository.findOne.mockResolvedValue(null);
      mockGenerateTechnicalVerdict.mockImplementation(() => {
        throw new Error('x'.repeat(1000));
      });

      const result = await service.generateAndPersist(buildAnalysis());

      expect(result.errorMessage!.length).toBeLessThan(1000);
      expect(result.errorMessage!.endsWith('…')).toBe(true);
    });

    it('propaga el error tal cual si hasta guardar el veredicto failed falla (infraestructura, no lógica de negocio) — AnalysisService es quien pone la red final', async () => {
      mockGenerateTechnicalVerdict.mockImplementation(() => {
        throw new Error('regla de negocio inesperada');
      });
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
