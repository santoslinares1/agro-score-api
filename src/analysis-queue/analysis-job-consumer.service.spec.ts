import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AnalysisService } from '../analysis/analysis.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { WorkerCallFailure } from '../python-worker/worker-call-failure';
import {
  AnalysisExecutionStore,
  ClaimResult,
} from './analysis-execution.store';
import { buildAnalysisInputSnapshot } from './analysis-input-snapshot';
import { buildAnalysisExecutePayload } from './analysis-job.contract';
import { AnalysisJobConsumerService } from './analysis-job-consumer.service';
import { QueueJob } from './analysis-job-queue';
import { resolveAnalysisQueueConfig } from './analysis-queue.config';

/**
 * ADR-001: el consumidor con dependencias controladas. Lo que se prueba acá es la DECISIÓN
 * (¿llamar al Worker? ¿qué disposición para pg-boss? ¿qué se persiste?) — la atomicidad, los
 * guards SQL y pg-boss real viven en test/analysis-queue.integration-spec.ts.
 */
// expect.objectContaining devuelve `any`; tiparlo evita no-unsafe-assignment en los matchers.
const containing = (value: Record<string, unknown>): unknown =>
  expect.objectContaining(value);

describe('AnalysisJobConsumerService', () => {
  const snapshot = buildAnalysisInputSnapshot(
    {
      fieldId: 'field-1',
      name: 'Campo',
      lots: [
        {
          id: 'lot-1',
          name: 'Lote 1',
          geojson: { type: 'Polygon', coordinates: [] },
          areaHa: 5,
          includeInProductivityClassification: true,
        },
      ],
    },
    {
      startDate: '2026-01-01',
      endDate: '2026-06-01',
      maxCloudiness: 30,
      includeMapAssets: true,
    },
  );
  const claimed: ClaimResult = {
    kind: 'claimed',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    fieldId: 'field-1',
    analysisStartedAt: new Date(),
    snapshot,
  };
  const payload = buildAnalysisExecutePayload({
    analysisId: 'analysis-1',
    fieldId: 'field-1',
    requestedByUserId: 'user-1',
    trigger: 'manual',
  });
  const job = (overrides: Partial<QueueJob> = {}): QueueJob => ({
    id: 'job-1',
    data: payload,
    retryCount: 0,
    retryLimit: 2,
    ...overrides,
  });
  const workerError = (status: number | null, code: string | null = null) =>
    new ServiceUnavailableException('público', {
      cause: new WorkerCallFailure('analyze', status, code),
    });

  let store: jest.Mocked<
    Pick<
      AnalysisExecutionStore,
      | 'claimAttempt'
      | 'touchAttempt'
      | 'finalizeSuccess'
      | 'recordAttemptFailure'
      | 'failBeforeExecution'
    >
  >;
  let worker: { runFieldAnalysis: jest.Mock };
  let analysisService: jest.Mocked<
    Pick<
      AnalysisService,
      | 'buildFinalizedResultFields'
      | 'findOne'
      | 'generateTechnicalVerdictBestEffort'
    >
  >;
  let consumer: AnalysisJobConsumerService;

  beforeEach(() => {
    store = {
      claimAttempt: jest.fn().mockResolvedValue(claimed),
      touchAttempt: jest.fn().mockResolvedValue(undefined),
      finalizeSuccess: jest.fn().mockResolvedValue('finalized'),
      recordAttemptFailure: jest.fn().mockResolvedValue(undefined),
      failBeforeExecution: jest.fn().mockResolvedValue(undefined),
    };
    worker = {
      runFieldAnalysis: jest.fn().mockResolvedValue({ globalScore: 80 }),
    };
    analysisService = {
      buildFinalizedResultFields: jest
        .fn()
        .mockReturnValue({ globalScore: 80 }),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'analysis-1', status: 'Finalizado' }),
      generateTechnicalVerdictBestEffort: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    consumer = new AnalysisJobConsumerService(
      store as unknown as AnalysisExecutionStore,
      worker as unknown as PythonWorkerService,
      analysisService as unknown as AnalysisService,
      resolveAnalysisQueueConfig(() => undefined),
    );
  });

  it('camino feliz: reclama, llama al Worker con el input del SNAPSHOT, finaliza y genera veredicto después', async () => {
    await expect(consumer.handle(job())).resolves.toBe('completed');

    expect(store.claimAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisId: 'analysis-1',
        jobId: 'job-1',
        attemptNumber: 1,
      }),
    );
    expect(worker.runFieldAnalysis).toHaveBeenCalledTimes(1);
    expect(worker.runFieldAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: 'field-1',
        includeMapAssets: true,
        lots: snapshot.lots,
      }),
    );
    expect(analysisService.buildFinalizedResultFields).toHaveBeenCalledWith(
      { globalScore: 80 },
      'field-1',
      snapshot.lots,
    );
    expect(store.finalizeSuccess.mock.invocationCallOrder[0]).toBeLessThan(
      analysisService.generateTechnicalVerdictBestEffort.mock
        .invocationCallOrder[0],
    );
  });

  it('un fallo del veredicto nunca convierte en Error un Analysis ya Finalizado', async () => {
    analysisService.findOne.mockRejectedValue(new Error('db'));

    await expect(consumer.handle(job())).resolves.toBe('completed');
    expect(store.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it.each<[string, ClaimResult]>([
    [
      'Analysis Finalizado (retry tardío)',
      { kind: 'terminal', status: 'Finalizado' },
    ],
    ['Analysis Error', { kind: 'terminal', status: 'Error' }],
    [
      'otro intento vivo (job duplicado ya reclamado)',
      { kind: 'busy', runningAttemptId: 'x' },
    ],
  ])('%s → completed SIN llamar al Worker', async (_label, claim) => {
    store.claimAttempt.mockResolvedValue(claim);

    await expect(consumer.handle(job())).resolves.toBe('completed');
    expect(worker.runFieldAnalysis).not.toHaveBeenCalled();
    expect(store.finalizeSuccess).not.toHaveBeenCalled();
  });

  it('Analysis inexistente → deadletter sin llamar al Worker', async () => {
    store.claimAttempt.mockResolvedValue({ kind: 'not_found' });

    await expect(consumer.handle(job())).resolves.toBe('deadletter');
    expect(worker.runFieldAnalysis).not.toHaveBeenCalled();
  });

  it.each(['field_unavailable', 'invalid_snapshot'] as const)(
    '%s → Analysis Error + intento terminal + deadletter, sin Worker',
    async (kind) => {
      store.claimAttempt.mockResolvedValue({ kind });

      await expect(consumer.handle(job())).resolves.toBe('deadletter');
      expect(store.failBeforeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          analysisId: 'analysis-1',
          classification: containing({
            code: kind,
            retryable: false,
          }),
        }),
      );
      expect(worker.runFieldAnalysis).not.toHaveBeenCalled();
    },
  );

  it('payload con versión de contrato desconocida → Error + deadletter sin reclamar ni llamar al Worker', async () => {
    await expect(
      consumer.handle(job({ data: { ...payload, contractVersion: 7 } })),
    ).resolves.toBe('deadletter');

    expect(store.claimAttempt).not.toHaveBeenCalled();
    expect(store.failBeforeExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: containing({
          code: 'unsupported_contract_version',
        }),
      }),
    );
    expect(worker.runFieldAnalysis).not.toHaveBeenCalled();
  });

  it.each([
    [workerError(400), 'worker_bad_request'],
    [workerError(422), 'worker_unprocessable'],
    [new BadRequestException('geometría'), 'invalid_input'],
  ])(
    'error no reintentable (%s) → Error inmediato + deadletter (no consume reintentos)',
    async (error, code) => {
      worker.runFieldAnalysis.mockRejectedValue(error);

      await expect(consumer.handle(job())).resolves.toBe('deadletter');
      expect(worker.runFieldAnalysis).toHaveBeenCalledTimes(1);
      expect(store.recordAttemptFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: true,
          classification: containing({ code, retryable: false }),
        }),
      );
    },
  );

  it.each([
    [workerError(null, 'ECONNABORTED')],
    [workerError(null, 'ECONNREFUSED')],
    [workerError(429)],
    [workerError(503)],
  ])(
    'error transitorio con intentos restantes → failed (pg-boss reintenta), Analysis sigue Procesando',
    async (error) => {
      worker.runFieldAnalysis.mockRejectedValue(error);

      await expect(
        consumer.handle(job({ retryCount: 0, retryLimit: 2 })),
      ).resolves.toBe('failed');
      expect(store.recordAttemptFailure).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: false }),
      );
    },
  );

  it('error transitorio en el ÚLTIMO intento → Error persistido + failed (pg-boss lo deja failed y lo copia al DLQ)', async () => {
    worker.runFieldAnalysis.mockRejectedValue(workerError(500));

    await expect(
      consumer.handle(job({ retryCount: 2, retryLimit: 2 })),
    ).resolves.toBe('failed');
    expect(store.claimAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptNumber: 3 }),
    );
    expect(store.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        classification: containing({
          code: 'worker_server_error',
          publicMessage:
            'El análisis no pudo completarse después de varios intentos.',
        }),
      }),
    );
  });

  it('resultado tardío sobre un Analysis ya terminal → superseded, sin veredicto ni sobrescritura', async () => {
    store.finalizeSuccess.mockResolvedValue('superseded');

    await expect(consumer.handle(job())).resolves.toBe('completed');
    expect(
      analysisService.generateTechnicalVerdictBestEffort,
    ).not.toHaveBeenCalled();
  });

  it('falla propia al persistir el resultado → reintentable (failed)', async () => {
    store.finalizeSuccess.mockRejectedValue(new Error('db caída'));

    await expect(consumer.handle(job())).resolves.toBe('failed');
  });
});
