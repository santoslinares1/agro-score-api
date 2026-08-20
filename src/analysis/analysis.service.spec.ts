import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { FieldsService } from '../fields/fields.service';
import { Field } from '../fields/entities/field.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';
import { ReportPdfService } from './report-pdf/report-pdf.service';

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
};

describe('AnalysisService', () => {
  let service: AnalysisService;
  let analysisRepository: MockRepo;
  let fieldsService: jest.Mocked<
    Pick<FieldsService, 'findOne' | 'findByIdOrFail' | 'getPipelineInput'>
  >;
  let reportPdfService: jest.Mocked<Pick<ReportPdfService, 'build'>>;

  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis =>
    ({
      id: 'analysis-1',
      lotId: null,
      fieldId: null,
      scope: 'field',
      lotName: 'Campo A',
      status: 'Finalizado',
      globalScore: 70,
      category: 'Buena aptitud productiva con variabilidad moderada',
      confidenceScore: 0,
      productivityScore: 0,
      stabilityScore: 0,
      soilScore: 0,
      climateScore: 0,
      ndviAverageMax: 0,
      ndviVariability: 'Media',
      zonesDetected: 0,
      maxCloudiness: 30,
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      resultJson: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      ...overrides,
    }) as Analysis;

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo A',
      totalAreaHa: 10,
      lots: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      maxCloudiness: 30,
      ...overrides,
    }) as Field;

  let queryBuilderMock: {
    innerJoin: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    orderBy: jest.Mock;
    getMany: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(async () => {
    queryBuilderMock = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalysisService,
        {
          provide: getRepositoryToken(Analysis),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            createQueryBuilder: jest.fn(() => queryBuilderMock),
          },
        },
        { provide: PythonWorkerService, useValue: {} },
        {
          provide: FieldsService,
          useValue: {
            findOne: jest.fn(),
            findByIdOrFail: jest.fn(),
            getPipelineInput: jest.fn(),
          },
        },
        { provide: ReportPdfService, useValue: { build: jest.fn() } },
      ],
    }).compile();

    service = module.get(AnalysisService);
    analysisRepository = module.get(getRepositoryToken(Analysis));
    fieldsService = module.get(FieldsService);
    reportPdfService = module.get(ReportPdfService);
  });

  describe('findOneOwned', () => {
    // A. El análisis no existe.
    it('lanza NotFoundException si el análisis no existe', async () => {
      analysisRepository.findOne.mockResolvedValue(null);

      await expect(service.findOneOwned('missing', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });

    // B. scope='field' con fieldId propio.
    it('devuelve el análisis si scope=field y el Field es del usuario', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockResolvedValue(buildField());

      const result = await service.findOneOwned('analysis-1', 'user-A');

      expect(result).toBe(analysis);
      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
    });

    // C. scope='field' con fieldId ajeno.
    it('lanza NotFoundException si scope=field pero el Field es de otro usuario', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findOneOwned('analysis-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // D. scope='lot' (el bug corregido en AUTH-3): debe bloquearse SIEMPRE,
    // sin siquiera intentar resolver ownership por Field.
    it('lanza NotFoundException para scope=lot aunque el análisis exista, sin consultar FieldsService', async () => {
      const analysis = buildAnalysis({ scope: 'lot', lotId: 'lot-1', fieldId: null });
      analysisRepository.findOne.mockResolvedValue(analysis);

      await expect(service.findOneOwned('analysis-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });

    // E. scope=null (legacy) con lotId que resuelve a un Field propio.
    it('devuelve el análisis para scope=null si el lotId legacy resuelve a un Field propio', async () => {
      const analysis = buildAnalysis({ scope: null, lotId: 'field-1', fieldId: null });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockResolvedValue(buildField());

      const result = await service.findOneOwned('analysis-1', 'user-A');

      expect(result).toBe(analysis);
      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
    });

    // F. scope=null con lotId que no resuelve a ningún Field.
    it('lanza NotFoundException para scope=null si el lotId legacy no resuelve a un Field', async () => {
      const analysis = buildAnalysis({ scope: null, lotId: 'orphan-lot', fieldId: null });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findOneOwned('analysis-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // G. Sin fieldId y sin lotId: no hay nada que resolver.
    it('lanza NotFoundException si el análisis no tiene fieldId ni lotId', async () => {
      const analysis = buildAnalysis({ scope: null, lotId: null, fieldId: null });
      analysisRepository.findOne.mockResolvedValue(analysis);

      await expect(service.findOneOwned('analysis-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });
  });

  describe('findOneOwnedStatus (PERF-2)', () => {
    const buildStatusRow = (overrides: Partial<Analysis> = {}): Analysis =>
      buildAnalysis({
        status: 'Procesando',
        startedAt: new Date('2026-01-01T10:00:00Z'),
        completedAt: null,
        failedAt: null,
        durationMs: null,
        errorMessage: null,
        // Simula que, si por algún motivo la fila trajera más columnas de las pedidas, igual
        // nunca deberían terminar en el DTO devuelto — el mapeo campo por campo del service es
        // la garantía real, no una lista de qué "esconder".
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          mapAssets: { rgb: { available: true, image_base64: 'HUGE_BASE64_STRING' } },
          imageSeries: {
            ndvi: [{ campaign: '2024', images: [{ available: true, image_base64: 'HUGE_BASE64_STRING' }] }],
            ndmi: [],
          },
        } as any,
        ...overrides,
      });

    it('selecciona solo columnas livianas al consultar Postgres — nunca resultJson', async () => {
      queryBuilderMock.getOne.mockResolvedValue(buildStatusRow({ scope: 'field', fieldId: 'field-1' }));
      fieldsService.findOne.mockResolvedValue(buildField());

      await service.findOneOwnedStatus('analysis-1', 'user-A');

      expect(queryBuilderMock.select).toHaveBeenCalledWith(
        expect.arrayContaining(['analysis.id', 'analysis.status', 'analysis.globalScore']),
      );
      const selectedColumns = queryBuilderMock.select.mock.calls[0][0] as string[];
      expect(selectedColumns).not.toContain('analysis.resultJson');
    });

    it('la respuesta nunca incluye resultJson/mapAssets/imageSeries aunque la fila los tuviera', async () => {
      queryBuilderMock.getOne.mockResolvedValue(buildStatusRow({ scope: 'field', fieldId: 'field-1' }));
      fieldsService.findOne.mockResolvedValue(buildField());

      const result = await service.findOneOwnedStatus('analysis-1', 'user-A');

      expect(result).not.toHaveProperty('resultJson');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('imageSeries');
      expect(serialized).not.toContain('mapAssets');
      expect(serialized).not.toContain('HUGE_BASE64_STRING');
    });

    it('devuelve status, error y timestamps operativos', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({
          scope: 'field',
          fieldId: 'field-1',
          status: 'Error',
          failedAt: new Date('2026-01-01T10:05:00Z'),
          durationMs: 300000,
          errorMessage: 'No se pudo conectar con el worker Python.',
        }),
      );
      fieldsService.findOne.mockResolvedValue(buildField());

      const result = await service.findOneOwnedStatus('analysis-1', 'user-A');

      expect(result.status).toBe('Error');
      expect(result.errorMessage).toBe('No se pudo conectar con el worker Python.');
      expect(result.durationMs).toBe(300000);
      expect(result.failedAt).toEqual(new Date('2026-01-01T10:05:00Z'));
    });

    it('lanza NotFoundException si el análisis no existe', async () => {
      queryBuilderMock.getOne.mockResolvedValue(null);

      await expect(service.findOneOwnedStatus('missing', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el análisis es de otro usuario (Field ajeno)', async () => {
      queryBuilderMock.getOne.mockResolvedValue(buildStatusRow({ scope: 'field', fieldId: 'field-1' }));
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findOneOwnedStatus('analysis-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lanza NotFoundException para scope=lot, sin consultar FieldsService (mismo default-deny que findOneOwned)', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({ scope: 'lot', lotId: 'lot-1', fieldId: null }),
      );

      await expect(service.findOneOwnedStatus('analysis-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });
  });

  describe('findAll (owned)', () => {
    // NOTA: el filtro real de ownership vive en una condición SQL cruda
    // (join con `::text`, específico de Postgres) armada con QueryBuilder.
    // Un mock no puede ejecutar esa SQL, así que este test solo prueba el
    // cableado del service (que efectivamente filtra por el userId
    // recibido y devuelve lo que el builder resuelva) — no reemplaza una
    // prueba de integración contra Postgres real para las reglas de
    // exclusión de scope='lot'/huérfanos (ver deuda restante en la entrega).
    it('arma el query filtrando por el userId recibido y devuelve el resultado del builder', async () => {
      const analyses = [buildAnalysis({ id: 'a1' }), buildAnalysis({ id: 'a2' })];
      const queryBuilder = analysisRepository.createQueryBuilder();
      queryBuilder.getMany.mockResolvedValue(analyses);

      const result = await service.findAll('user-A');

      expect(queryBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining('userId'),
        { userId: 'user-A' },
      );
      expect(result).toBe(analyses);
    });
  });

  describe('findByField', () => {
    it('devuelve el historial si el Field es del usuario', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.find.mockResolvedValue([buildAnalysis()]);

      const result = await service.findByField('field-1', 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(result).toHaveLength(1);
    });

    it('propaga NotFoundException si el Field es ajeno, sin consultar el historial', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findByField('field-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(analysisRepository.find).not.toHaveBeenCalled();
    });

    it('propaga NotFoundException si el Field no existe, sin consultar el historial', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.findByField('missing-field', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(analysisRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('getReportPath / getReportPdfPath', () => {
    // AUTH-4: estos métodos reciben el Analysis ya validado por
    // findOneOwned — no hacen ningún lookup propio, así que estructuralmente
    // no pueden saltarse el chequeo de ownership.
    it('getReportPath devuelve el path si el análisis tiene reporte generado', () => {
      const analysis = buildAnalysis({
        resultJson: { mode: 'python-worker-v2', message: '', report: { htmlPath: '/tmp/report.html' } },
      });

      expect(service.getReportPath(analysis)).toBe('/tmp/report.html');
    });

    it('getReportPath lanza NotFoundException si no hay reporte generado', () => {
      const analysis = buildAnalysis({ resultJson: null });

      expect(() => service.getReportPath(analysis)).toThrow(
        'El análisis no tiene reporte generado.',
      );
    });

  });

  describe('buildReportPdf (PDF-1)', () => {
    // AUTH-4: mismo gate de ownership que getReportPath/getReportPdfPath — vuelve a
    // resolver el Field dueño (resolveOwnedFieldId) antes de delegar en ReportPdfService, así
    // nunca genera el PDF antes de confirmar quién es el dueño.
    it('resuelve el Field por scope=field y delega en ReportPdfService.build', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      const field = buildField();
      const built = { stream: {} as any, filename: 'agroscore-reporte-campo-a-2026-01-01.pdf' };

      fieldsService.findOne.mockResolvedValue(field);
      reportPdfService.build.mockResolvedValue(built);

      const result = await service.buildReportPdf(analysis, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(reportPdfService.build).toHaveBeenCalledWith(analysis, field);
      expect(result).toBe(built);
    });

    it('resuelve el Field por scope=null legacy (fieldId guardado en lotId)', async () => {
      const analysis = buildAnalysis({ scope: null, lotId: 'field-1', fieldId: null });
      const field = buildField();

      fieldsService.findOne.mockResolvedValue(field);
      reportPdfService.build.mockResolvedValue({ stream: {} as any, filename: 'x.pdf' });

      await service.buildReportPdf(analysis, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
    });

    it('lanza NotFoundException para scope=lot sin llamar a FieldsService ni a ReportPdfService', async () => {
      const analysis = buildAnalysis({ scope: 'lot', lotId: 'lot-1', fieldId: null });

      await expect(service.buildReportPdf(analysis, 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fieldsService.findOne).not.toHaveBeenCalled();
      expect(reportPdfService.build).not.toHaveBeenCalled();
    });

    it('propaga NotFoundException si el Field resuelto es de otro usuario, sin generar el PDF', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.buildReportPdf(analysis, 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(reportPdfService.build).not.toHaveBeenCalled();
    });

    it('propaga el error de ReportPdfService.build (p.ej. análisis sin datos suficientes)', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      fieldsService.findOne.mockResolvedValue(buildField());
      reportPdfService.build.mockRejectedValue(
        new NotFoundException('El análisis no tiene datos suficientes para generar el reporte.'),
      );

      await expect(service.buildReportPdf(analysis, 'user-A')).rejects.toThrow(
        'El análisis no tiene datos suficientes para generar el reporte.',
      );
    });
  });
});
