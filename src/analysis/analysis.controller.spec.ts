import { GoneException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

jest.mock('fs');

describe('AnalysisController', () => {
  let controller: AnalysisController;
  let analysisService: jest.Mocked<
    Pick<
      AnalysisService,
      | 'findOneOwned'
      | 'getReportPath'
      | 'getReportPdfPath'
      | 'findAll'
      | 'findByField'
      | 'runFieldAnalysis'
    >
  >;

  const user: AuthenticatedUser = { sub: 'user-A', email: 'usera@example.com', role: 'owner' };
  const req = { user } as any;

  const buildRes = () => {
    const res: any = { setHeader: jest.fn() };
    return res;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        {
          provide: AnalysisService,
          useValue: {
            findOneOwned: jest.fn(),
            getReportPath: jest.fn(),
            getReportPdfPath: jest.fn(),
            findAll: jest.fn(),
            findByField: jest.fn(),
            runFieldAnalysis: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(AnalysisController);
    analysisService = module.get(AnalysisService);
    jest.clearAllMocks();
  });

  describe('legacy: POST lots/:lotId/analysis', () => {
    it('bloquea con GoneException sin tocar el service (AUTH-5)', () => {
      expect(() => controller.createForLot('lot-1')).toThrow(GoneException);
      expect(analysisService.findOneOwned).not.toHaveBeenCalled();
    });
  });

  describe('delegación simple con req.user.sub', () => {
    it('findOne llama a findOneOwned(id, user.sub)', () => {
      controller.findOne('analysis-1', req);
      expect(analysisService.findOneOwned).toHaveBeenCalledWith('analysis-1', 'user-A');
    });

    it('findAll llama a findAll(user.sub)', () => {
      controller.findAll(req);
      expect(analysisService.findAll).toHaveBeenCalledWith('user-A');
    });

    it('findByField llama a findByField(fieldId, user.sub)', () => {
      controller.findByField('field-1', req);
      expect(analysisService.findByField).toHaveBeenCalledWith('field-1', 'user-A');
    });

    it('runFieldAnalysis llama a runFieldAnalysis(fieldId, body, user.sub)', () => {
      const body = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 } as any;
      controller.runFieldAnalysis('field-1', body, req);
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith('field-1', body, 'user-A');
    });
  });

  describe('reportes: gate de ownership antes de tocar el filesystem (AUTH-4)', () => {
    const cases: Array<{
      name: string;
      call: (id: string, req: any, res: any) => Promise<unknown>;
      pathMethod: 'getReportPath' | 'getReportPdfPath';
      contentType: string;
      disposition: string;
    }> = [
      {
        name: 'getReport',
        call: (id, r, res) => controller.getReport(id, r, res),
        pathMethod: 'getReportPath',
        contentType: 'text/html; charset=utf-8',
        disposition: 'inline; filename="agro-score-report-analysis-1.html"',
      },
      {
        name: 'downloadReport',
        call: (id, r, res) => controller.downloadReport(id, r, res),
        pathMethod: 'getReportPath',
        contentType: 'text/html; charset=utf-8',
        disposition: 'attachment; filename="agro-score-report-analysis-1.html"',
      },
      {
        name: 'downloadPdfReport',
        call: (id, r, res) => controller.downloadPdfReport(id, r, res),
        pathMethod: 'getReportPdfPath',
        contentType: 'application/pdf',
        disposition: 'attachment; filename="agro-score-report-analysis-1.pdf"',
      },
    ];

    for (const testCase of cases) {
      describe(testCase.name, () => {
        it('si findOneOwned rechaza (ajeno/legacy), nunca llega a leer el path ni el filesystem', async () => {
          analysisService.findOneOwned.mockRejectedValue(
            new NotFoundException('Análisis no encontrado.'),
          );

          await expect(
            testCase.call('analysis-1', req, buildRes()),
          ).rejects.toBeInstanceOf(NotFoundException);

          expect(analysisService[testCase.pathMethod]).not.toHaveBeenCalled();
          expect(fs.existsSync).not.toHaveBeenCalled();
          expect(fs.createReadStream).not.toHaveBeenCalled();
        });

        it('si el análisis es propio pero no tiene reporte generado, propaga el error del service sin tocar fs', async () => {
          analysisService.findOneOwned.mockResolvedValue({ id: 'analysis-1' } as any);
          (analysisService[testCase.pathMethod] as jest.Mock).mockImplementation(() => {
            throw new NotFoundException('El análisis no tiene reporte generado.');
          });

          await expect(testCase.call('analysis-1', req, buildRes())).rejects.toThrow(
            'El análisis no tiene reporte generado.',
          );

          expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it('si el path no existe en disco, responde 404 sin exponer contenido', async () => {
          analysisService.findOneOwned.mockResolvedValue({ id: 'analysis-1' } as any);
          (analysisService[testCase.pathMethod] as jest.Mock).mockReturnValue('/tmp/does-not-exist');
          (fs.existsSync as jest.Mock).mockReturnValue(false);

          await expect(testCase.call('analysis-1', req, buildRes())).rejects.toThrow(
            /no existe/,
          );

          expect(fs.createReadStream).not.toHaveBeenCalled();
        });

        it('camino feliz: ownership + path + archivo existente -> sirve el stream con los headers correctos', async () => {
          analysisService.findOneOwned.mockResolvedValue({ id: 'analysis-1' } as any);
          (analysisService[testCase.pathMethod] as jest.Mock).mockReturnValue('/tmp/report.file');
          (fs.existsSync as jest.Mock).mockReturnValue(true);
          const pipeMock = jest.fn();
          (fs.createReadStream as jest.Mock).mockReturnValue({ pipe: pipeMock });

          const res = buildRes();
          await testCase.call('analysis-1', req, res);

          expect(res.setHeader).toHaveBeenCalledWith('Content-Type', testCase.contentType);
          expect(res.setHeader).toHaveBeenCalledWith(
            'Content-Disposition',
            testCase.disposition,
          );
          expect(fs.createReadStream).toHaveBeenCalledWith('/tmp/report.file');
          expect(pipeMock).toHaveBeenCalledWith(res);
        });
      });
    }
  });
});
