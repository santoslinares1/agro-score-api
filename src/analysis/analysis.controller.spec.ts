import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GoneException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitter } from 'events';
import * as fs from 'fs';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

jest.mock('fs');

describe('AnalysisController', () => {
  let controller: AnalysisController;
  let analysisService: jest.Mocked<
    Pick<
      AnalysisService,
      | 'findOneOwned'
      | 'findOneOwnedWithVerdict'
      | 'findOneOwnedStatus'
      | 'getReportPath'
      | 'buildReportPdf'
      | 'findAll'
      | 'findByField'
      | 'runFieldAnalysis'
      | 'assertUserBelowConcurrencyCeiling'
      | 'markResultViewed'
      | 'markPdfDownloaded'
    >
  >;

  const user: AuthenticatedUser = {
    sub: 'user-A',
    email: 'usera@example.com',
    role: 'owner',
  };
  const req = { user } as any;

  // MEASUREMENT GAP P1-04: `res` real (http.ServerResponse, y Express Response que lo extiende)
  // es un EventEmitter — downloadPdfReport ahora depende de `res.once('finish', ...)`. Un mock
  // plano `{ setHeader: jest.fn() }` ya no alcanza; se necesita un emitter real para poder
  // disparar 'finish'/'close' de forma determinística desde los tests.
  const buildRes = () => {
    const res = new EventEmitter() as EventEmitter & { setHeader: jest.Mock };
    res.setHeader = jest.fn();
    return res;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      // SEC-008: AnalysisController.runFieldAnalysis ahora lleva
      // @UseGuards(JwtAuthGuard, UserComputeThrottlerGuard) — UserComputeThrottlerGuard extiende
      // ThrottlerGuard, cuyo constructor pide (options, storageService, reflector) inyectados;
      // ThrottlerModule.forRoot(...) es lo que provee esos tokens (mismo import que
      // auth.controller.spec.ts ya usa para probar ThrottlerGuard).
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 20 },
          { name: 'compute', ttl: 600_000, limit: 10 },
        ]),
      ],
      controllers: [AnalysisController],
      providers: [
        UserComputeThrottlerGuard,
        {
          provide: AnalysisService,
          useValue: {
            findOneOwned: jest.fn(),
            findOneOwnedWithVerdict: jest.fn(),
            findOneOwnedStatus: jest.fn(),
            getReportPath: jest.fn(),
            buildReportPdf: jest.fn(),
            findAll: jest.fn(),
            findByField: jest.fn(),
            runFieldAnalysis: jest.fn(),
            assertUserBelowConcurrencyCeiling: jest.fn(),
            markResultViewed: jest.fn(),
            markPdfDownloaded: jest.fn().mockResolvedValue(undefined),
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
    // PR 11A: GET /analysis/:id ahora resuelve technicalVerdict junto con el análisis — ver
    // AnalysisService.findOneOwnedWithVerdict. Las rutas de reporte (getReport/downloadReport/
    // downloadPdfReport) siguen usando findOneOwned "pelado" sin cambios.
    it('findOne llama a findOneOwnedWithVerdict(id, user.sub), no a findOneOwned', () => {
      controller.findOne('analysis-1', req);
      expect(analysisService.findOneOwnedWithVerdict).toHaveBeenCalledWith(
        'analysis-1',
        'user-A',
      );
      expect(analysisService.findOneOwned).not.toHaveBeenCalled();
    });

    it('findOne devuelve exactamente lo que resuelve el service, incluido technicalVerdict', async () => {
      const withVerdict = {
        id: 'analysis-1',
        status: 'Finalizado',
        globalScore: 82,
        technicalVerdict: {
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
        },
      };
      analysisService.findOneOwnedWithVerdict.mockResolvedValue(
        withVerdict as any,
      );

      const result = await controller.findOne('analysis-1', req);

      expect(result).toBe(withVerdict);
    });

    it('findOneStatus (PERF-2) llama a findOneOwnedStatus(id, user.sub), no a findOneOwned', () => {
      controller.findOneStatus('analysis-1', req);
      expect(analysisService.findOneOwnedStatus).toHaveBeenCalledWith(
        'analysis-1',
        'user-A',
      );
      expect(analysisService.findOneOwned).not.toHaveBeenCalled();
    });

    it('findAll llama a findAll(user.sub)', () => {
      controller.findAll(req);
      expect(analysisService.findAll).toHaveBeenCalledWith('user-A');
    });

    it('findByField llama a findByField(fieldId, user.sub)', () => {
      controller.findByField('field-1', req);
      expect(analysisService.findByField).toHaveBeenCalledWith(
        'field-1',
        'user-A',
      );
    });

    it('runFieldAnalysis llama a runFieldAnalysis(fieldId, body, user.sub) — DESPUÉS de pasar el techo de concurrencia', async () => {
      const body = {
        startDate: '2024-01-01',
        endDate: '2024-06-01',
        maxCloudiness: 30,
      } as any;
      const callOrder: string[] = [];
      analysisService.assertUserBelowConcurrencyCeiling.mockImplementation(
        () => {
          callOrder.push('ceiling');
          return Promise.resolve();
        },
      );
      analysisService.runFieldAnalysis.mockImplementation(() => {
        callOrder.push('runFieldAnalysis');
        return Promise.resolve({} as any);
      });

      await controller.runFieldAnalysis('field-1', body, req);

      expect(
        analysisService.assertUserBelowConcurrencyCeiling,
      ).toHaveBeenCalledWith('user-A');
      expect(analysisService.runFieldAnalysis).toHaveBeenCalledWith(
        'field-1',
        body,
        'user-A',
      );
      expect(callOrder).toEqual(['ceiling', 'runFieldAnalysis']);
    });

    // SEC-008: si el usuario está en el techo, el rechazo debe ocurrir ANTES de tocar
    // AnalysisService.runFieldAnalysis (que es lo que dispara el dedupe per-campo/Worker).
    it('runFieldAnalysis propaga el rechazo del techo de concurrencia sin llamar a runFieldAnalysis', async () => {
      const body = {
        startDate: '2024-01-01',
        endDate: '2024-06-01',
        maxCloudiness: 30,
      } as any;
      const rejection = new Error('429 simulado');
      analysisService.assertUserBelowConcurrencyCeiling.mockRejectedValue(
        rejection,
      );

      await expect(
        controller.runFieldAnalysis('field-1', body, req),
      ).rejects.toBe(rejection);

      expect(analysisService.runFieldAnalysis).not.toHaveBeenCalled();
    });
  });

  describe('SEC-008: rate limiting por usuario en runFieldAnalysis', () => {
    it('lleva UserComputeThrottlerGuard además de JwtAuthGuard', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (controller as any).runFieldAnalysis,
      ) as unknown[] | undefined;

      expect(guards).toContain(UserComputeThrottlerGuard);
    });

    it('usa el throttler "compute" (10 req / 10 min), no el bucket "default"', () => {
      const handler = (controller as any).runFieldAnalysis;

      expect(Reflect.getMetadata('THROTTLER:LIMITcompute', handler)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLcompute', handler)).toBe(
        600_000,
      );
      expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handler)).toBe(true);
    });
  });

  // MEASUREMENT GAP P1-03 ("Resultado técnico consultado") — POST /analysis/:id/result-viewed.
  describe('markResultViewed (MEASUREMENT GAP P1-03)', () => {
    it('lleva JwtAuthGuard — sin JWT, la request nunca llega al handler (401 vía el guard chain real, ver el patrón de user-compute-throttler.e2e-spec.ts)', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (controller as any).markResultViewed,
      ) as unknown[] | undefined;

      expect(guards).toContain(JwtAuthGuard);
    });

    it('invoca al service con (id, req.user.sub)', () => {
      controller.markResultViewed('analysis-1', req);

      expect(analysisService.markResultViewed).toHaveBeenCalledWith(
        'analysis-1',
        'user-A',
      );
    });

    it('devuelve exactamente lo que resuelve el service (respuesta mínima, sin resultJson)', async () => {
      const response = { firstResultViewedAt: '2026-01-05T12:00:00.000Z' };
      analysisService.markResultViewed.mockResolvedValue(response);

      const result = await controller.markResultViewed('analysis-1', req);

      expect(result).toBe(response);
    });

    it('propaga NotFoundException del service (análisis inexistente o ajeno) tal cual', async () => {
      analysisService.markResultViewed.mockRejectedValue(
        new NotFoundException('Análisis no encontrado.'),
      );

      await expect(
        controller.markResultViewed('missing-or-foreign', req),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('findOneStatus (PERF-2): respeta permisos igual que findOne', () => {
    it('propaga NotFoundException si el análisis no existe o es de otro usuario', async () => {
      analysisService.findOneOwnedStatus.mockRejectedValue(
        new NotFoundException('Análisis no encontrado.'),
      );

      await expect(
        controller.findOneStatus('missing-or-foreign', req),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('camino feliz: devuelve exactamente lo que resuelve el service (proyección liviana)', async () => {
      const statusDto = {
        id: 'analysis-1',
        status: 'Procesando',
        scope: 'field',
        fieldId: 'field-1',
        lotId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        startedAt: new Date('2026-01-01'),
        completedAt: null,
        failedAt: null,
        durationMs: null,
        errorMessage: null,
        globalScore: 0,
        productivityScore: 0,
        stabilityScore: 0,
        confidenceScore: 0,
      };
      analysisService.findOneOwnedStatus.mockResolvedValue(statusDto as any);

      const result = await controller.findOneStatus('analysis-1', req);

      expect(result).toBe(statusDto);
      expect(result).not.toHaveProperty('resultJson');
    });
  });

  describe('reportes HTML: gate de ownership antes de tocar el filesystem (AUTH-4)', () => {
    const cases: Array<{
      name: string;
      call: (id: string, req: any, res: any) => Promise<unknown>;
      pathMethod: 'getReportPath';
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
          analysisService.findOneOwned.mockResolvedValue({
            id: 'analysis-1',
          } as any);
          (
            analysisService[testCase.pathMethod] as jest.Mock
          ).mockImplementation(() => {
            throw new NotFoundException(
              'El análisis no tiene reporte generado.',
            );
          });

          await expect(
            testCase.call('analysis-1', req, buildRes()),
          ).rejects.toThrow('El análisis no tiene reporte generado.');

          expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it('si el path no existe en disco, responde 404 sin exponer contenido', async () => {
          analysisService.findOneOwned.mockResolvedValue({
            id: 'analysis-1',
          } as any);
          (analysisService[testCase.pathMethod] as jest.Mock).mockReturnValue(
            '/tmp/does-not-exist',
          );
          (fs.existsSync as jest.Mock).mockReturnValue(false);

          await expect(
            testCase.call('analysis-1', req, buildRes()),
          ).rejects.toThrow(/no existe/);

          expect(fs.createReadStream).not.toHaveBeenCalled();
        });

        it('camino feliz: ownership + path + archivo existente -> sirve el stream con los headers correctos', async () => {
          analysisService.findOneOwned.mockResolvedValue({
            id: 'analysis-1',
          } as any);
          (analysisService[testCase.pathMethod] as jest.Mock).mockReturnValue(
            '/tmp/report.file',
          );
          (fs.existsSync as jest.Mock).mockReturnValue(true);
          const pipeMock = jest.fn();
          (fs.createReadStream as jest.Mock).mockReturnValue({
            pipe: pipeMock,
          });

          const res = buildRes();
          await testCase.call('analysis-1', req, res);

          expect(res.setHeader).toHaveBeenCalledWith(
            'Content-Type',
            testCase.contentType,
          );
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

  describe('downloadPdfReport (PDF-1): gate de ownership antes de generar el PDF (AUTH-4)', () => {
    it('si findOneOwned rechaza (ajeno/legacy), nunca llega a generar el PDF', async () => {
      analysisService.findOneOwned.mockRejectedValue(
        new NotFoundException('Análisis no encontrado.'),
      );

      await expect(
        controller.downloadPdfReport('analysis-1', req, buildRes()),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(analysisService.buildReportPdf).not.toHaveBeenCalled();
    });

    it('si el análisis es propio pero no tiene datos suficientes, propaga el error del service', async () => {
      analysisService.findOneOwned.mockResolvedValue({
        id: 'analysis-1',
      } as any);
      analysisService.buildReportPdf.mockRejectedValue(
        new NotFoundException(
          'El análisis no tiene datos suficientes para generar el reporte.',
        ),
      );

      await expect(
        controller.downloadPdfReport('analysis-1', req, buildRes()),
      ).rejects.toThrow(
        'El análisis no tiene datos suficientes para generar el reporte.',
      );
    });

    it('camino feliz: ownership + PDF generado -> streamea la respuesta con los headers correctos', async () => {
      const analysis = { id: 'analysis-1' } as any;
      analysisService.findOneOwned.mockResolvedValue(analysis);

      const pipeMock = jest.fn();
      const endMock = jest.fn();
      analysisService.buildReportPdf.mockResolvedValue({
        stream: { pipe: pipeMock, end: endMock } as any,
        filename: 'agroscore-reporte-campo-a-2026-01-01.pdf',
      });

      const res = buildRes();
      await controller.downloadPdfReport('analysis-1', req, res);

      expect(analysisService.buildReportPdf).toHaveBeenCalledWith(
        analysis,
        'user-A',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/pdf',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="agroscore-reporte-campo-a-2026-01-01.pdf"',
      );
      expect(pipeMock).toHaveBeenCalledWith(res);
      expect(endMock).toHaveBeenCalled();
      // El listener queda registrado ANTES de pipe/end, pero markPdfDownloaded todavía no se
      // dispara — recién con 'finish' (ver el describe de abajo), nunca solo por conectar el pipe.
      expect(analysisService.markPdfDownloaded).not.toHaveBeenCalled();
    });
  });

  // MEASUREMENT GAP P1-04 ("PDF descargado"): lifecycle real de la respuesta HTTP — solo
  // 'finish' (el servidor terminó de ENTREGAR la respuesta) marca la descarga.
  describe('downloadPdfReport — lifecycle de finish/close (MEASUREMENT GAP P1-04)', () => {
    async function setupHappyPath(): Promise<
      EventEmitter & { setHeader: jest.Mock }
    > {
      const analysis = { id: 'analysis-1' } as any;
      analysisService.findOneOwned.mockResolvedValue(analysis);
      analysisService.buildReportPdf.mockResolvedValue({
        stream: { pipe: jest.fn(), end: jest.fn() } as any,
        filename: 'agroscore-reporte-campo-a-2026-01-01.pdf',
      });

      const res = buildRes();
      await controller.downloadPdfReport('analysis-1', req, res);
      return res;
    }

    it("'finish' marca la descarga exactamente una vez, con el id del análisis ya validado por ownership", async () => {
      const res = await setupHappyPath();

      res.emit('finish');

      expect(analysisService.markPdfDownloaded).toHaveBeenCalledTimes(1);
      expect(analysisService.markPdfDownloaded).toHaveBeenCalledWith(
        'analysis-1',
      );
    });

    it("el listener de 'finish' queda registrado ANTES de pipe/end (evita la carrera de un 'finish' síncrono)", async () => {
      const analysis = { id: 'analysis-1' } as any;
      analysisService.findOneOwned.mockResolvedValue(analysis);

      const pipeMock = jest.fn();
      const res = buildRes();
      // Simula un stream cuyo .pipe() dispara 'finish' SINCRÓNICAMENTE (peor caso de carrera:
      // si el listener se registrara DESPUÉS de pipe/end, este 'finish' se perdería).
      pipeMock.mockImplementation((destination: typeof res) => {
        destination.emit('finish');
        return destination;
      });
      analysisService.buildReportPdf.mockResolvedValue({
        stream: { pipe: pipeMock, end: jest.fn() } as any,
        filename: 'x.pdf',
      });

      await controller.downloadPdfReport('analysis-1', req, res);

      expect(analysisService.markPdfDownloaded).toHaveBeenCalledWith(
        'analysis-1',
      );
    });

    it("NEGATIVO: 'close' SIN 'finish' previo (cierre prematuro) nunca marca la descarga", async () => {
      const res = await setupHappyPath();

      res.emit('close'); // el cliente cortó la conexión antes de terminar — nunca 'finish'.

      expect(analysisService.markPdfDownloaded).not.toHaveBeenCalled();
    });

    it("'finish' seguido de 'close' (comportamiento normal del socket subyacente) no duplica la escritura", async () => {
      const res = await setupHappyPath();

      res.emit('finish');
      res.emit('close'); // normal después de una respuesta completa — no debe disparar nada más.

      expect(analysisService.markPdfDownloaded).toHaveBeenCalledTimes(1);
    });

    it("'finish' emitido dos veces por un mock/stream defectuoso no dispara una segunda llamada (.once, defensivo — el set-once real vive en el service)", async () => {
      const res = await setupHappyPath();

      res.emit('finish');
      res.emit('finish');

      expect(analysisService.markPdfDownloaded).toHaveBeenCalledTimes(1);
    });

    it('generación fallida (buildReportPdf rechaza) nunca llega a registrar el listener ni a marcar la descarga', async () => {
      analysisService.findOneOwned.mockResolvedValue({
        id: 'analysis-1',
      } as any);
      analysisService.buildReportPdf.mockRejectedValue(
        new NotFoundException(
          'El análisis no tiene datos suficientes para generar el reporte.',
        ),
      );
      const res = buildRes();

      await expect(
        controller.downloadPdfReport('analysis-1', req, res),
      ).rejects.toBeInstanceOf(NotFoundException);

      res.emit('finish'); // aunque algo externo lo emitiera después, no hay listener que reaccione.
      expect(analysisService.markPdfDownloaded).not.toHaveBeenCalled();
    });

    it('ownership fallido nunca genera el PDF ni conecta ningún listener de finish', async () => {
      analysisService.findOneOwned.mockRejectedValue(
        new NotFoundException('Análisis no encontrado.'),
      );
      const res = buildRes();

      await expect(
        controller.downloadPdfReport('analysis-1', req, res),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(analysisService.buildReportPdf).not.toHaveBeenCalled();

      res.emit('finish');
      expect(analysisService.markPdfDownloaded).not.toHaveBeenCalled();
    });

    it('persistencia rechazada (markPdfDownloaded) después de finish no altera la respuesta ya enviada — no hay nada que capturar del lado del controller', async () => {
      const res = await setupHappyPath();
      analysisService.markPdfDownloaded.mockRejectedValueOnce(
        new Error(
          'DB caída — no debería propagarse, ver el try/catch interno del service',
        ),
      );

      // El controller llama a markPdfDownloaded fire-and-forget (void) — no hay ninguna promesa
      // que el test deba esperar ni ningún catch en el controller: el contrato es que el
      // MÉTODO DEL SERVICE nunca rechaza (ver AnalysisService.markPdfDownloaded), así que esto
      // solo confirma que emitir 'finish' no lanza ni rompe el flujo del controller aunque el
      // mock puntual de este test decida rechazar.
      expect(() => res.emit('finish')).not.toThrow();
    });
  });
});
