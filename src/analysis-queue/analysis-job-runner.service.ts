import { Inject, Injectable, Logger } from '@nestjs/common';

import { AnalysisJobConsumerService } from './analysis-job-consumer.service';
import { ANALYSIS_JOB_QUEUE } from './analysis-job-queue';
import type { AnalysisJobQueue } from './analysis-job-queue';
import { AnalysisJobReconcilerService } from './analysis-job-reconciler.service';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';
import { ANALYSIS_QUEUE_CONFIG } from './analysis-queue.config';
import type { AnalysisQueueConfig } from './analysis-queue.config';

type Loop = { timer: NodeJS.Timeout | null; inFlight: Promise<unknown> | null };

/**
 * ADR-001: ciclo de vida del proceso job runner (entrypoint src/job-runner.main.ts). Inicia
 * pg-boss, registra el consumidor de analysis.execute.v1 y corre dos loops sin solapamiento:
 * dispatch del outbox y reconciliación durable. `stop()` es el camino de SIGTERM: primero corta
 * los loops (no se publica ni reconcilia nada nuevo), después pg-boss deja de tomar jobs, espera
 * el activo hasta shutdownTimeoutMs y, si no terminó, libera su lease.
 */
@Injectable()
export class AnalysisJobRunnerService {
  private readonly logger = new Logger(AnalysisJobRunnerService.name);
  private running = false;
  private stopping: Promise<void> | null = null;
  private readonly loops: Loop[] = [];

  constructor(
    @Inject(ANALYSIS_JOB_QUEUE) private readonly queue: AnalysisJobQueue,
    @Inject(ANALYSIS_QUEUE_CONFIG) private readonly config: AnalysisQueueConfig,
    private readonly dispatcher: AnalysisOutboxDispatcherService,
    private readonly consumer: AnalysisJobConsumerService,
    private readonly reconciler: AnalysisJobReconcilerService,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Devuelve false si ANALYSIS_JOB_RUNNER_ENABLED no está en true (el proceso queda inactivo). */
  async start(): Promise<boolean> {
    if (!this.config.runnerEnabled) {
      this.logger.warn(
        'ANALYSIS_JOB_RUNNER_ENABLED != true: el job runner queda inactivo (no consume ni publica).',
      );
      return false;
    }

    await this.queue.start();
    await this.queue.work((job) => this.consumer.handle(job));
    this.running = true;

    this.startLoop('outbox-dispatch', this.config.dispatchIntervalMs, () =>
      this.dispatcher.dispatchPending(),
    );
    this.startLoop('durable-reconcile', this.config.reconcileIntervalMs, () =>
      this.reconciler.reconcile(),
    );

    this.logger.log(
      `Job runner iniciado (concurrency=${this.config.concurrency}, maxAttempts=${this.config.maxAttempts}, ` +
        `expireInSeconds=${this.config.expireInSeconds}, heartbeatSeconds=${this.config.heartbeatSeconds}).`,
    );
    return true;
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.doStop();
    }

    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.running = false;

    for (const loop of this.loops) {
      if (loop.timer) {
        clearTimeout(loop.timer);
        loop.timer = null;
      }
    }

    await Promise.allSettled(
      this.loops
        .map((loop) => loop.inFlight)
        .filter((tick): tick is Promise<unknown> => tick !== null),
    );
    await this.queue.stop(this.config.shutdownTimeoutMs);
    this.logger.log('Job runner detenido.');
  }

  private startLoop(
    name: string,
    intervalMs: number,
    tick: () => Promise<unknown>,
  ): void {
    const loop: Loop = { timer: null, inFlight: null };
    this.loops.push(loop);

    const schedule = (delay: number) => {
      if (!this.running) {
        return;
      }

      loop.timer = setTimeout(() => {
        loop.timer = null;
        loop.inFlight = tick()
          .catch((error) =>
            this.logger.error(
              `[${name}] tick falló: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          .finally(() => {
            loop.inFlight = null;
            schedule(intervalMs);
          });
      }, delay);
    };

    schedule(0);
  }
}
