import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { FieldsService } from '../fields/fields.service';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
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
  query: jest.Mock;
};

/**
 * F02: verificación INDEPENDIENTE de la duración de un fixture de fecha, deliberadamente
 * separada de `daysBetweenIsoDates` (analysis-constraints.ts, la función productiva que este
 * archivo ejercita vía AnalysisService.runFieldAnalysis) — sirve para blindar contra fixtures mal
 * etiquetados (ver la deficiencia de "366 días" corregida en esta ficha: un test decía "366 días"
 * con un rango que en realidad eran 365), no para volver a validar la función bajo prueba.
 */
function _actualDaysBetween(startDate: string, endDate: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / MS_PER_DAY);
}

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
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    getQueryAndParameters: jest.Mock;
  };
  /** F04: última carga pasada a queryBuilderMock.values({...}) — permite que el mock de
   * analysisRepository.query "eco" esos mismos campos en la fila devuelta, igual que el viejo
   * mock de save((entity) => ({ id, ...entity })) hacía. No es SQL real: solo mantiene el
   * contrato (forma de los datos) que el resto de estos tests unitarios ya asumía. */
  let lastInsertValues: Record<string, unknown> = {};

  beforeEach(async () => {
    lastInsertValues = {};
    queryBuilderMock = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn((values: Record<string, unknown>) => {
        lastInsertValues = values;
        return queryBuilderMock;
      }),
      getQueryAndParameters: jest.fn(() => ['INSERT INTO "analysis" (...) VALUES (...)', []]),
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
            // F04: runFieldAnalysis ya no hace create()+save() para la fila nueva — hace un solo
            // INSERT ... ON CONFLICT ... RETURNING atómico vía query(). Por default simula un
            // INSERT exitoso (inserted=true), ecoando los mismos campos que se le pasaron a
            // .values(...) — igual forma de datos que el viejo mock de save(), para no romper los
            // tests que no están probando la deduplicación de F04 en sí (ver
            // analysis-dedup-race.e2e-spec.ts para la evidencia real de esa carrera, con
            // PostgreSQL real). Los tests de F04 específicos pisan esto con mockResolvedValueOnce.
            query: jest.fn(() =>
              Promise.resolve([{ id: 'analysis-1', ...lastInsertValues, inserted: true }]),
            ),
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

    // F01 (pendiente de la revisión independiente): field-detail.component.ts consume este
    // resumen liviano (sin resultJson) para el historial de un campo — sin esta señal, no había
    // forma de que Web supiera si un globalScore=0 era una ausencia de evidencia o un cero real.
    it('F01: globalScoreAvailable=true si resultJson es null (compatibilidad con análisis previos)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.find.mockResolvedValue([buildAnalysis({ resultJson: null })]);

      const [summary] = await service.findByField('field-1', 'user-A');

      expect(summary.globalScoreAvailable).toBe(true);
    });

    it('F01: globalScoreAvailable=true si resultJson no trae dataAvailability (análisis previos al fix del worker)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.find.mockResolvedValue([
        buildAnalysis({ resultJson: { mode: 'python-worker-v2', message: '' } }),
      ]);

      const [summary] = await service.findByField('field-1', 'user-A');

      expect(summary.globalScoreAvailable).toBe(true);
    });

    it('F01: globalScoreAvailable=false si resultJson.dataAvailability.globalScore es false', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.find.mockResolvedValue([
        buildAnalysis({
          globalScore: 0,
          resultJson: {
            mode: 'python-worker-v2',
            message: '',
            dataAvailability: {
              productivity: false,
              stability: false,
              confidence: false,
              ndviAverageMax: false,
              globalScore: false,
            },
          },
        }),
      ]);

      const [summary] = await service.findByField('field-1', 'user-A');

      expect(summary.globalScoreAvailable).toBe(false);
      expect(summary.globalScore).toBe(0);
    });

    it('F01: globalScoreAvailable=true si resultJson.dataAvailability.globalScore es true (cero legítimo incluido)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      analysisRepository.find.mockResolvedValue([
        buildAnalysis({
          globalScore: 0,
          resultJson: {
            mode: 'python-worker-v2',
            message: '',
            dataAvailability: {
              productivity: true,
              stability: true,
              confidence: true,
              ndviAverageMax: true,
              globalScore: true,
            },
          },
        }),
      ]);

      const [summary] = await service.findByField('field-1', 'user-A');

      expect(summary.globalScoreAvailable).toBe(true);
      expect(summary.globalScore).toBe(0);
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

  describe('assertUserBelowConcurrencyCeiling (SEC-008)', () => {
    /** Mismo criterio que python-worker.service.spec.ts::captureError — permite inspeccionar el
     * status/mensaje del HttpException lanzado, no solo su tipo. */
    async function captureError(promise: Promise<unknown>): Promise<any> {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error('Se esperaba que la promesa rechazara, pero resolvió.');
    }

    it('permite el request si el usuario está por debajo del techo (2 de 3)', async () => {
      analysisRepository.query.mockResolvedValueOnce([{ count: 2 }]);

      await expect(
        service.assertUserBelowConcurrencyCeiling('user-A'),
      ).resolves.toBeUndefined();
    });

    it('rechaza con 429 si el usuario está exactamente en el techo (3 de 3)', async () => {
      analysisRepository.query.mockResolvedValueOnce([{ count: 3 }]);

      const error = await captureError(
        service.assertUserBelowConcurrencyCeiling('user-A'),
      );

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('rechaza si el usuario ya está por encima del techo', async () => {
      analysisRepository.query.mockResolvedValueOnce([{ count: 7 }]);

      const error = await captureError(
        service.assertUserBelowConcurrencyCeiling('user-A'),
      );

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('el mensaje no revela el conteo interno, "Earth Engine" ni "worker"', async () => {
      analysisRepository.query.mockResolvedValueOnce([{ count: 5 }]);

      const error = await captureError(
        service.assertUserBelowConcurrencyCeiling('user-A'),
      );

      expect(error.message).not.toMatch(/\d/);
      expect(error.message.toLowerCase()).not.toContain('earth engine');
      expect(error.message.toLowerCase()).not.toContain('worker');
    });

    it('cuenta vía Field.userId (join), filtrando por status Procesando', async () => {
      analysisRepository.query.mockResolvedValueOnce([{ count: 0 }]);

      await service.assertUserBelowConcurrencyCeiling('user-A');

      expect(analysisRepository.query).toHaveBeenCalledWith(
        expect.stringContaining(`"status" = 'Procesando'`),
        ['user-A'],
      );
      expect(analysisRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('f."userId" = $1'),
        ['user-A'],
      );
    });
  });

  describe('runFieldAnalysis nunca dispara el techo de concurrencia por sí solo (SEC-008, regresión)', () => {
    // Crítico: el dispatcher automático (ScheduledAnalysisRunnerService.processDueSchedules) llama
    // a runFieldAnalysis directo, secuencialmente, para cada schedule vencido de un usuario. Si el
    // techo viviera DENTRO de runFieldAnalysis, una cuenta con más campos programados que
    // MAX_CONCURRENT_ANALYSES_PER_USER vería sus propios schedules automáticos fallar entre sí la
    // misma noche. El chequeo vive exclusivamente en los callers manuales (AnalysisController,
    // ScheduledAnalysisRunnerService.runNow) — ver el comentario completo en
    // AnalysisService.assertUserBelowConcurrencyCeiling.
    it('no invoca assertUserBelowConcurrencyCeiling', async () => {
      const ceilingSpy = jest.spyOn(service, 'assertUserBelowConcurrencyCeiling');
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

      await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(ceilingSpy).not.toHaveBeenCalled();
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
      // F04: la creación ya no pasa por save() — es un INSERT ... ON CONFLICT ... RETURNING
      // atómico vía query() (ver analysis.service.ts). save() sigue existiendo para otras
      // escrituras (marcar Error un stale, actualizar a Finalizado en background), pero no para
      // esta.
      expect(analysisRepository.query).toHaveBeenCalled();
    });
  });

  describe('runFieldAnalysis — validación de duración máxima del rango (F02)', () => {
    const pipelineInputStub = {
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
    } as any;

    it('reproduce el bug reportado: 2024-09-05 → 2026-09-05 (730 días, el recorrido de defaults de 24 meses de Web) se rechaza sin crear Analysis ni consultar el dedupe', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-09-05', endDate: '2026-09-05', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toThrow(
        'El rango entre la fecha de inicio y la fecha de fin no puede superar 366 días (elegido: 730 días). Elegí un rango más corto.',
      );

      expect(analysisRepository.findOne).not.toHaveBeenCalled();
      expect(analysisRepository.save).not.toHaveBeenCalled();
      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('acepta exactamente 365 días', async () => {
      // Deficiencia detectada en la evidencia previa: este fixture (2025-01-01 → 2026-01-01)
      // estaba antes en un test titulado "acepta exactamente 366 días", pero 2025 no es bisiesto:
      // son 365 días, no 366. `_actualDaysBetween` de acá abajo NO es la función productiva bajo
      // prueba (`daysBetweenIsoDates` de analysis-constraints.ts) — es un cálculo independiente
      // con `Date` nativo, justo para que un mislabeling de fixture como este no vuelva a pasar
      // desapercibido (si dependiera de la misma función que valida, un bug ahí "confirmaría" la
      // duración incorrecta en vez de detectarla).
      const startDate = '2025-01-01';
      const endDate = '2026-01-01';
      expect(_actualDaysBetween(startDate, endDate)).toBe(365);

      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate, endDate, maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
      // F04: la creación ya no pasa por save() — es un INSERT ... ON CONFLICT ... RETURNING
      // atómico vía query() (ver analysis.service.ts). save() sigue existiendo para otras
      // escrituras (marcar Error un stale, actualizar a Finalizado en background), pero no para
      // esta.
      expect(analysisRepository.query).toHaveBeenCalled();
    });

    it('acepta exactamente 366 días (límite inclusive, mismo criterio que limits.py del Worker: `> MAX_DATE_RANGE_DAYS` rechaza, no `>=`)', async () => {
      // Mismo startDate que el caso de 365 días, un día más de rango.
      const startDate = '2025-01-01';
      const endDate = '2026-01-02';
      expect(_actualDaysBetween(startDate, endDate)).toBe(366);

      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate, endDate, maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
      // F04: la creación ya no pasa por save() — es un INSERT ... ON CONFLICT ... RETURNING
      // atómico vía query() (ver analysis.service.ts). save() sigue existiendo para otras
      // escrituras (marcar Error un stale, actualizar a Finalizado en background), pero no para
      // esta.
      expect(analysisRepository.query).toHaveBeenCalled();
    });

    it('rechaza 367 días — un día por encima del límite', async () => {
      const startDate = '2025-01-01';
      const endDate = '2026-01-03';
      expect(_actualDaysBetween(startDate, endDate)).toBe(367);

      fieldsService.findOne.mockResolvedValue(buildField());

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate, endDate, maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(analysisRepository.save).not.toHaveBeenCalled();
    });

    it('año bisiesto: un rango de 12 meses calendario que atraviesa un 29 de febrero da exactamente 366 días y se acepta', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      // 2023-03-01 → 2024-03-01 atraviesa el 29/2/2024 (2024 es bisiesto) → 366 días exactos.
      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2023-03-01', endDate: '2024-03-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
    });

    it('año bisiesto: el mismo rango de 12 meses calendario un día después (2023-03-02 → 2024-03-02) sigue dando 366 días y se acepta (no se corre por el bisiesto)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2023-03-02', endDate: '2024-03-02', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
    });

    it('cambio de año calendario sin bisiesto de por medio: 2025-06-15 → 2026-06-15 da 365 días y se acepta', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2025-06-15', endDate: '2026-06-15', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
    });

    it('un rango personalizado válido (dentro del límite) llega al Worker con las MISMAS fechas que eligió el usuario, sin recortarlas', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(pipelineInputStub);
      analysisRepository.findOne.mockResolvedValueOnce(null);

      await service.runFieldAnalysis(
        'field-1',
        { startDate: '2025-05-10', endDate: '2025-11-20', maxCloudiness: 30 },
        'user-A',
      );

      // F04: la creación ya no pasa por save() — el INSERT atómico arma sus valores vía
      // queryBuilder.insert().values({...}) (ver analysis.service.ts). El mock de
      // queryBuilderMock.values captura exactamente lo que runFieldAnalysis le pasó.
      expect(queryBuilderMock.values).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: '2025-05-10',
          endDate: '2025-11-20',
        }),
      );
    });
  });

  describe('runFieldAnalysis — scheduled-analysis (F05: ventana móvil de 7 días) no se ve afectado por el límite de F02 (regresión)', () => {
    it('un rango de 7 días (el que usa siempre scheduled-analysis) nunca se acerca al límite de 366 días', async () => {
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
        { startDate: '2026-08-25', endDate: '2026-09-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toBeDefined();
      // F04: la creación ya no pasa por save() — es un INSERT ... ON CONFLICT ... RETURNING
      // atómico vía query() (ver analysis.service.ts). save() sigue existiendo para otras
      // escrituras (marcar Error un stale, actualizar a Finalizado en background), pero no para
      // esta.
      expect(analysisRepository.query).toHaveBeenCalled();
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

  /**
   * F04: estos tests son UNITARIOS (repositorio mockeado) — verifican la lógica de
   * catch-y-reutilización de runFieldAnalysis en aislamiento (isUniqueViolation, el refetch, no
   * disparar background en la rama perdedora), no la carrera real de Postgres. La evidencia de
   * concurrencia real (dos conexiones, contención genuina en el índice único, observada vía
   * pg_stat_activity) vive en test/analysis-dedup-race.e2e-spec.ts, contra una base PostgreSQL
   * real y descartable — un mock no puede demostrar que Postgres serializa dos INSERT que compiten
   * por el mismo índice único, solo que el código de este archivo reacciona correctamente SI eso
   * pasa.
   */
  describe('runFieldAnalysis — F04 (revisión independiente): pierde la carrera contra UQ_analysis_running_per_field (INSERT ... ON CONFLICT ... RETURNING simulado)', () => {
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

    it('query() devuelve inserted=false: reutiliza la fila ganadora ya existente, no lanza y no dispara un segundo procesamiento', async () => {
      // El mecanismo nuevo (ver analysis.service.ts) no lanza ante la carrera: el propio INSERT
      // ... ON CONFLICT ... DO UPDATE ... RETURNING (xmax = 0) AS inserted resuelve, en UNA sola
      // sentencia atómica, si esta request insertó la fila (inserted=true) o si otra ya la había
      // insertado y esta solo "tocó" la existente vía el DO UPDATE no-op (inserted=false). No hay
      // save() ni un catch+refetch por separado que simular acá.
      const winner = buildAnalysis({ id: 'winner-analysis-1', status: 'Procesando' });

      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(buildFieldInput() as any);
      analysisRepository.findOne.mockResolvedValueOnce(null); // fast-path: "¿hay uno corriendo?" — no, todavía no (la carrera real ocurre después, en el query() atómico).
      analysisRepository.query.mockResolvedValueOnce([{ ...winner, inserted: false }]);

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result).toEqual(winner);
      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('query() rechaza con un error que NO es la carrera de deduplicación: se propaga tal cual', async () => {
      // A diferencia del mecanismo viejo, acá no hay ningún código (23505 vs. otro) que
      // discriminar en JS: la discriminación "¿es específicamente el conflicto de
      // UQ_analysis_running_per_field?" ya la hace Postgres en la propia sentencia, vía el WHERE
      // de la inference specification del ON CONFLICT — esa cláusula solo dispara el DO UPDATE
      // (y por lo tanto un resultado con inserted=false, sin rechazo) para ESE índice puntual.
      // Cualquier otro rechazo de query() (constraint distinta, NOT NULL, columna inexistente,
      // lo que sea) nunca pasa por esa rama y llega acá como un rechazo crudo de la promesa, que
      // runFieldAnalysis no atrapa ni reinterpreta.
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput.mockResolvedValue(buildFieldInput() as any);
      analysisRepository.findOne.mockResolvedValueOnce(null);
      const notNullViolation = Object.assign(new Error('null value in column "lotName"'), {
        code: '23502',
      });
      analysisRepository.query.mockRejectedValueOnce(notNullViolation);

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toBe(notNullViolation);

      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('a. gana el slot (inserted=true) pero getPipelineInput lanza porque el campo se quedó sin lotes cargados: excepción REAL de FieldsService (no simulada), marca la fila como Error y propaga la excepción original', async () => {
      // F04 (revisión independiente, ronda 3): a diferencia de los demás tests de este archivo
      // (FieldsService completamente mockeado), acá se usa una instancia REAL de FieldsService —
      // con solo su Repository<Field>/Repository<FieldLot> mockeados — para que la excepción que
      // se propaga sea la que getPipelineInput() efectivamente lanza en producción
      // ('El campo no tiene lotes internos cargados.', NotFoundException), no una imitación con
      // el mismo texto tipeada a mano en el test.
      const fieldRepoMock = {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'field-1', userId: 'user-A', name: 'Campo A', lots: [] }),
      };
      const realFieldsService = new FieldsService(
        fieldRepoMock as any,
        {} as any, // FieldLotRepository: getPipelineInput/findOne no lo tocan directamente.
      );
      const realService = new AnalysisService(
        analysisRepository as any,
        pythonWorkerService as any,
        realFieldsService,
        reportPdfService as any,
        analysisVerdictService as any,
      );

      analysisRepository.findOne.mockResolvedValueOnce(null); // fast-path: nada corriendo todavía.

      const failedCall = realService.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      await expect(failedCall).rejects.toBeInstanceOf(NotFoundException);
      await expect(failedCall).rejects.toThrow('El campo no tiene lotes internos cargados.');

      // Ganó el slot vía el INSERT atómico — no vía save().
      expect(analysisRepository.query).toHaveBeenCalled();

      // El slot se liberó: la fila recién creada quedó Error, con el mensaje REAL de la excepción
      // que efectivamente se propagó (no un texto aparte) — estado persistido, no solo la llamada.
      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'Error',
          errorMessage: 'El campo no tiene lotes internos cargados.',
          failedAt: expect.any(Date),
          durationMs: expect.any(Number),
        }),
      );

      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('b. gana el slot (inserted=true) pero getPipelineInput falla por un error de lectura/preparación genérico (no por falta de lotes): marca la fila como Error, propaga la excepción original SIN modificarla, y si la propia compensación también fallara lo registraría sin ocultar la causa original', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      const preparationError = new Error('Timeout leyendo el campo desde Postgres.');
      fieldsService.getPipelineInput.mockRejectedValueOnce(preparationError);
      analysisRepository.findOne.mockResolvedValueOnce(null); // fast-path.

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toBe(preparationError); // la excepción ORIGINAL, sin envolver ni reemplazar.

      expect(analysisRepository.query).toHaveBeenCalled();
      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'Error',
          errorMessage: 'Timeout leyendo el campo desde Postgres.',
          category: 'Error al procesar análisis de campo',
        }),
      );
      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('b (límite). si la propia escritura compensatoria TAMBIÉN falla, se registra ese segundo fallo pero la excepción que llega al caller sigue siendo la ORIGINAL, no la del save() fallido', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      const preparationError = new Error('El campo no tiene lotes internos cargados.');
      fieldsService.getPipelineInput.mockRejectedValueOnce(preparationError);
      analysisRepository.findOne.mockResolvedValueOnce(null);
      const compensationSaveError = new Error('DB caída también al intentar marcar Error.');
      analysisRepository.save.mockRejectedValueOnce(compensationSaveError);

      const loggerErrorSpy = jest.spyOn((service as any).logger, 'error');

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toBe(preparationError); // NUNCA el compensationSaveError.

      // El fallo de la propia compensación queda registrado (no silenciado), mencionando AMBAS
      // causas — pero sin sustituir la excepción que efectivamente llega al caller.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('El campo no tiene lotes internos cargados.'),
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DB caída también al intentar marcar Error.'),
      );

      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    it('d. tras un fallo de preparación (a o b), un pedido posterior para el MISMO campo puede crear un análisis nuevo y dispararlo con normalidad (el slot quedó liberado, no bloqueado)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      fieldsService.getPipelineInput
        .mockRejectedValueOnce(new Error('Fallo de preparación transitorio.'))
        .mockResolvedValueOnce(buildFieldInput() as any);
      analysisRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toThrow('Fallo de preparación transitorio.');

      // El primer intento quedó Error (liberó el slot) — se verifica ANTES del segundo intento,
      // no solo "se llamó a save()".
      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Error' }),
      );

      const result = await service.runFieldAnalysis(
        'field-1',
        { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
        'user-A',
      );

      expect(result.status).toBe('Procesando');
      expect(pythonWorkerService.runFieldAnalysis).toHaveBeenCalledTimes(1);
    });

    it('c. gana el slot (inserted=true) pero hasIncludedLot es false (lotes existentes, ninguno habilitado): marca la fila recién creada como Error (no la deja como reserva permanente) y propaga el BadRequestException de siempre', async () => {
      // F04 (revisión independiente, ronda 2): desde esa ronda, el INSERT atómico se ejecuta ANTES
      // de getPipelineInput (para achicar la ventana de carrera) — así que para cuando se descubre
      // que el campo no tiene lotes habilitados, esta request YA ganó el slot (existe una fila
      // 'Procesando' propia). Dejarla así sería la reserva permanente que F04 prohíbe.
      // F04 (revisión independiente, ronda 3): la compensación ahora pasa por
      // markPreparationFailureOnWonSlot, el mismo mecanismo unificado que cubre CUALQUIER fallo de
      // preparación (no solo este) — el errorMessage persistido es el mensaje real de la excepción
      // (vía summarizeError), no un texto aparte hardcodeado.
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
            includeInProductivityClassification: false, // ningún lote habilitado
          },
        ],
      } as any);
      analysisRepository.findOne.mockResolvedValueOnce(null); // fast-path: nada corriendo todavía.

      await expect(
        service.runFieldAnalysis(
          'field-1',
          { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 },
          'user-A',
        ),
      ).rejects.toThrow(
        'El campo no tiene ningún lote incluido en la clasificación productiva. Habilitá al menos un lote antes de analizar.',
      );

      // Ganó el slot vía el INSERT atómico (query()) — no vía save().
      expect(analysisRepository.query).toHaveBeenCalled();

      // Y la fila recién creada se marcó Error de inmediato, liberando el slot — no queda
      // colgada como 'Procesando' bloqueando al próximo intento. Verifica el ESTADO persistido
      // (no solo que save() se llamó): status, errorMessage con el texto real de la excepción,
      // failedAt/durationMs poblados y el slot correctamente liberado.
      expect(analysisRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'Error',
          errorMessage:
            'El campo no tiene ningún lote incluido en la clasificación productiva. Habilitá al menos un lote antes de analizar.',
          failedAt: expect.any(Date),
          durationMs: expect.any(Number),
        }),
      );

      expect(pythonWorkerService.runFieldAnalysis).not.toHaveBeenCalled();
    });

    /**
     * F04 (revisión independiente): acá existía un tercer test — "save() rechaza con 23505 pero
     * el refetch no encuentra ninguna fila Procesando (caso límite)" — que probaba un escenario
     * específico del mecanismo VIEJO: un catch de save() seguido de un refetch por separado que,
     * en teoría, podía no encontrar nada (p. ej. si la ganadora ya había sido borrada o corría
     * contra una réplica desincronizada).
     *
     * Ese escenario ya no es alcanzable con el mecanismo nuevo, y no por un descuido: es
     * justamente lo que el fix elimina. RETURNING no es un paso separado que pueda "no
     * encontrar" nada — es parte de la MISMA sentencia atómica que generó el conflicto. Por
     * construcción, si `inserted=false`, `rows[0]` existe siempre (fue la propia base la que lo
     * devolvió al resolver el conflicto). No hay ventana entre "hubo conflicto" y "leer qué lo
     * causó" que dejar sin cubrir. Se elimina el test en vez de forzar una reinterpretación
     * artificial de un caso que ya no existe.
     */
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
