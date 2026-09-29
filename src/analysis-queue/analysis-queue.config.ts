import { ConfigService } from '@nestjs/config';

/**
 * ADR-001: configuración de la cola durable de análisis. Todo valor operativo (flags de rollout,
 * concurrencia, reintentos, expiración, heartbeat, intervalos) vive acá — nunca como números
 * dispersos en los servicios. Se resuelve una única vez al construir el provider
 * (ANALYSIS_QUEUE_CONFIG), desde variables de entorno con defaults conservadores.
 */
export type AnalysisQueueConfig = {
  /**
   * Productor manual: si es true, POST /analysis/field/:fieldId crea `Analysis=Queued` + outbox en
   * una sola transacción y NUNCA llama al Worker desde el proceso HTTP. false (default durante el
   * primer deploy) mantiene el camino legacy fire-and-forget.
   */
  enabled: boolean;
  /**
   * Productor semanal: solo tiene efecto si `enabled` también es true (paso 8 del rollout —
   * se habilita después de validar las solicitudes manuales).
   */
  weeklyEnabled: boolean;
  /** Si es false, el entrypoint del job runner arranca pero queda inactivo (no toca pg-boss). */
  runnerEnabled: boolean;
  /** Schema de Postgres propio de pg-boss (aislado del schema de la aplicación). */
  pgBossSchema: string;
  /** Concurrencia global del consumidor (por proceso runner). Default 1. */
  concurrency: number;
  /** Intentos TOTALES (primer intento + reintentos). pg-boss recibe `retryLimit = maxAttempts - 1`. */
  maxAttempts: number;
  /** Delay base del backoff exponencial de pg-boss, en segundos. */
  retryDelaySeconds: number;
  /** Tope del backoff exponencial de pg-boss, en segundos. */
  retryDelayMaxSeconds: number;
  /** Tiempo máximo en estado `active` antes de que pg-boss expire el lease del job. */
  expireInSeconds: number;
  /** Heartbeat esperado por pg-boss (>= 10). Si no llega, pg-boss falla/reintenta el job. */
  heartbeatSeconds: number;
  /** Polling de pg-boss para tomar jobs nuevos (segundos). */
  pollingIntervalSeconds: number;
  /** Cada cuánto el consumidor refresca `analysis_attempt.heartbeatAt`. */
  attemptHeartbeatIntervalMs: number;
  /** Cada cuánto el dispatcher intenta publicar filas pendientes del outbox. */
  dispatchIntervalMs: number;
  /** Máximo de filas del outbox reclamadas por tick del dispatcher. */
  dispatchBatchSize: number;
  /** Cada cuánto el runner reconcilia Analysis durables contra el estado real del job. */
  reconcileIntervalMs: number;
  /** Retención de jobs terminados/fallidos (y del dead-letter) en pg-boss, en segundos. */
  failedJobRetentionSeconds: number;
  /** Tiempo máximo que el shutdown espera al job activo antes de liberar el lease. */
  shutdownTimeoutMs: number;
};

export const ANALYSIS_QUEUE_CONFIG = Symbol('ANALYSIS_QUEUE_CONFIG');

type EnvReader = (key: string) => string | undefined;

function readBoolean(read: EnvReader, key: string, fallback: boolean): boolean {
  const raw = read(key);

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  return raw.trim().toLowerCase() === 'true';
}

function readPositiveInt(
  read: EnvReader,
  key: string,
  fallback: number,
  min = 1,
): number {
  const raw = read(key);

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(
      `Configuración inválida de la cola de análisis: ${key}=${raw} (se espera un entero >= ${min}).`,
    );
  }

  return parsed;
}

export function resolveAnalysisQueueConfig(
  read: EnvReader,
): AnalysisQueueConfig {
  const heartbeatSeconds = readPositiveInt(
    read,
    'ANALYSIS_JOB_HEARTBEAT_SECONDS',
    30,
    10,
  );
  const pgBossSchema = read('ANALYSIS_QUEUE_PGBOSS_SCHEMA')?.trim() || 'pgboss';

  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(pgBossSchema)) {
    throw new Error(
      `Configuración inválida de la cola de análisis: ANALYSIS_QUEUE_PGBOSS_SCHEMA=${pgBossSchema}.`,
    );
  }

  return {
    enabled: readBoolean(read, 'ANALYSIS_QUEUE_ENABLED', false),
    weeklyEnabled: readBoolean(read, 'ANALYSIS_QUEUE_WEEKLY_ENABLED', false),
    runnerEnabled: readBoolean(read, 'ANALYSIS_JOB_RUNNER_ENABLED', false),
    pgBossSchema,
    concurrency: readPositiveInt(read, 'ANALYSIS_JOB_CONCURRENCY', 1),
    maxAttempts: readPositiveInt(read, 'ANALYSIS_JOB_MAX_ATTEMPTS', 3),
    retryDelaySeconds: readPositiveInt(
      read,
      'ANALYSIS_JOB_RETRY_DELAY_SECONDS',
      60,
    ),
    retryDelayMaxSeconds: readPositiveInt(
      read,
      'ANALYSIS_JOB_RETRY_DELAY_MAX_SECONDS',
      1200,
    ),
    expireInSeconds: readPositiveInt(read, 'ANALYSIS_JOB_EXPIRE_SECONDS', 900),
    heartbeatSeconds,
    pollingIntervalSeconds: readPositiveInt(
      read,
      'ANALYSIS_JOB_POLLING_INTERVAL_SECONDS',
      2,
    ),
    attemptHeartbeatIntervalMs:
      readPositiveInt(
        read,
        'ANALYSIS_JOB_ATTEMPT_HEARTBEAT_SECONDS',
        Math.floor(heartbeatSeconds / 2),
      ) * 1000,
    dispatchIntervalMs: readPositiveInt(
      read,
      'ANALYSIS_OUTBOX_DISPATCH_INTERVAL_MS',
      5000,
      100,
    ),
    dispatchBatchSize: readPositiveInt(
      read,
      'ANALYSIS_OUTBOX_DISPATCH_BATCH_SIZE',
      20,
    ),
    reconcileIntervalMs: readPositiveInt(
      read,
      'ANALYSIS_JOB_RECONCILE_INTERVAL_MS',
      60_000,
      1000,
    ),
    failedJobRetentionSeconds: readPositiveInt(
      read,
      'ANALYSIS_JOB_FAILED_RETENTION_SECONDS',
      30 * 24 * 60 * 60,
    ),
    shutdownTimeoutMs: readPositiveInt(
      read,
      'ANALYSIS_JOB_SHUTDOWN_TIMEOUT_MS',
      60_000,
      1000,
    ),
  };
}

export const analysisQueueConfigProvider = {
  provide: ANALYSIS_QUEUE_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService): AnalysisQueueConfig =>
    resolveAnalysisQueueConfig((key) => config.get<string>(key)),
};
