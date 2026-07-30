import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { FieldsService } from '../fields/fields.service';
import { Field } from '../fields/entities/field.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';

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

  beforeEach(async () => {
    const queryBuilderMock = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
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
      ],
    }).compile();

    service = module.get(AnalysisService);
    analysisRepository = module.get(getRepositoryToken(Analysis));
    fieldsService = module.get(FieldsService);
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

    it('getReportPdfPath devuelve el path si el análisis tiene PDF generado', () => {
      const analysis = buildAnalysis({
        resultJson: { mode: 'python-worker-v2', message: '', report: { pdfPath: '/tmp/report.pdf' } },
      });

      expect(service.getReportPdfPath(analysis)).toBe('/tmp/report.pdf');
    });

    it('getReportPdfPath lanza NotFoundException si no hay PDF generado', () => {
      const analysis = buildAnalysis({ resultJson: null });

      expect(() => service.getReportPdfPath(analysis)).toThrow(
        'El análisis no tiene PDF generado.',
      );
    });
  });
});
