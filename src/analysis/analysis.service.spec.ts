import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { FieldsService } from '../fields/fields.service';
import { Field } from '../fields/entities/field.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';
import { ReportPdfService } from './report-pdf/report-pdf.service';
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
};

describe('AnalysisService', () => {
  let service: AnalysisService;
  let analysisRepository: MockRepo;
  let fieldsService: jest.Mocked<
    Pick<FieldsService, 'findOne' | 'findByIdOrFail' | 'getPipelineInput'>
  >;
  let reportPdfService: jest.Mocked<Pick<ReportPdfService, 'build'>>;
  let analysisVerdictService: jest.Mocked<
    Pick<
      AnalysisVerdictService,
      'generateAndPersist' | 'findResponseByAnalysisId'
    >
  >;
  let pythonWorkerService: jest.Mocked<
    Pick<PythonWorkerService, 'runFieldAnalysis'>
  >;

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

  const buildField = (overrides: Partial<Field> = {}): Field => ({
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
  });

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
            create: jest.fn((data) => ({ ...data })),
            save: jest.fn((entity) =>
              Promise.resolve({ id: entity.id ?? 'analysis-1', ...entity }),
            ),
            createQueryBuilder: jest.fn(() => queryBuilderMock),
          },
        },
        {
          provide: PythonWorkerService,
          useValue: { runFieldAnalysis: jest.fn() },
        },
        {
          provide: FieldsService,
          useValue: {
            findOne: jest.fn(),
            findByIdOrFail: jest.fn(),
            getPipelineInput: jest.fn(),
          },
        },
        { provide: ReportPdfService, useValue: { build: jest.fn() } },
        {
          provide: AnalysisVerdictService,
          useValue: {
            generateAndPersist: jest.fn().mockResolvedValue(undefined),
            findResponseByAnalysisId: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get(AnalysisService);
    analysisRepository = module.get(getRepositoryToken(Analysis));
    fieldsService = module.get(FieldsService);
    reportPdfService = module.get(ReportPdfService);
    analysisVerdictService = module.get(AnalysisVerdictService);
    pythonWorkerService = module.get(PythonWorkerService);
  });

  const flushBackgroundWork = () =>
    new Promise((resolve) => setImmediate(resolve));

  describe('findOneOwned', () => {
    // A. El análisis no existe.
    it('lanza NotFoundException si el análisis no existe', async () => {
      analysisRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOneOwned('missing', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
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
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findOneOwned('analysis-1', 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // D. scope='lot' (el bug corregido en AUTH-3): debe bloquearse SIEMPRE,
    // sin siquiera intentar resolver ownership por Field.
    it('lanza NotFoundException para scope=lot aunque el análisis exista, sin consultar FieldsService', async () => {
      const analysis = buildAnalysis({
        scope: 'lot',
        lotId: 'lot-1',
        fieldId: null,
      });
      analysisRepository.findOne.mockResolvedValue(analysis);

      await expect(
        service.findOneOwned('analysis-1', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });

    // E. scope=null (legacy) con lotId que resuelve a un Field propio.
    it('devuelve el análisis para scope=null si el lotId legacy resuelve a un Field propio', async () => {
      const analysis = buildAnalysis({
        scope: null,
        lotId: 'field-1',
        fieldId: null,
      });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockResolvedValue(buildField());

      const result = await service.findOneOwned('analysis-1', 'user-A');

      expect(result).toBe(analysis);
      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
    });

    // F. scope=null con lotId que no resuelve a ningún Field.
    it('lanza NotFoundException para scope=null si el lotId legacy no resuelve a un Field', async () => {
      const analysis = buildAnalysis({
        scope: null,
        lotId: 'orphan-lot',
        fieldId: null,
      });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findOneOwned('analysis-1', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // G. Sin fieldId y sin lotId: no hay nada que resolver.
    it('lanza NotFoundException si el análisis no tiene fieldId ni lotId', async () => {
      const analysis = buildAnalysis({
        scope: null,
        lotId: null,
        fieldId: null,
      });
      analysisRepository.findOne.mockResolvedValue(analysis);

      await expect(
        service.findOneOwned('analysis-1', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
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
          mapAssets: {
            rgb: { available: true, image_base64: 'HUGE_BASE64_STRING' },
          },
          imageSeries: {
            ndvi: [
              {
                campaign: '2024',
                images: [
                  { available: true, image_base64: 'HUGE_BASE64_STRING' },
                ],
              },
            ],
            ndmi: [],
          },
        } as any,
        ...overrides,
      });

    it('selecciona solo columnas livianas al consultar Postgres — nunca resultJson', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({ scope: 'field', fieldId: 'field-1' }),
      );
      fieldsService.findOne.mockResolvedValue(buildField());

      await service.findOneOwnedStatus('analysis-1', 'user-A');

      expect(queryBuilderMock.select).toHaveBeenCalledWith(
        expect.arrayContaining([
          'analysis.id',
          'analysis.status',
          'analysis.globalScore',
        ]),
      );
      const selectedColumns = queryBuilderMock.select.mock
        .calls[0][0] as string[];
      expect(selectedColumns).not.toContain('analysis.resultJson');
    });

    it('la respuesta nunca incluye resultJson/mapAssets/imageSeries aunque la fila los tuviera', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({ scope: 'field', fieldId: 'field-1' }),
      );
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
      expect(result.errorMessage).toBe(
        'No se pudo conectar con el worker Python.',
      );
      expect(result.durationMs).toBe(300000);
      expect(result.failedAt).toEqual(new Date('2026-01-01T10:05:00Z'));
    });

    it('lanza NotFoundException si el análisis no existe', async () => {
      queryBuilderMock.getOne.mockResolvedValue(null);

      await expect(
        service.findOneOwnedStatus('missing', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fieldsService.findOne).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el análisis es de otro usuario (Field ajeno)', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({ scope: 'field', fieldId: 'field-1' }),
      );
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findOneOwnedStatus('analysis-1', 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lanza NotFoundException para scope=lot, sin consultar FieldsService (mismo default-deny que findOneOwned)', async () => {
      queryBuilderMock.getOne.mockResolvedValue(
        buildStatusRow({ scope: 'lot', lotId: 'lot-1', fieldId: null }),
      );

      await expect(
        service.findOneOwnedStatus('analysis-1', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
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
      const analyses = [
        buildAnalysis({ id: 'a1' }),
        buildAnalysis({ id: 'a2' }),
      ];
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
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findByField('field-1', 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(analysisRepository.find).not.toHaveBeenCalled();
    });

    it('propaga NotFoundException si el Field no existe, sin consultar el historial', async () => {
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.findByField('missing-field', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(analysisRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('getReportPath / getReportPdfPath', () => {
    // AUTH-4: estos métodos reciben el Analysis ya validado por
    // findOneOwned — no hacen ningún lookup propio, así que estructuralmente
    // no pueden saltarse el chequeo de ownership.
    it('getReportPath devuelve el path si el análisis tiene reporte generado', () => {
      const analysis = buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          report: { htmlPath: '/tmp/report.html' },
        },
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
      const built = {
        stream: {} as any,
        filename: 'agroscore-reporte-campo-a-2026-01-01.pdf',
      };

      fieldsService.findOne.mockResolvedValue(field);
      reportPdfService.build.mockResolvedValue(built);

      const result = await service.buildReportPdf(analysis, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(
        analysisVerdictService.findResponseByAnalysisId,
      ).toHaveBeenCalledWith('analysis-1');
      expect(reportPdfService.build).toHaveBeenCalledWith(
        analysis,
        field,
        null,
      );
      expect(result).toBe(built);
    });

    // PR 11D: el PDF nunca regenera el veredicto — solo lee lo que ya persiste
    // AnalysisVerdictService y lo pasa tal cual a ReportPdfService.build.
    it('pasa el technicalVerdict ya persistido a ReportPdfService.build sin regenerarlo', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      const field = buildField();
      const technicalVerdict = {
        status: 'generated' as const,
        verdict: 'favorable' as const,
        confidence: 'high' as const,
        summary: 'Resumen.',
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
        generator: 'deterministic-v1',
        promptVersion: null,
      };

      fieldsService.findOne.mockResolvedValue(field);
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
        technicalVerdict,
      );
      reportPdfService.build.mockResolvedValue({
        stream: {} as any,
        filename: 'x.pdf',
      });

      await service.buildReportPdf(analysis, 'user-A');

      expect(reportPdfService.build).toHaveBeenCalledWith(
        analysis,
        field,
        technicalVerdict,
      );
      expect(analysisVerdictService.generateAndPersist).not.toHaveBeenCalled();
    });

    it('resuelve el Field por scope=null legacy (fieldId guardado en lotId)', async () => {
      const analysis = buildAnalysis({
        scope: null,
        lotId: 'field-1',
        fieldId: null,
      });
      const field = buildField();

      fieldsService.findOne.mockResolvedValue(field);
      reportPdfService.build.mockResolvedValue({
        stream: {} as any,
        filename: 'x.pdf',
      });

      await service.buildReportPdf(analysis, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
    });

    it('lanza NotFoundException para scope=lot sin llamar a FieldsService ni a ReportPdfService', async () => {
      const analysis = buildAnalysis({
        scope: 'lot',
        lotId: 'lot-1',
        fieldId: null,
      });

      await expect(
        service.buildReportPdf(analysis, 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fieldsService.findOne).not.toHaveBeenCalled();
      expect(reportPdfService.build).not.toHaveBeenCalled();
    });

    it('propaga NotFoundException si el Field resuelto es de otro usuario, sin generar el PDF', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      fieldsService.findOne.mockRejectedValue(
        new NotFoundException('Campo no encontrado.'),
      );

      await expect(
        service.buildReportPdf(analysis, 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reportPdfService.build).not.toHaveBeenCalled();
    });

    it('propaga el error de ReportPdfService.build (p.ej. análisis sin datos suficientes)', async () => {
      const analysis = buildAnalysis({ scope: 'field', fieldId: 'field-1' });
      fieldsService.findOne.mockResolvedValue(buildField());
      reportPdfService.build.mockRejectedValue(
        new NotFoundException(
          'El análisis no tiene datos suficientes para generar el reporte.',
        ),
      );

      await expect(service.buildReportPdf(analysis, 'user-A')).rejects.toThrow(
        'El análisis no tiene datos suficientes para generar el reporte.',
      );
    });
  });

  describe('findOneOwnedWithVerdict (PR 11A)', () => {
    it('adjunta technicalVerdict resuelto desde AnalysisVerdictService, preservando el resto del análisis', async () => {
      const analysis = buildAnalysis({
        scope: 'field',
        fieldId: 'field-1',
        globalScore: 82,
      });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockResolvedValue(buildField());
      const verdictResponse = {
        status: 'generated',
        verdict: 'favorable',
        confidence: 'high',
        summary: 'ok',
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        generatedAt: '2026-01-01T00:00:00.000Z',
        generator: 'deterministic-v1',
        promptVersion: null,
      } as any;
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(
        verdictResponse,
      );

      const result = await service.findOneOwnedWithVerdict(
        'analysis-1',
        'user-A',
      );

      expect(result.technicalVerdict).toBe(verdictResponse);
      expect(result.globalScore).toBe(82);
      expect(
        analysisVerdictService.findResponseByAnalysisId,
      ).toHaveBeenCalledWith('analysis-1');
    });

    it('technicalVerdict es null si todavía no existe ninguna fila (p.ej. análisis Procesando)', async () => {
      const analysis = buildAnalysis({
        scope: 'field',
        fieldId: 'field-1',
        status: 'Procesando',
      });
      analysisRepository.findOne.mockResolvedValue(analysis);
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisVerdictService.findResponseByAnalysisId.mockResolvedValue(null);

      const result = await service.findOneOwnedWithVerdict(
        'analysis-1',
        'user-A',
      );

      expect(result.technicalVerdict).toBeNull();
    });

    it('propaga NotFoundException de findOneOwned sin llegar a consultar AnalysisVerdictService', async () => {
      analysisRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOneOwnedWithVerdict('missing', 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        analysisVerdictService.findResponseByAnalysisId,
      ).not.toHaveBeenCalled();
    });
  });

  describe('runFieldAnalysis → processFieldAnalysisInBackground (PR 11A: veredicto técnico)', () => {
    const buildFieldInput = () => ({
      fieldId: 'field-1',
      name: 'Campo A',
      lots: [
        {
          id: 'lot-1',
          name: 'Lote 1',
          geojson: {},
          areaHa: 10,
          includeInProductivityClassification: true,
        },
      ],
    });

    const workerResult = {
      globalScore: 82,
      category: 'Buena aptitud productiva',
      confidenceScore: 90,
      productivityScore: 80,
      stabilityScore: 70,
      soilScore: 60,
      climateScore: 50,
      ndviAverageMax: 0.7,
      ndviVariability: 'Media' as const,
      zonesDetected: 3,
      resultJson: {
        mode: 'python-worker-v2' as const,
        message: '',
        totalsByZone: [{ zone: 0, name: 'Alta', hectares: 10, percent: 100 }],
      },
    };

    const runAnalysisAndFlush = async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(
        buildFieldInput() as any,
      );
      analysisRepository.findOne
        .mockResolvedValueOnce(null) // sin análisis Procesando duplicado
        .mockResolvedValueOnce(
          buildAnalysis({
            id: 'analysis-1',
            status: 'Procesando',
            startedAt: new Date(),
          }),
        ); // this.findOne(analysisId) dentro de processFieldAnalysisInBackground

      await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      await flushBackgroundWork();
    };

    it('al finalizar exitosamente, genera y persiste el veredicto técnico con el análisis ya guardado como Finalizado', async () => {
      pythonWorkerService.runFieldAnalysis.mockResolvedValue(
        workerResult as any,
      );

      await runAnalysisAndFlush();

      expect(analysisVerdictService.generateAndPersist).toHaveBeenCalledTimes(
        1,
      );
      const persistedAnalysis =
        analysisVerdictService.generateAndPersist.mock.calls[0][0];
      expect(persistedAnalysis.status).toBe('Finalizado');
      expect(persistedAnalysis.globalScore).toBe(82);
    });

    it('si la generación del veredicto falla, el análisis sigue guardado como Finalizado (no se revierte ni se marca Error)', async () => {
      pythonWorkerService.runFieldAnalysis.mockResolvedValue(
        workerResult as any,
      );
      analysisVerdictService.generateAndPersist.mockRejectedValue(
        new Error('boom'),
      );

      await runAnalysisAndFlush();

      const finalizedSaveCalls = analysisRepository.save.mock.calls.filter(
        ([entity]) => entity.status === 'Finalizado',
      );
      const errorSaveCalls = analysisRepository.save.mock.calls.filter(
        ([entity]) => entity.status === 'Error',
      );
      expect(finalizedSaveCalls.length).toBeGreaterThan(0);
      expect(errorSaveCalls).toHaveLength(0);
    });

    it('nunca llama a AnalysisVerdictService si el pipeline del worker falla (no hay análisis exitoso que interpretar)', async () => {
      pythonWorkerService.runFieldAnalysis.mockRejectedValue(
        new Error('worker caído'),
      );

      await runAnalysisAndFlush();

      expect(analysisVerdictService.generateAndPersist).not.toHaveBeenCalled();
    });

    // OPS-3 (RISK-053): PythonWorkerService ahora lanza mensajes públicos ya sanitizados (ver
    // PythonWorkerService.handleWorkerError) — este test confirma que AnalysisService los
    // persiste intactos (ni los reescribe ni los trunca de más) y, sobre todo, que
    // resultJson.error queda con el mismo valor que errorMessage — antes tomaba error.message
    // crudo sin el truncado de summarizeError().
    it('persiste el mensaje público del Worker intacto en errorMessage Y en resultJson.error (mismo valor)', async () => {
      const safeMessage =
        'Los parámetros enviados al motor de análisis no son válidos.';
      pythonWorkerService.runFieldAnalysis.mockRejectedValue(
        new BadRequestException(safeMessage),
      );

      await runAnalysisAndFlush();

      const errorSaveCall = analysisRepository.save.mock.calls.find(
        ([entity]) => entity.status === 'Error',
      );
      expect(errorSaveCall).toBeDefined();
      const [savedAnalysis] = errorSaveCall as [any];

      expect(savedAnalysis.errorMessage).toBe(safeMessage);
      expect(savedAnalysis.resultJson.error).toBe(safeMessage);
      expect(savedAnalysis.errorMessage).toBe(savedAnalysis.resultJson.error);
    });
  });

  describe('runFieldAnalysis — validación de rango de fechas (OPS-2)', () => {
    it('rechaza startDate === endDate con BadRequestException, sin llegar a consultar el dedupe', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-01-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toThrow(
        'La fecha de inicio debe ser estrictamente anterior a la fecha de fin.',
      );

      expect(analysisRepository.findOne).not.toHaveBeenCalled();
    });

    it('sigue rechazando startDate > endDate (comportamiento previo, sin regresión)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-06-01', endDate: '2024-01-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(analysisRepository.findOne).not.toHaveBeenCalled();
    });

    it('startDate < endDate sigue creando el Analysis con normalidad', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue({
        fieldId: 'field-1',
        name: 'Campo A',
        lots: [
          {
            id: 'lot-1',
            name: 'Lote 1',
            geojson: {},
            areaHa: 10,
            includeInProductivityClassification: true,
          },
        ],
      } as any);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
      expect(analysisRepository.save).toHaveBeenCalled();
    });
  });

  describe('runFieldAnalysis — dedupe de Procesando (OPS-1: stale vs. fresco)', () => {
    const buildFieldInput = () => ({
      fieldId: 'field-1',
      name: 'Campo A',
      lots: [
        {
          id: 'lot-1',
          name: 'Lote 1',
          geojson: {},
          areaHa: 10,
          includeInProductivityClassification: true,
        },
      ],
    });

    const minimalWorkerResult = {
      globalScore: 60,
      category: 'Media aptitud productiva',
      confidenceScore: 50,
      productivityScore: 50,
      stabilityScore: 50,
      soilScore: 0,
      climateScore: 0,
      ndviAverageMax: 0.5,
      ndviVariability: 'Media' as const,
      zonesDetected: 1,
      resultJson: { mode: 'python-worker-v2' as const, message: '' },
    };

    const STALE_MINUTES = 25; // > ANALYSIS_STALE_THRESHOLD_MS (20 min)
    const FRESH_MINUTES = 5;

    it('Procesando fresco: devuelve el existente sin marcarlo Error ni crear uno nuevo (dedupe actual sin cambios)', async () => {
      const freshAnalysis = buildAnalysis({
        id: 'fresh-analysis-1',
        status: 'Procesando',
        startedAt: new Date(Date.now() - FRESH_MINUTES * 60 * 1000),
      });
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.findOne.mockResolvedValueOnce(freshAnalysis);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBe(freshAnalysis);
      expect(analysisRepository.save).not.toHaveBeenCalled();
      expect(fieldsService.getPipelineInput).not.toHaveBeenCalled();
    });

    it('Procesando stale (más de 20 min): lo marca Error y crea un Analysis nuevo en la misma request', async () => {
      const staleAnalysis = buildAnalysis({
        id: 'stale-analysis-1',
        status: 'Procesando',
        startedAt: new Date(Date.now() - STALE_MINUTES * 60 * 1000),
      });
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(
        buildFieldInput() as any,
      );
      analysisRepository.findOne
        .mockResolvedValueOnce(staleAnalysis) // dedupe: encuentra el stale
        .mockResolvedValueOnce(
          buildAnalysis({
            id: 'analysis-1',
            status: 'Procesando',
            startedAt: new Date(),
          }),
        ); // this.findOne(analysisId) dentro de processFieldAnalysisInBackground, del nuevo
      pythonWorkerService.runFieldAnalysis.mockResolvedValue(
        minimalWorkerResult as any,
      );

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );
      await flushBackgroundWork();

      // El viejo quedó marcado Error con el mensaje fijo de staleness.
      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-analysis-1',
          status: 'Error',
          errorMessage:
            'El análisis superó el tiempo máximo de procesamiento y fue marcado automáticamente como Error.',
        }),
      );

      // Se creó y se devolvió un Analysis nuevo, no el viejo.
      expect(fieldsService.getPipelineInput).toHaveBeenCalledWith('field-1');
      expect(result.id).not.toBe('stale-analysis-1');
    });
  });

  describe('reconcileStaleAnalyses (OPS-1)', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const minutesAgo = (minutes: number) =>
      new Date(now.getTime() - minutes * 60 * 1000);

    it('consulta solo Analysis con status Procesando', async () => {
      analysisRepository.find.mockResolvedValue([]);

      await service.reconcileStaleAnalyses(now);

      expect(analysisRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'Procesando' } }),
      );
    });

    it('marca Error los Analysis Procesando que superaron el umbral de staleness', async () => {
      const stale = buildAnalysis({
        id: 'stale-1',
        status: 'Procesando',
        startedAt: minutesAgo(25),
      });
      analysisRepository.find.mockResolvedValue([stale]);

      await service.reconcileStaleAnalyses(now);

      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stale-1',
          status: 'Error',
          failedAt: now,
          errorMessage:
            'El análisis superó el tiempo máximo de procesamiento y fue marcado automáticamente como Error.',
        }),
      );
    });

    it('no toca un Analysis Procesando reciente', async () => {
      const fresh = buildAnalysis({
        id: 'fresh-1',
        status: 'Procesando',
        startedAt: minutesAgo(5),
      });
      analysisRepository.find.mockResolvedValue([fresh]);

      await service.reconcileStaleAnalyses(now);

      expect(analysisRepository.save).not.toHaveBeenCalled();
    });

    it('un fallo al marcar uno como Error no frena la reconciliación de los demás', async () => {
      const broken = buildAnalysis({
        id: 'broken-1',
        status: 'Procesando',
        startedAt: minutesAgo(25),
      });
      const healthy = buildAnalysis({
        id: 'healthy-1',
        status: 'Procesando',
        startedAt: minutesAgo(30),
      });
      analysisRepository.find.mockResolvedValue([broken, healthy]);
      analysisRepository.save
        .mockRejectedValueOnce(new Error('DB caída'))
        .mockResolvedValueOnce({ id: 'healthy-1', status: 'Error' });

      await expect(
        service.reconcileStaleAnalyses(now),
      ).resolves.toBeUndefined();

      expect(analysisRepository.save).toHaveBeenCalledTimes(2);
    });
  });
});
