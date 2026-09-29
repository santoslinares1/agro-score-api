import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { isAnalysisStale } from '../analysis/analysis-stale.util';
import { WorkerCallFailure } from '../python-worker/worker-call-failure';
import { classifyWorkerCallError } from './analysis-failure-classifier';
import {
  ANALYSIS_INPUT_SNAPSHOT_VERSION,
  buildAnalysisInputSnapshot,
  isSupportedAnalysisInputSnapshot,
  snapshotToWorkerInput,
} from './analysis-input-snapshot';
import {
  buildAnalysisExecutePayload,
  parseAnalysisExecutePayload,
} from './analysis-job.contract';
import { buildAnalysisQueueOptions } from './analysis-job-queue';
import { resolveAnalysisQueueConfig } from './analysis-queue.config';

const env = (values: Record<string, string>) => (key: string) => values[key];

describe('ADR-001 — configuración de la cola', () => {
  it('defaults del ticket: cola y runner deshabilitados, concurrencia 1, 3 intentos, 15 min, heartbeat 30s', () => {
    const config = resolveAnalysisQueueConfig(env({}));

    expect(config).toEqual(
      expect.objectContaining({
        enabled: false,
        weeklyEnabled: false,
        runnerEnabled: false,
        concurrency: 1,
        maxAttempts: 3,
        expireInSeconds: 900,
        heartbeatSeconds: 30,
        retryDelaySeconds: 60,
        retryDelayMaxSeconds: 1200,
        pgBossSchema: 'pgboss',
      }),
    );
  });

  it('lee todos los valores desde env (nada hardcodeado en los servicios)', () => {
    const config = resolveAnalysisQueueConfig(
      env({
        ANALYSIS_QUEUE_ENABLED: 'true',
        ANALYSIS_QUEUE_WEEKLY_ENABLED: 'true',
        ANALYSIS_JOB_RUNNER_ENABLED: 'true',
        ANALYSIS_JOB_CONCURRENCY: '2',
        ANALYSIS_JOB_MAX_ATTEMPTS: '5',
        ANALYSIS_JOB_EXPIRE_SECONDS: '600',
        ANALYSIS_JOB_HEARTBEAT_SECONDS: '20',
      }),
    );

    expect(config.enabled && config.weeklyEnabled && config.runnerEnabled).toBe(
      true,
    );
    expect(config.concurrency).toBe(2);
    expect(buildAnalysisQueueOptions(config)).toEqual(
      expect.objectContaining({
        retryLimit: 4,
        retryBackoff: true,
        expireInSeconds: 600,
        heartbeatSeconds: 20,
        deadLetter: 'analysis.execute.v1.dlq',
      }),
    );
  });

  it('rechaza valores inválidos en vez de improvisar (heartbeat < 10, enteros no válidos, schema inseguro)', () => {
    expect(() =>
      resolveAnalysisQueueConfig(env({ ANALYSIS_JOB_HEARTBEAT_SECONDS: '5' })),
    ).toThrow();
    expect(() =>
      resolveAnalysisQueueConfig(env({ ANALYSIS_JOB_MAX_ATTEMPTS: 'tres' })),
    ).toThrow();
    expect(() =>
      resolveAnalysisQueueConfig(
        env({ ANALYSIS_QUEUE_PGBOSS_SCHEMA: 'pg; drop' }),
      ),
    ).toThrow();
  });
});

describe('ADR-001 — contrato analysis.execute.v1', () => {
  const payload = buildAnalysisExecutePayload({
    analysisId: 'a-1',
    fieldId: 'f-1',
    requestedByUserId: 'u-1',
    trigger: 'weekly',
    scheduledRunId: 'run-1',
  });

  it('solo IDs y metadata de entrega, con idempotencyKey analysis:{id}', () => {
    expect(payload).toEqual({
      analysisId: 'a-1',
      fieldId: 'f-1',
      requestedByUserId: 'u-1',
      trigger: 'weekly',
      scheduledRunId: 'run-1',
      contractVersion: 1,
      idempotencyKey: 'analysis:a-1',
    });
    expect(parseAnalysisExecutePayload(payload)).toEqual({ ok: true, payload });
  });

  it('versión de contrato desconocida → unsupported_contract_version (conserva analysisId para cerrar el Analysis)', () => {
    expect(
      parseAnalysisExecutePayload({ ...payload, contractVersion: 2 }),
    ).toEqual({
      ok: false,
      reason: 'unsupported_contract_version',
      analysisId: 'a-1',
    });
  });

  it.each([
    { ...payload, trigger: 'cron' },
    { ...payload, idempotencyKey: 'analysis:otro' },
    { ...payload, fieldId: '' },
    null,
  ])('shape inválido → invalid_payload (%j)', (data) => {
    expect(parseAnalysisExecutePayload(data)).toEqual(
      expect.objectContaining({ ok: false, reason: 'invalid_payload' }),
    );
  });
});

describe('ADR-001 — snapshot inmutable del input', () => {
  const lots = [
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
            [0, 0],
          ],
        ],
      },
      areaHa: 10,
      includeInProductivityClassification: true,
    },
  ];

  it('captura lotes + todos los parámetros pedidos + versión, como copia profunda', () => {
    const pipelineInput = {
      fieldId: 'f-1',
      name: 'Campo',
      location: 'Córdoba',
      totalAreaHa: 10,
      lots,
    };
    const snapshot = buildAnalysisInputSnapshot(
      pipelineInput,
      {
        startDate: '2026-01-01',
        endDate: '2026-06-01',
        maxCloudiness: 40,
        indices: ['NDRE'],
        zoneIndices: ['NDVI'],
        indexImageIndices: ['NDMI'],
        includeMapAssets: true,
        includeIndexImages: false,
        includeImageSeries: true,
        maxZoneCampaigns: 4,
      },
      new Date('2026-09-29T12:00:00Z'),
    );

    // Mutar la fuente DESPUÉS de capturar no altera el snapshot.
    (lots[0].geojson as { coordinates: number[][][] }).coordinates[0][0] = [
      9, 9,
    ];
    pipelineInput.lots.push({ ...lots[0], id: 'lot-2' });

    expect(snapshot.snapshotVersion).toBe(ANALYSIS_INPUT_SNAPSHOT_VERSION);
    expect(snapshot.lots).toHaveLength(1);
    expect(
      (snapshot.lots[0].geojson as { coordinates: number[][][] })
        .coordinates[0][0],
    ).toEqual([0, 0]);
    expect(snapshot.request).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-06-01',
      maxCloudiness: 40,
      indices: ['NDRE'],
      zoneIndices: ['NDVI'],
      indexImageIndices: ['NDMI'],
      includeMapAssets: true,
      includeIndexImages: false,
      includeImageSeries: true,
      maxZoneCampaigns: 4,
    });
    expect(isSupportedAnalysisInputSnapshot(snapshot)).toBe(true);
  });

  it('el input del Worker se deriva SOLO del snapshot; flags ausentes vuelven a undefined (no a false)', () => {
    const snapshot = buildAnalysisInputSnapshot(
      { fieldId: 'f-1', name: 'Campo', lots },
      { startDate: '2026-01-01', endDate: '2026-06-01', maxCloudiness: 30 },
    );

    const workerInput = snapshotToWorkerInput(snapshot);

    expect(workerInput).toEqual(
      expect.objectContaining({
        fieldId: 'f-1',
        startDate: '2026-01-01',
        maxCloudiness: 30,
        includeMapAssets: undefined,
        indices: undefined,
        maxZoneCampaigns: undefined,
      }),
    );
    expect(workerInput.lots).toEqual(snapshot.lots);
  });

  it('una versión de snapshot desconocida no es ejecutable', () => {
    expect(
      isSupportedAnalysisInputSnapshot({ snapshotVersion: 99, lots: [] }),
    ).toBe(false);
    expect(isSupportedAnalysisInputSnapshot(null)).toBe(false);
  });
});

describe('ADR-001 — clasificación centralizada de fallas', () => {
  const withCause = (status: number | null, code: string | null) =>
    new ServiceUnavailableException('público', {
      cause: new WorkerCallFailure('analyze', status, code),
    });

  it.each([
    [400, null, false],
    [422, null, false],
    [429, null, true],
    [500, null, true],
    [502, null, true],
    [null, 'ECONNABORTED', true],
    [null, 'ECONNREFUSED', true],
    [404, null, false],
  ])('status=%s code=%s → retryable=%s', (status, code, retryable) => {
    expect(classifyWorkerCallError(withCause(status, code)).retryable).toBe(
      retryable,
    );
  });

  it('decide por metadata estructurada, nunca por el texto: un 400 con mensaje de "no disponible" sigue siendo no reintentable', () => {
    const error = new BadRequestException(
      'El motor de análisis no está disponible temporalmente.',
      {
        cause: new WorkerCallFailure('analyze', 400, null),
      },
    );

    expect(classifyWorkerCallError(error)).toEqual(
      expect.objectContaining({ code: 'worker_bad_request', retryable: false }),
    );
  });
});

describe('ADR-001 — staleness legacy', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const old = new Date(now.getTime() - 60 * 60 * 1000);

  it('un Procesando durable nunca es stale por edad; uno legacy sí', () => {
    expect(
      isAnalysisStale(
        { status: 'Procesando', startedAt: old, hasDurableExecution: true },
        now,
      ),
    ).toBe(false);
    expect(isAnalysisStale({ status: 'Procesando', startedAt: old }, now)).toBe(
      true,
    );
  });

  it('un Queued nunca es stale', () => {
    expect(isAnalysisStale({ status: 'Queued', createdAt: old }, now)).toBe(
      false,
    );
  });
});
