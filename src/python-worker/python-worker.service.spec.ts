import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AxiosError, AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';

import { MAX_ANALYSIS_CLOUDINESS } from '../analysis/analysis-constraints';
import { PythonWorkerService } from './python-worker.service';
import { PipelineInput, WeeklyReportWorkerInput, WorkerAnalysisResult } from './types';

const buildInput = (overrides: Partial<PipelineInput> = {}): PipelineInput => ({
  lotId: 'lot-1',
  name: 'Lote 1',
  location: 'Córdoba',
  geojson: {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  },
  startDate: '2024-01-01',
  endDate: '2024-06-01',
  maxCloudiness: 30,
  areaHa: 10,
  ...overrides,
});

// Compartido entre OPS-2 (clamp de maxCloudiness) y OPS-3 (clasificación de errores) — shape
// estructural de FieldWorkerInput (no exportado desde python-worker.service.ts), alcanza con que
// el objeto matchee.
const buildFieldInput = (overrides: Record<string, unknown> = {}) => ({
  fieldId: 'field-1',
  name: 'Campo A',
  startDate: '2024-01-01',
  endDate: '2024-06-01',
  maxCloudiness: 30,
  lots: [
    {
      id: 'lot-1',
      name: 'Lote 1',
      geojson: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      areaHa: 10,
      includeInProductivityClassification: true,
    },
  ],
  ...overrides,
});

const buildWeeklyReportInput = (
  overrides: Partial<WeeklyReportWorkerInput> = {},
): WeeklyReportWorkerInput => ({
  fieldId: 'field-1',
  lots: [
    {
      id: 'lot-1',
      name: 'Lote 1',
      geojson: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
    },
  ],
  campaignStart: '2024-01-01',
  campaignEnd: null,
  targetDate: '2024-01-08',
  indices: ['NDVI', 'NDMI'],
  includeNdreExperimental: false,
  ...overrides,
});

/**
 * OPS-3: construye un AxiosError falso sin depender de la implementación interna de axios — solo
 * el shape que PythonWorkerService.handleWorkerError realmente lee (`response.status`,
 * `response.data`, `code`, `message`).
 */
const buildAxiosError = (options: {
  status?: number;
  data?: unknown;
  code?: string;
  message?: string;
}): AxiosError => {
  const { status, data, code, message } = options;

  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: message ?? 'Error',
    code,
    response:
      status === undefined
        ? undefined
        : ({
            status,
            data,
            statusText: '',
            headers: {},
            config: {} as AxiosResponse['config'],
          } as AxiosResponse),
    toJSON: () => ({}),
  } as AxiosError;
};

/** Espera a que `promise` rechace y devuelve el error capturado, en vez de dejarlo sin manejar. */
async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Se esperaba que la promesa rechazara, pero resolvió.');
}

const buildWorkerResult = (): WorkerAnalysisResult => ({
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
  resultJson: { mode: 'python-worker-v2', message: 'ok' },
});

const buildAxiosResponse = (
  data: WorkerAnalysisResult,
): AxiosResponse<WorkerAnalysisResult> => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as AxiosResponse['config'],
});

/**
 * Reconstruye el service con un ConfigService mockeado a `configuredUrl`,
 * porque PYTHON_WORKER_URL se lee una sola vez en el constructor (ver
 * PythonWorkerService.constructor) — no alcanza con cambiar el mock después
 * de instanciado.
 */
async function createService(configuredUrl: string | undefined) {
  const httpService = { post: jest.fn() };
  const configService = { get: jest.fn().mockReturnValue(configuredUrl) };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PythonWorkerService,
      { provide: HttpService, useValue: httpService },
      { provide: ConfigService, useValue: configService },
    ],
  }).compile();

  return {
    service: module.get(PythonWorkerService),
    httpService,
    configService,
  };
}

describe('PythonWorkerService', () => {
  it('should be defined', async () => {
    const { service } = await createService('http://worker:9000');
    expect(service).toBeDefined();
  });

  it('usa PYTHON_WORKER_URL de ConfigService para armar la URL del worker (sin hacer requests reales)', async () => {
    const { service, httpService, configService } = await createService(
      'http://worker-configurado:9000',
    );
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    await service.runAnalysis(buildInput());

    expect(configService.get).toHaveBeenCalledWith('PYTHON_WORKER_URL');
    expect(httpService.post).toHaveBeenCalledTimes(1);
    expect(httpService.post).toHaveBeenCalledWith(
      'http://worker-configurado:9000/analyze',
      expect.anything(),
      expect.anything(),
    );
  });

  it('si no hay PYTHON_WORKER_URL configurada, cae al default http://localhost:8000', async () => {
    const { service, httpService } = await createService(undefined);
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    await service.runAnalysis(buildInput());

    expect(httpService.post).toHaveBeenCalledWith(
      'http://localhost:8000/analyze',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('PythonWorkerService — normalización defensiva de maxCloudiness (OPS-2)', () => {
  const lastPostedPayload = (httpService: { post: jest.Mock }): { max_cloud_pct: number } =>
    httpService.post.mock.calls[0][1];

  // RISK-004 / OPS-2: este clamp NO es la validación pública (esa vive en RunFieldAnalysisDto/
  // CreateFieldDto, ver *.dto.spec.ts) — protege específicamente contra un Field.maxCloudiness
  // persistido antes del fix, que scheduled-analysis reutiliza sin volver a validar.
  it('un valor persistido por encima del límite (90) se recorta a MAX_ANALYSIS_CLOUDINESS en el payload de campo', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    await service.runFieldAnalysis(buildFieldInput({ maxCloudiness: 90 }) as any);

    expect(lastPostedPayload(httpService).max_cloud_pct).toBe(MAX_ANALYSIS_CLOUDINESS);
  });

  it('un valor normal (dentro del límite) llega intacto al Worker', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    await service.runFieldAnalysis(buildFieldInput({ maxCloudiness: 50 }) as any);

    expect(lastPostedPayload(httpService).max_cloud_pct).toBe(50);
  });

  it('sin maxCloudiness (undefined), conserva el default actual del flujo de campo (30), no lo trata como dato inválido a acotar', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    const input = buildFieldInput();
    delete (input as Record<string, unknown>).maxCloudiness;

    await service.runFieldAnalysis(input as any);

    expect(lastPostedPayload(httpService).max_cloud_pct).toBe(30);
  });

  it('un valor persistido por encima del límite también se recorta en el flujo legacy de lote único', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(of(buildAxiosResponse(buildWorkerResult())));

    await service.runAnalysis(buildInput({ maxCloudiness: 95 }));

    expect(lastPostedPayload(httpService).max_cloud_pct).toBe(MAX_ANALYSIS_CLOUDINESS);
  });
});

describe('PythonWorkerService — clasificación de errores del Worker (OPS-3, RISK-053)', () => {
  // Cobertura completa de los 5 casos vía /analyze (runFieldAnalysis) — runWeeklyReport comparte
  // el mismo handleWorkerError, así que más abajo solo se prueba que también lo usa (2 casos
  // representativos), sin repetir la clasificación entera.

  it('400 del Worker (validación de negocio) → BadRequestException con mensaje público, sin el detail del Worker', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({
          status: 400,
          data: { detail: 'max_cloud_pct debe estar entre 0 y 80 (recibido: 90).' },
        }),
      ),
    );

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('Los parámetros enviados al motor de análisis no son válidos.');
    expect(error.message).not.toContain('max_cloud_pct');
    expect(error.message).not.toContain('80');
  });

  it('422 del Worker (shape de Pydantic) → BadRequestException con mensaje público, nunca el array detail', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({
          status: 422,
          data: {
            detail: [{ loc: ['body', 'lots'], msg: 'field required', type: 'value_error.missing' }],
          },
        }),
      ),
    );

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('El motor de análisis rechazó el formato de los datos enviados.');
    expect(error.message).not.toContain('loc');
    expect(error.message).not.toContain('value_error');
    expect(error.message).not.toContain('[object');
  });

  it('5xx del Worker (fallo interno) → ServiceUnavailableException con mensaje público, sin el detail del Worker', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({
          status: 500,
          data: { detail: 'No se pudo completar el análisis. Si el problema persiste, contactá al equipo.' },
        }),
      ),
    );

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('El motor de análisis no pudo completar la operación.');
  });

  it('timeout (ECONNABORTED) → ServiceUnavailableException con mensaje de timeout, sin el valor crudo en ms', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({ code: 'ECONNABORTED', message: 'timeout of 600000ms exceeded' }),
      ),
    );

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('El motor de análisis excedió el tiempo máximo de respuesta.');
    expect(error.message).not.toContain('600000');
  });

  it('red/DNS/connection refused (sin response, sin timeout) → ServiceUnavailableException con mensaje de indisponibilidad, sin IP/puerto/código de Axios', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8000' }),
      ),
    );

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('El motor de análisis no está disponible temporalmente.');
    expect(error.message).not.toContain('127.0.0.1');
    expect(error.message).not.toContain('8000');
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('logger.error recibe un objeto reducido y controlado (code/status/responseData/message) — nunca el AxiosError completo', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    const loggerErrorSpy = jest.spyOn((service as any).logger, 'error');
    httpService.post.mockReturnValue(
      throwError(() =>
        buildAxiosError({
          status: 400,
          data: { detail: 'max_cloud_pct debe estar entre 0 y 80 (recibido: 90).' },
        }),
      ),
    );

    await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [logLine] = loggerErrorSpy.mock.calls[0] as [string];

    // El contexto de la operación sí viaja en el log (para poder distinguir analyze/weekly-report
    // al buscar en logs reales), y el detail completo del Worker también — el log interno SÍ
    // puede tener el detalle que el mensaje público no tiene.
    expect(logLine).toContain('operation=analyze');
    expect(logLine).toContain('max_cloud_pct');

    const jsonPart = logLine.slice(logLine.indexOf('{'));
    const parsed = JSON.parse(jsonPart);

    // Objeto reducido: exactamente estas 4 claves, nunca `config`/`request`/`isAxiosError`/`stack`
    // (que sí traería el AxiosError completo, y que en un futuro con auth service-to-service
    // podría incluir headers de Authorization).
    expect(Object.keys(parsed).sort()).toEqual(['code', 'message', 'responseData', 'status']);
    expect(parsed.status).toBe(400);
  });

  it('un fallo sin instanceof Error (objeto plano) no rompe la clasificación — cae al caso de indisponibilidad general', async () => {
    const { service, httpService } = await createService('http://worker:9000');
    httpService.post.mockReturnValue(throwError(() => ({ weird: 'not-an-error' })));

    const error = await captureError(service.runFieldAnalysis(buildFieldInput() as any));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe('El motor de análisis no está disponible temporalmente.');
  });

  // runWeeklyReport comparte handleWorkerError con postToWorker — estos 2 casos alcanzan para
  // confirmar que realmente lo usa (mensajes públicos + tipo de excepción), sin repetir los 5
  // casos ya cubiertos arriba.
  describe('runWeeklyReport comparte la misma clasificación', () => {
    it('400 del Worker → BadRequestException con el mismo mensaje público que /analyze', async () => {
      const { service, httpService } = await createService('http://worker:9000');
      httpService.post.mockReturnValue(
        throwError(() =>
          buildAxiosError({
            status: 400,
            data: { detail: 'Tenés que enviar al menos un lote.' },
          }),
        ),
      );

      const error = await captureError(service.runWeeklyReport(buildWeeklyReportInput()));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('Los parámetros enviados al motor de análisis no son válidos.');
    });

    it('red/DNS (sin response) → ServiceUnavailableException con el mismo mensaje público que /analyze', async () => {
      const { service, httpService } = await createService('http://worker:9000');
      httpService.post.mockReturnValue(
        throwError(() =>
          buildAxiosError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND worker-interno' }),
        ),
      );

      const error = await captureError(service.runWeeklyReport(buildWeeklyReportInput()));

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toBe('El motor de análisis no está disponible temporalmente.');
      expect(error.message).not.toContain('worker-interno');
    });
  });
});
