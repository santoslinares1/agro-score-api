import { Logger } from '@nestjs/common';

import type { AnalysisQueueConfig } from './analysis-queue.config';
import {
  ANALYSIS_EXECUTE_DEAD_LETTER_QUEUE,
  ANALYSIS_EXECUTE_JOB,
  AnalysisExecuteJobPayload,
} from './analysis-job.contract';

/**
 * ADR-001: única frontera con pg-boss. El resto del código (dispatcher, consumidor, reconciliador)
 * depende de esta interfaz, así que los tests unitarios la mockean y nunca cargan pg-boss (paquete
 * ESM-only). La implementación real se carga con `import()` dinámico.
 */
export type QueueJobState =
  | 'created'
  | 'retry'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type QueueJob = {
  id: string;
  data: unknown;
  /** Reintentos previos (0 en el primer intento). attemptNumber = retryCount + 1. */
  retryCount: number;
  /** Reintentos permitidos. Último intento ⇔ retryCount >= retryLimit. */
  retryLimit: number;
  signal?: AbortSignal;
};

/**
 * - completed: el job terminó (éxito, o nada que hacer: duplicado / Analysis ya terminal).
 * - failed: falla reintentable — pg-boss reintenta con backoff o, si no quedan intentos, lo deja
 *   'failed' y lo copia al dead-letter queue.
 * - deadletter: falla no reintentable — pg-boss lo falla terminalmente y lo copia al DLQ sin
 *   consumir los reintentos restantes.
 */
export type QueueJobDisposition = 'completed' | 'failed' | 'deadletter';

export type PublishResult = 'created' | 'already_exists';

export interface AnalysisJobQueue {
  start(): Promise<void>;
  /** Publicación idempotente: el id del job es determinista (el id de la fila de outbox). */
  publish(
    jobId: string,
    payload: AnalysisExecuteJobPayload,
  ): Promise<PublishResult>;
  getJobState(jobId: string): Promise<QueueJobState | null>;
  work(handler: (job: QueueJob) => Promise<QueueJobDisposition>): Promise<void>;
  /** Deja de tomar jobs, espera el activo hasta `timeoutMs` y libera su lease si no terminó. */
  stop(timeoutMs: number): Promise<void>;
}

export const ANALYSIS_JOB_QUEUE = Symbol('ANALYSIS_JOB_QUEUE');

export type PgBossConnectionOptions = {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: unknown;
};

type PgBossJob = {
  id: string;
  data: unknown;
  retryCount: number;
  retryLimit: number;
  signal?: AbortSignal;
};

// Tipado mínimo de la API usada (pg-boss 12.x) — evita importar sus tipos ESM en código CJS.
type PgBossInstance = {
  start(): Promise<unknown>;
  stop(options?: {
    graceful?: boolean;
    timeout?: number;
    close?: boolean;
  }): Promise<void>;
  on(event: 'error' | 'warning', listener: (payload: unknown) => void): unknown;
  getQueue(name: string): Promise<unknown>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  updateQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  send(
    name: string,
    data: object,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  getJobById(
    name: string,
    id: string,
  ): Promise<{ state: QueueJobState } | null>;
  work(
    name: string,
    options: Record<string, unknown>,
    handler: (
      jobs: PgBossJob[],
    ) => Promise<Array<{ id: string; status: string; output?: object }>>,
  ): Promise<string>;
};

/** Opciones de cola derivadas de la configuración (compartidas por create y update). */
export function buildAnalysisQueueOptions(
  config: AnalysisQueueConfig,
): Record<string, unknown> {
  return {
    retryLimit: Math.max(0, config.maxAttempts - 1),
    retryDelay: config.retryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: config.retryDelayMaxSeconds,
    expireInSeconds: config.expireInSeconds,
    heartbeatSeconds: config.heartbeatSeconds,
    deleteAfterSeconds: config.failedJobRetentionSeconds,
    retentionSeconds: config.failedJobRetentionSeconds,
    deadLetter: ANALYSIS_EXECUTE_DEAD_LETTER_QUEUE,
  };
}

export class PgBossAnalysisJobQueue implements AnalysisJobQueue {
  private readonly logger = new Logger(PgBossAnalysisJobQueue.name);
  private boss: PgBossInstance | null = null;

  constructor(
    private readonly config: AnalysisQueueConfig,
    private readonly connection: PgBossConnectionOptions,
  ) {}

  async start(): Promise<void> {
    // pg-boss 12 es ESM-only: import() dinámico (en CJS compilado se preserva como import nativo).
    const { PgBoss } = (await import('pg-boss')) as unknown as {
      PgBoss: new (options: Record<string, unknown>) => PgBossInstance;
    };

    const boss = new PgBoss({
      ...this.connection,
      schema: this.config.pgBossSchema,
      application_name: 'agroscore-analysis-job-runner',
      max: 4,
      // Sin crons de pg-boss: el scheduler semanal sigue viviendo en la API.
      schedule: false,
    });

    boss.on('error', (error) =>
      this.logger.error(
        `[pg-boss] ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      ),
    );

    await boss.start();
    this.boss = boss;

    await this.ensureQueue(ANALYSIS_EXECUTE_DEAD_LETTER_QUEUE, {
      // El DLQ no tiene consumidor: sus jobs quedan inspeccionables hasta que expire su retención.
      retentionSeconds: this.config.failedJobRetentionSeconds,
      deleteAfterSeconds: this.config.failedJobRetentionSeconds,
      retryLimit: 0,
    });
    await this.ensureQueue(
      ANALYSIS_EXECUTE_JOB,
      buildAnalysisQueueOptions(this.config),
    );
  }

  private async ensureQueue(
    name: string,
    options: Record<string, unknown>,
  ): Promise<void> {
    const boss = this.requireBoss();

    if (await boss.getQueue(name)) {
      await boss.updateQueue(name, options);
      return;
    }

    await boss.createQueue(name, { ...options, policy: 'standard' });
  }

  async publish(
    jobId: string,
    payload: AnalysisExecuteJobPayload,
  ): Promise<PublishResult> {
    const boss = this.requireBoss();
    const createdId = await boss.send(ANALYSIS_EXECUTE_JOB, payload, {
      id: jobId,
      singletonKey: payload.idempotencyKey,
    });

    if (createdId) {
      return 'created';
    }

    // send() devuelve null cuando el INSERT fue un no-op (ya existe un job con ese id): caso
    // "publicado pero no marcado" de un dispatcher anterior. Se confirma leyendo el job.
    if (await boss.getJobById(ANALYSIS_EXECUTE_JOB, jobId)) {
      return 'already_exists';
    }

    throw new Error(`pg-boss no confirmó la publicación del job ${jobId}.`);
  }

  async getJobState(jobId: string): Promise<QueueJobState | null> {
    const job = await this.requireBoss().getJobById(
      ANALYSIS_EXECUTE_JOB,
      jobId,
    );

    return job?.state ?? null;
  }

  async work(
    handler: (job: QueueJob) => Promise<QueueJobDisposition>,
  ): Promise<void> {
    await this.requireBoss().work(
      ANALYSIS_EXECUTE_JOB,
      {
        localConcurrency: this.config.concurrency,
        batchSize: 1,
        includeMetadata: true,
        perJobResults: true,
        pollingIntervalSeconds: this.config.pollingIntervalSeconds,
      },
      async (jobs) => {
        const results: Array<{ id: string; status: string; output?: object }> =
          [];

        for (const job of jobs) {
          const status = await handler({
            id: job.id,
            data: job.data,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            signal: job.signal,
          });
          results.push({ id: job.id, status });
        }

        return results;
      },
    );
  }

  async stop(timeoutMs: number): Promise<void> {
    if (!this.boss) {
      return;
    }

    // graceful: deja de hacer fetch, espera el job activo hasta timeoutMs; si no terminó, pg-boss
    // lo falla (lease liberado → reintento/DLQ según intentos restantes) antes de cerrar el pool.
    await this.boss.stop({ graceful: true, timeout: timeoutMs, close: true });
    this.boss = null;
  }

  private requireBoss(): PgBossInstance {
    if (!this.boss) {
      throw new Error('La cola de análisis no fue iniciada.');
    }

    return this.boss;
  }
}
