import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { LessThan } from 'typeorm';

import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { FieldsService } from '../fields/fields.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { WeeklyReportWorkerResult } from '../python-worker/types';
import { WeeklyFieldReport } from './entities/weekly-field-report.entity';
import { WeeklyLotIndexObservation } from './entities/weekly-lot-index-observation.entity';
import { WeeklyReportsService } from './weekly-reports.service';

type MockRepo<T extends Record<string, any>> = {
  [K in keyof T]?: jest.Mock;
} & {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
};

describe('WeeklyReportsService', () => {
  let service: WeeklyReportsService;
  let weeklyReportRepository: MockRepo<WeeklyFieldReport>;
  let observationRepository: MockRepo<WeeklyLotIndexObservation>;
  let fieldsService: jest.Mocked<Pick<FieldsService, 'findOne'>>;
  let pythonWorkerService: jest.Mocked<Pick<PythonWorkerService, 'runWeeklyReport'>>;

  const buildLot = (overrides: Partial<FieldLot> = {}): FieldLot =>
    ({
      id: 'lot-1',
      fieldId: 'field-1',
      name: 'Lote 1',
      geojson: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      areaHa: 50,
      displayOrder: 1,
      includeInProductivityClassification: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as FieldLot;

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo A',
      totalAreaHa: 50,
      lots: [buildLot()],
      createdAt: new Date(),
      updatedAt: new Date(),
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      maxCloudiness: 30,
      ...overrides,
    }) as Field;

  let queryBuilderMock: {
    where: jest.Mock;
    andWhere: jest.Mock;
    innerJoin: jest.Mock;
    orderBy: jest.Mock;
    getMany: jest.Mock;
  };

  beforeEach(async () => {
    queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyReportsService,
        {
          provide: getRepositoryToken(WeeklyFieldReport),
          useValue: {
            create: jest.fn((data) => data),
            save: jest.fn((data) => Promise.resolve({ id: 'report-1', ...data })),
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(undefined),
            createQueryBuilder: jest.fn(() => queryBuilderMock),
          },
        },
        {
          provide: getRepositoryToken(WeeklyLotIndexObservation),
          useValue: {
            create: jest.fn((data) => data),
            save: jest.fn((data) => Promise.resolve(data)),
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(undefined),
            createQueryBuilder: jest.fn(() => queryBuilderMock),
          },
        },
        { provide: FieldsService, useValue: { findOne: jest.fn() } },
        { provide: PythonWorkerService, useValue: { runWeeklyReport: jest.fn() } },
      ],
    }).compile();

    service = module.get(WeeklyReportsService);
    weeklyReportRepository = module.get(getRepositoryToken(WeeklyFieldReport));
    observationRepository = module.get(getRepositoryToken(WeeklyLotIndexObservation));
    fieldsService = module.get(FieldsService);
    pythonWorkerService = module.get(PythonWorkerService);
  });

  describe('create', () => {
    it('crea un WeeklyFieldReport "processing" para un campo propio', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      weeklyReportRepository.findOne.mockResolvedValue(null);
      // No nos interesa que corra el pipeline real en este test — se prueba aparte.
      jest.spyOn(service as any, 'processInBackground').mockResolvedValue(undefined);

      const result = await service.create(
        'field-1',
        { campaignStart: '2025-10-01', targetDate: '2026-08-21' },
        'user-A',
      );

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(weeklyReportRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldId: 'field-1',
          userId: 'user-A',
          status: 'processing',
          source: 'manual',
          weekAnchorDate: '2026-08-19',
          indices: ['NDVI', 'NDMI'],
        }),
      );
      expect(result.status).toBe('processing');
    });

    it('rechaza un campo ajeno sin crear ningún reporte', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(
        service.create('field-1', { campaignStart: '2025-10-01' }, 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(weeklyReportRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza NDRE si includeNdreExperimental no está en true', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.create(
          'field-1',
          { campaignStart: '2025-10-01', indices: ['NDVI', 'NDRE'] },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(weeklyReportRepository.save).not.toHaveBeenCalled();
    });

    it('acepta NDRE si includeNdreExperimental=true', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      weeklyReportRepository.findOne.mockResolvedValue(null);
      jest.spyOn(service as any, 'processInBackground').mockResolvedValue(undefined);

      await service.create(
        'field-1',
        { campaignStart: '2025-10-01', indices: ['NDVI', 'NDRE'], includeNdreExperimental: true },
        'user-A',
      );

      expect(weeklyReportRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ includeNdreExperimental: true, indices: ['NDVI', 'NDRE'] }),
      );
    });

    it('rechaza si campaignStart es posterior a targetDate', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.create(
          'field-1',
          { campaignStart: '2026-01-01', targetDate: '2025-01-01' },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza si campaignEnd es anterior a campaignStart', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.create(
          'field-1',
          { campaignStart: '2025-10-01', campaignEnd: '2025-09-01' },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza si el campo no tiene ningún lote incluido en clasificación productiva', async () => {
      fieldsService.findOne.mockResolvedValue(
        buildField({ lots: [buildLot({ includeInProductivityClassification: false })] }),
      );

      await expect(
        service.create('field-1', { campaignStart: '2025-10-01' }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(weeklyReportRepository.save).not.toHaveBeenCalled();
    });

    it('reutiliza (no duplica) un reporte no-failed ya existente para la misma semana', async () => {
      const existing = { id: 'report-existing', status: 'completed' };
      fieldsService.findOne.mockResolvedValue(buildField());
      weeklyReportRepository.findOne.mockResolvedValue(existing);

      const result = await service.create(
        'field-1',
        { campaignStart: '2025-10-01', targetDate: '2026-08-21' },
        'user-A',
      );

      expect(result).toBe(existing);
      expect(weeklyReportRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('lista reportes del campo, validando ownership primero', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      weeklyReportRepository.find.mockResolvedValue([]);

      await service.findAll('field-1', 'user-A', {});

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(weeklyReportRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fieldId: 'field-1' } }),
      );
    });

    it('propaga NotFoundException si el campo es ajeno, sin consultar reportes', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findAll('field-1', 'user-B', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(weeklyReportRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('findLatestCompleted', () => {
    it('devuelve el último reporte completed', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      const completed = { id: 'report-1', status: 'completed' };
      weeklyReportRepository.findOne.mockResolvedValue(completed);

      const result = await service.findLatestCompleted('field-1', 'user-A');

      expect(weeklyReportRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fieldId: 'field-1', status: 'completed' } }),
      );
      expect(result).toBe(completed);
    });

    it('lanza NotFoundException si no hay ningún reporte completed', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      weeklyReportRepository.findOne.mockResolvedValue(null);

      await expect(service.findLatestCompleted('field-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('processInBackground / persistResult / resolveDelta (llamadas directas — ver nota)', () => {
    // Estos métodos son privados y se disparan fire-and-forget desde create() (mismo patrón que
    // AnalysisService.processFieldAnalysisInBackground, que tampoco se testea a través de
    // runFieldAnalysis). Se invocan acá directamente para probar su comportamiento de forma
    // determinística, sin depender de que el event loop drene microtasks en el orden esperado.

    const workerResultBase: WeeklyReportWorkerResult = {
      methodologyVersion: 'weekly-v1',
      campaign: { start: '2025-10-01', targetDate: '2026-08-21', weekAnchorDate: '2026-08-19', stepDays: 7 },
      indices: ['NDVI', 'NDMI'],
      experimentalIndices: [],
      lots: [],
      warnings: [],
    };

    it('guarda una observación disponible con sus stats', async () => {
      const result: WeeklyReportWorkerResult = {
        ...workerResultBase,
        lots: [
          {
            lotId: 'lot-1',
            lotName: 'Lote 1',
            index: 'NDVI',
            experimental: false,
            available: true,
            weekAnchorDate: '2026-08-19',
            imageDate: '2026-08-18',
            cloudPct: 12.3,
            scaleM: 10,
            scaleWarning: null,
            stats: { mean: 0.62, stdDev: 0.08, min: 0.21, max: 0.87, validPixelCount: 12345 },
            deltaVsPrevious: null,
            notes: [],
          },
        ],
      };

      await (service as any).persistResult('report-1', 'field-1', result);

      expect(observationRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          weeklyReportId: 'report-1',
          fieldId: 'field-1',
          lotId: 'lot-1',
          index: 'NDVI',
          available: true,
          mean: 0.62,
          stdDev: 0.08,
          min: 0.21,
          max: 0.87,
          validPixelCount: 12345,
          unavailableReason: null,
        }),
      ]);
      expect(weeklyReportRepository.update).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({ status: 'completed', warnings: null }),
      );
    });

    it('guarda una observación unavailable sin stats, con el motivo', async () => {
      const result: WeeklyReportWorkerResult = {
        ...workerResultBase,
        lots: [
          {
            lotId: 'lot-1',
            lotName: 'Lote 1',
            index: 'NDVI',
            experimental: false,
            available: false,
            weekAnchorDate: '2026-08-19',
            imageDate: null,
            cloudPct: null,
            scaleM: 10,
            scaleWarning: null,
            stats: null,
            deltaVsPrevious: null,
            notes: ['Sin imágenes Sentinel-2 en 24 días.'],
          },
        ],
      };

      await (service as any).persistResult('report-1', 'field-1', result);

      expect(observationRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          available: false,
          mean: null,
          stdDev: null,
          min: null,
          max: null,
          validPixelCount: null,
          unavailableReason: 'Sin imágenes Sentinel-2 en 24 días.',
        }),
      ]);
    });

    it('no rompe si el worker devuelve warnings — se persisten en el reporte', async () => {
      const result: WeeklyReportWorkerResult = { ...workerResultBase, warnings: ['ojo con esto'] };

      await (service as any).persistResult('report-1', 'field-1', result);

      expect(weeklyReportRepository.update).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({ status: 'completed', warnings: ['ojo con esto'] }),
      );
    });

    it('trunca unavailableReason si el worker manda un motivo excepcionalmente largo (red defensiva, RISK-022)', async () => {
      const longReason = 'X'.repeat(600);
      const result: WeeklyReportWorkerResult = {
        ...workerResultBase,
        lots: [
          {
            lotId: 'lot-1',
            lotName: 'Lote 1',
            index: 'NDVI',
            experimental: false,
            available: false,
            weekAnchorDate: '2026-08-19',
            imageDate: null,
            cloudPct: null,
            scaleM: 10,
            scaleWarning: null,
            stats: null,
            deltaVsPrevious: null,
            notes: [longReason],
          },
        ],
      };

      await (service as any).persistResult('report-1', 'field-1', result);

      const [[savedObservations]] = observationRepository.save.mock.calls;
      const [saved] = savedObservations as [{ unavailableReason: string; metadata: unknown }];

      expect(saved.unavailableReason.length).toBeLessThan(longReason.length);
      expect(saved.unavailableReason.endsWith('…')).toBe(true);
      // El truncado es solo defensivo por longitud: metadata.notes conserva el contenido
      // sanitizado tal cual lo mandó el Worker (ver comentario en persistResult).
      expect((saved.metadata as { notes: string[] }).notes).toEqual([longReason]);
    });

    it('deja intacto un unavailableReason corto y legítimo (no trunca de más)', async () => {
      const shortReason = 'No se pudo calcular este índice para el lote.';
      const result: WeeklyReportWorkerResult = {
        ...workerResultBase,
        lots: [
          {
            lotId: 'lot-1',
            lotName: 'Lote 1',
            index: 'NDVI',
            experimental: false,
            available: false,
            weekAnchorDate: '2026-08-19',
            imageDate: null,
            cloudPct: null,
            scaleM: 10,
            scaleWarning: null,
            stats: null,
            deltaVsPrevious: null,
            notes: [shortReason],
          },
        ],
      };

      await (service as any).persistResult('report-1', 'field-1', result);

      expect(observationRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({ unavailableReason: shortReason }),
      ]);
    });

    it('trunca cada elemento de warnings si el worker manda alguno excepcionalmente largo', async () => {
      const longWarning = 'Y'.repeat(600);
      const result: WeeklyReportWorkerResult = {
        ...workerResultBase,
        warnings: [longWarning, 'aviso corto'],
      };

      await (service as any).persistResult('report-1', 'field-1', result);

      const [, updatePayload] = weeklyReportRepository.update.mock.calls[0] as [string, { warnings: string[] }];

      expect(updatePayload.warnings[0].length).toBeLessThan(longWarning.length);
      expect(updatePayload.warnings[0].endsWith('…')).toBe(true);
      expect(updatePayload.warnings[1]).toBe('aviso corto');
    });

    it('marca el reporte failed si el worker rechaza la promesa, sin inventar observaciones', async () => {
      const field = buildField();
      pythonWorkerService.runWeeklyReport.mockRejectedValue(new Error('No se pudo conectar con el worker Python.'));

      await (service as any).processInBackground('report-1', field, field.lots, {
        campaignStart: '2025-10-01',
        campaignEnd: null,
        targetDate: '2026-08-21',
        indices: ['NDVI', 'NDMI'],
        includeNdreExperimental: false,
      });

      expect(observationRepository.save).not.toHaveBeenCalled();
      expect(weeklyReportRepository.update).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'No se pudo conectar con el worker Python.',
        }),
      );
    });

    // OPS-3 (RISK-053): WeeklyFieldReport.errorMessage se muestra DIRECTO al productor
    // (weekly-monitoring-panel.component.html en agro-score-web) — este test confirma que el
    // mensaje público ya sanitizado que ahora lanza PythonWorkerService.handleWorkerError llega
    // intacto acá, sin que WeeklyReportsService le agregue ni le saque nada.
    it('persiste el mensaje público sanitizado del Worker en errorMessage, sin alterarlo', async () => {
      const field = buildField();
      const safeMessage =
        'El motor de análisis no está disponible temporalmente.';
      pythonWorkerService.runWeeklyReport.mockRejectedValue(
        new ServiceUnavailableException(safeMessage),
      );

      await (service as any).processInBackground('report-1', field, field.lots, {
        campaignStart: '2025-10-01',
        campaignEnd: null,
        targetDate: '2026-08-21',
        indices: ['NDVI', 'NDMI'],
        includeNdreExperimental: false,
      });

      expect(weeklyReportRepository.update).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({
          status: 'failed',
          errorMessage: safeMessage,
        }),
      );
    });

    it('usa deltaVsPrevious del worker tal cual si viene no nulo, sin consultar historial', async () => {
      const observation = {
        lotId: 'lot-1',
        lotName: 'Lote 1',
        index: 'NDVI',
        weekAnchorDate: '2026-08-19',
        stats: { mean: 0.7, stdDev: null, min: null, max: null, validPixelCount: null },
        deltaVsPrevious: 0.03,
      } as any;

      const delta = await (service as any).resolveDelta('field-1', observation);

      expect(delta).toBe(0.03);
      expect(observationRepository.findOne).not.toHaveBeenCalled();
    });

    it('calcula el delta contra la observación anterior real cuando el worker no lo manda', async () => {
      observationRepository.findOne.mockResolvedValue({ mean: 0.6, weekAnchorDate: '2026-08-12' });

      const observation = {
        lotId: 'lot-1',
        lotName: 'Lote 1',
        index: 'NDVI',
        weekAnchorDate: '2026-08-19',
        stats: { mean: 0.65, stdDev: null, min: null, max: null, validPixelCount: null },
        deltaVsPrevious: null,
      } as any;

      const delta = await (service as any).resolveDelta('field-1', observation);

      expect(delta).toBeCloseTo(0.05);
    });

    it('nunca compara la semana contra sí misma: la query de "anterior" filtra weekAnchorDate estrictamente menor', async () => {
      observationRepository.findOne.mockResolvedValue(null);

      const observation = {
        lotId: 'lot-1',
        lotName: 'Lote 1',
        index: 'NDVI',
        weekAnchorDate: '2026-08-19',
        stats: { mean: 0.65, stdDev: null, min: null, max: null, validPixelCount: null },
        deltaVsPrevious: null,
      } as any;

      const delta = await (service as any).resolveDelta('field-1', observation);

      expect(delta).toBeNull();
      expect(observationRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ weekAnchorDate: LessThan('2026-08-19') }),
        }),
      );
    });

    it('devuelve delta null si no hay observación anterior con mean disponible', async () => {
      observationRepository.findOne.mockResolvedValue(null);

      const observation = {
        lotId: 'lot-1',
        lotName: 'Lote 1',
        index: 'NDVI',
        weekAnchorDate: '2026-08-19',
        stats: { mean: 0.65, stdDev: null, min: null, max: null, validPixelCount: null },
        deltaVsPrevious: null,
      } as any;

      const delta = await (service as any).resolveDelta('field-1', observation);

      expect(delta).toBeNull();
    });
  });
});
