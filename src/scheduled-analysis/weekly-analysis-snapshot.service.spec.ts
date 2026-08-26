import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Analysis } from '../analysis/entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { WeeklyTechnicalVerdictResponse } from '../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
import { WeeklyTechnicalVerdictService } from '../weekly-technical-verdict/weekly-technical-verdict.service';
import { WeeklyAnalysisSnapshot } from './entities/weekly-analysis-snapshot.entity';
import { ScheduledAnalysisRun } from './entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';

describe('WeeklyAnalysisSnapshotService', () => {
  let service: WeeklyAnalysisSnapshotService;
  let snapshotRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let fieldsService: jest.Mocked<Pick<FieldsService, 'findOne'>>;
  let weeklyTechnicalVerdictService: jest.Mocked<
    Pick<
      WeeklyTechnicalVerdictService,
      'findResponseBySnapshotId' | 'findResponsesBySnapshotIds'
    >
  >;

  const buildVerdictResponse = (
    overrides: Partial<WeeklyTechnicalVerdictResponse> = {},
  ): WeeklyTechnicalVerdictResponse => ({
    status: 'generated',
    verdict: 'favorable',
    trend: 'stable',
    confidence: 'high',
    summary: 'El campo se mantiene estable.',
    keyChanges: [],
    areasToReview: [],
    recommendations: [],
    limitations: [],
    previousSnapshotId: 'snapshot-0',
    generatedAt: '2026-08-24T09:05:00.000Z',
    generator: 'claude-weekly-technical-verdict',
    promptVersion: 'weekly-technical-verdict-v1',
    errorMessage: null,
    ...overrides,
  });

  const buildRun = (
    overrides: Partial<ScheduledAnalysisRun> = {},
  ): ScheduledAnalysisRun =>
    ({
      id: 'run-1',
      scheduleId: 'schedule-1',
      fieldId: 'field-1',
      userId: 'user-A',
      analysisId: 'analysis-1',
      status: 'processing',
      scheduledFor: '2026-08-17',
      ...overrides,
    }) as ScheduledAnalysisRun;

  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis =>
    ({
      id: 'analysis-1',
      status: 'Finalizado',
      globalScore: 78,
      category: 'Buena aptitud productiva',
      startDate: '2026-08-10',
      endDate: '2026-08-17',
      resultJson: {
        mode: 'python-worker-v2',
        message: '',
        totalsByZone: [
          { zone: 2, name: 'Muy Alta', hectares: 40, percent: 80 },
        ],
        zones: [
          {
            lot: 'Lote Norte',
            area_ha: 50,
            valid_pixels: 100,
            zones: [],
            campaigns_used: 1,
            warnings: [],
          },
        ],
        mapAssets: {
          rgb: { available: true, image_base64: 'abc' },
          indexImages: [],
        },
        timeseries: [
          {
            lot: 'Lote Norte',
            rows: [
              {
                date: '2026-08-15',
                values: { NDVI_mean: 0.65, NDMI_mean: 0.25, NDVI_count: 500 },
              },
            ],
          },
        ],
      },
      ...overrides,
    }) as unknown as Analysis;

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo A',
      lots: [],
      ...overrides,
    }) as Field;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyAnalysisSnapshotService,
        {
          provide: getRepositoryToken(WeeklyAnalysisSnapshot),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((data) => data),
            save: jest.fn((data) =>
              Promise.resolve({ id: data.id ?? 'snapshot-1', ...data }),
            ),
          },
        },
        { provide: FieldsService, useValue: { findOne: jest.fn() } },
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: {
            findResponseBySnapshotId: jest.fn().mockResolvedValue(null),
            findResponsesBySnapshotIds: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();

    service = module.get(WeeklyAnalysisSnapshotService);
    snapshotRepository = module.get(getRepositoryToken(WeeklyAnalysisSnapshot));
    fieldsService = module.get(FieldsService);
    weeklyTechnicalVerdictService = module.get(WeeklyTechnicalVerdictService);
  });

  describe('createFromAnalysis', () => {
    it('crea un snapshot desde un Analysis Finalizado, con weekStart/weekEnd = analysis.startDate/endDate', async () => {
      const snapshot = await service.createFromAnalysis(
        buildRun(),
        buildAnalysis(),
      );

      expect(snapshot.weekStart).toBe('2026-08-10');
      expect(snapshot.weekEnd).toBe('2026-08-17');
      expect(snapshotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldId: 'field-1',
          userId: 'user-A',
          analysisId: 'analysis-1',
          scheduledRunId: 'run-1',
          source: 'scheduled_analysis',
        }),
      );
    });

    it('extrae score y scoreLabel desde analysis.globalScore/category (no desde resultJson)', async () => {
      await service.createFromAnalysis(
        buildRun(),
        buildAnalysis({ globalScore: 91, category: 'Excelente' }),
      );

      expect(snapshotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ score: 91, scoreLabel: 'Excelente' }),
      );
    });

    it('extrae zona predominante, superficie y NDVI/NDMI mean del resultJson', async () => {
      await service.createFromAnalysis(buildRun(), buildAnalysis());

      expect(snapshotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dominantZone: 'Muy Alta',
          analyzedAreaHa: 50,
          ndviMean: 0.65,
          ndmiMean: 0.25,
          hasRgbImage: true,
        }),
      );
    });

    it('dataQualityStatus=sufficient cuando hay imagen RGB', async () => {
      await service.createFromAnalysis(buildRun(), buildAnalysis());

      expect(snapshotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ dataQualityStatus: 'sufficient' }),
      );
    });

    it('crea el snapshot igual (insufficient) si el resultJson no trae nada comparable — no bloquea', async () => {
      const analysis = buildAnalysis({
        resultJson: { mode: 'python-worker-v2', message: '' } as any,
      });

      const snapshot = await service.createFromAnalysis(buildRun(), analysis);

      expect(snapshot).toBeDefined();
      expect(snapshotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dataQualityStatus: 'insufficient',
          hasEnoughData: false,
        }),
      );
    });

    it('compara contra el snapshot anterior del mismo campo con weekEnd anterior', async () => {
      const previous = {
        id: 'snapshot-prev',
        fieldId: 'field-1',
        weekStart: '2026-08-03',
        weekEnd: '2026-08-10',
        score: 70,
        ndviMean: 0.6,
        ndmiMean: 0.2,
        dominantZone: 'Alta',
        analyzedAreaHa: 45,
        dataQualityStatus: 'sufficient',
        hasRgbImage: true,
        hasNdviImage: false,
        hasNdmiImage: false,
      } as unknown as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValueOnce(previous);

      await service.createFromAnalysis(buildRun(), buildAnalysis());

      const created = snapshotRepository.create.mock.calls[0][0];
      expect(created.comparisonVsPrevious.previousSnapshotId).toBe(
        'snapshot-prev',
      );
      expect(created.comparisonVsPrevious.scoreDelta).toBe(8); // 78 - 70
    });

    it('sin snapshot anterior, comparisonVsPrevious dice que es el primer reporte', async () => {
      await service.createFromAnalysis(buildRun(), buildAnalysis());

      const created = snapshotRepository.create.mock.calls[0][0];
      expect(created.comparisonVsPrevious.previousSnapshotId).toBeNull();
      expect(created.comparisonVsPrevious.summary).toContain(
        'Primer reporte semanal disponible para este campo.',
      );
    });

    it('carrera de unique(fieldId, weekStart, weekEnd): recupera el snapshot existente en vez de fallar', async () => {
      snapshotRepository.save.mockRejectedValueOnce(
        Object.assign(
          new Error('duplicate key value violates unique constraint'),
          { code: '23505' },
        ),
      );
      const existing = { id: 'snapshot-existing' } as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValueOnce(null); // búsqueda de "previous"
      snapshotRepository.findOne.mockResolvedValueOnce(existing); // re-fetch tras la carrera

      const result = await service.createFromAnalysis(
        buildRun(),
        buildAnalysis(),
      );

      expect(result).toBe(existing);
    });
  });

  describe('findByScheduledRunId', () => {
    it('busca por scheduledRunId', async () => {
      snapshotRepository.findOne.mockResolvedValue({ id: 'snapshot-1' });

      const result = await service.findByScheduledRunId('run-1');

      expect(snapshotRepository.findOne).toHaveBeenCalledWith({
        where: { scheduledRunId: 'run-1' },
      });
      expect(result).toEqual({ id: 'snapshot-1' });
    });
  });

  describe('ownership', () => {
    it('findByField rechaza un campo ajeno sin consultar snapshots ni el veredicto semanal', async () => {
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findByField('field-1', 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(snapshotRepository.find).not.toHaveBeenCalled();
      expect(
        weeklyTechnicalVerdictService.findResponsesBySnapshotIds,
      ).not.toHaveBeenCalled();
    });

    it('findLatest lanza NotFoundException si no hay snapshots todavía', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      snapshotRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findLatest('field-1', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        weeklyTechnicalVerdictService.findResponseBySnapshotId,
      ).not.toHaveBeenCalled();
    });

    it('findOne rechaza un campo ajeno antes de buscar el snapshot o el veredicto semanal', async () => {
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findOne('field-1', 'snapshot-1', 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(snapshotRepository.findOne).not.toHaveBeenCalled();
      expect(
        weeklyTechnicalVerdictService.findResponseBySnapshotId,
      ).not.toHaveBeenCalled();
    });

    it('findOne lanza NotFoundException si el snapshot no pertenece a ese fieldId', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      snapshotRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOne('field-1', 'snapshot-ajeno', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('weeklyTechnicalVerdict (PR 17C)', () => {
    beforeEach(() => {
      fieldsService.findOne.mockResolvedValue(buildField());
    });

    it('findByField adjunta weeklyTechnicalVerdict a cada snapshot desde el batch', async () => {
      const snapshotA = {
        id: 'snapshot-a',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      const snapshotB = {
        id: 'snapshot-b',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      snapshotRepository.find.mockResolvedValue([snapshotA, snapshotB]);
      weeklyTechnicalVerdictService.findResponsesBySnapshotIds.mockResolvedValue(
        new Map([['snapshot-a', buildVerdictResponse()]]),
      );

      const result = await service.findByField('field-1', 'user-A');

      expect(
        weeklyTechnicalVerdictService.findResponsesBySnapshotIds,
      ).toHaveBeenCalledTimes(1);
      expect(
        weeklyTechnicalVerdictService.findResponsesBySnapshotIds,
      ).toHaveBeenCalledWith(['snapshot-a', 'snapshot-b']);
      expect(result[0].weeklyTechnicalVerdict?.verdict).toBe('favorable');
      expect(result[1].weeklyTechnicalVerdict).toBeNull(); // snapshot-b no está en el Map
    });

    it('findByField hace un solo query batch sin importar cuántos snapshots devuelva (no N+1)', async () => {
      const snapshots = Array.from({ length: 5 }, (_, i) => ({
        id: `snapshot-${i}`,
        fieldId: 'field-1',
      })) as WeeklyAnalysisSnapshot[];
      snapshotRepository.find.mockResolvedValue(snapshots);

      await service.findByField('field-1', 'user-A');

      expect(
        weeklyTechnicalVerdictService.findResponsesBySnapshotIds,
      ).toHaveBeenCalledTimes(1);
      expect(
        weeklyTechnicalVerdictService.findResponseBySnapshotId,
      ).not.toHaveBeenCalled();
    });

    it('findLatest adjunta weeklyTechnicalVerdict vía lookup single (no batch)', async () => {
      const snapshot = {
        id: 'snapshot-1',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
        buildVerdictResponse(),
      );

      const result = await service.findLatest('field-1', 'user-A');

      expect(
        weeklyTechnicalVerdictService.findResponseBySnapshotId,
      ).toHaveBeenCalledWith('snapshot-1');
      expect(result.weeklyTechnicalVerdict?.trend).toBe('stable');
    });

    it('findOne adjunta weeklyTechnicalVerdict vía lookup single', async () => {
      const snapshot = {
        id: 'snapshot-1',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
        buildVerdictResponse(),
      );

      const result = await service.findOne('field-1', 'snapshot-1', 'user-A');

      expect(result.weeklyTechnicalVerdict?.verdict).toBe('favorable');
    });

    it('status=failed se expone como weeklyTechnicalVerdict=null, nunca como errorMessage', async () => {
      const snapshot = {
        id: 'snapshot-1',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
        buildVerdictResponse({
          status: 'failed',
          errorMessage: 'El worker no respondió a tiempo.',
        }),
      );

      const result = await service.findOne('field-1', 'snapshot-1', 'user-A');

      expect(result.weeklyTechnicalVerdict).toBeNull();
    });

    it('nunca expone generator/promptVersion/errorMessage/inputSnapshot en weeklyTechnicalVerdict', async () => {
      const snapshot = {
        id: 'snapshot-1',
        fieldId: 'field-1',
      } as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
        buildVerdictResponse(),
      );

      const result = await service.findOne('field-1', 'snapshot-1', 'user-A');
      const keys = Object.keys(result.weeklyTechnicalVerdict as object);

      expect(keys).not.toContain('generator');
      expect(keys).not.toContain('promptVersion');
      expect(keys).not.toContain('errorMessage');
      expect(keys).not.toContain('inputSnapshot');
      expect(keys).not.toContain('analysisId');
      expect(keys).not.toContain('scheduledRunId');
    });

    it('sin veredicto persistido, weeklyTechnicalVerdict es null (no rompe comparisonVsPrevious existente)', async () => {
      const snapshot = {
        id: 'snapshot-1',
        fieldId: 'field-1',
        comparisonVsPrevious: {
          previousSnapshotId: null,
          summary: ['Primer reporte semanal disponible para este campo.'],
        },
      } as unknown as WeeklyAnalysisSnapshot;
      snapshotRepository.findOne.mockResolvedValue(snapshot);
      weeklyTechnicalVerdictService.findResponseBySnapshotId.mockResolvedValue(
        null,
      );

      const result = await service.findOne('field-1', 'snapshot-1', 'user-A');

      expect(result.weeklyTechnicalVerdict).toBeNull();
      expect(result.comparisonVsPrevious).toEqual(
        expect.objectContaining({
          summary: ['Primer reporte semanal disponible para este campo.'],
        }),
      );
    });
  });
});
