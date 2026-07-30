import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AxiosResponse } from 'axios';
import { of } from 'rxjs';

import { PythonWorkerService } from './python-worker.service';
import { PipelineInput, WorkerAnalysisResult } from './types';

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
