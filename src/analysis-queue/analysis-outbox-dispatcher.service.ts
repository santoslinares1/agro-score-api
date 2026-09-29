import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { AnalysisExecutionStore } from './analysis-execution.store';
import {
  ANALYSIS_EXECUTE_JOB,
  ANALYSIS_JOB_CONTRACT_VERSION,
  parseAnalysisExecutePayload,
} from './analysis-job.contract';
import { ANALYSIS_JOB_QUEUE } from './analysis-job-queue';
import type { AnalysisJobQueue } from './analysis-job-queue';
import { ANALYSIS_QUEUE_CONFIG } from './analysis-queue.config';
import type { AnalysisQueueConfig } from './analysis-queue.config';
import { classificationFor } from './analysis-failure-classifier';

type OutboxRow = {
  id: string;
  analysisId: string;
  jobType: string;
  payloadVersion: number;
  payload: unknown;
};

export type DispatchTickResult = {
  claimed: number;
  published: number;
  alreadyPublished: number;
  failed: number;
  abandoned: number;
};

const DISPATCH_ERROR_MAX_LENGTH = 500;

/**
 * ADR-001: publica filas pendientes de analysis_job_outbox en pg-boss.
 *
 * Exclusión entre dispatchers: cada tick reclama filas con `FOR UPDATE SKIP LOCKED` dentro de una
 * transacción que se mantiene abierta mientras publica — dos dispatchers (o dos ticks) nunca
 * trabajan la misma fila a la vez. `dispatchedAt` se marca SOLO después de que pg-boss confirmó.
 *
 * Crash "publicado pero no marcado": si el proceso muere entre la publicación y el COMMIT, la
 * transacción se revierte y la fila vuelve a estar pendiente. La republicación es idempotente
 * porque el id del job es determinista (= id de la fila de outbox): pg-boss no crea un segundo
 * job, y el consumidor además es idempotente (un Analysis terminal nunca vuelve a ejecutarse).
 */
@Injectable()
export class AnalysisOutboxDispatcherService {
  private readonly logger = new Logger(AnalysisOutboxDispatcherService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ANALYSIS_JOB_QUEUE) private readonly queue: AnalysisJobQueue,
    @Inject(ANALYSIS_QUEUE_CONFIG) private readonly config: AnalysisQueueConfig,
    private readonly store: AnalysisExecutionStore,
  ) {}

  async dispatchPending(): Promise<DispatchTickResult> {
    const result: DispatchTickResult = {
      claimed: 0,
      published: 0,
      alreadyPublished: 0,
      failed: 0,
      abandoned: 0,
    };

    await this.dataSource.transaction(async (manager) => {
      const rows: OutboxRow[] = await manager.query(
        `SELECT "id", "analysisId", "jobType", "payloadVersion", "payload"
         FROM "analysis_job_outbox"
         WHERE "dispatchedAt" IS NULL AND "abandonedAt" IS NULL
         ORDER BY "createdAt" ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.config.dispatchBatchSize],
      );

      result.claimed = rows.length;

      for (const row of rows) {
        await manager.query(
          `UPDATE "analysis_job_outbox"
           SET "lockedAt" = now(), "dispatchAttempts" = "dispatchAttempts" + 1
           WHERE "id" = $1`,
          [row.id],
        );

        const parsed = parseAnalysisExecutePayload(row.payload);

        if (
          row.jobType !== ANALYSIS_EXECUTE_JOB ||
          row.payloadVersion !== ANALYSIS_JOB_CONTRACT_VERSION ||
          !parsed.ok ||
          parsed.payload.analysisId !== row.analysisId
        ) {
          await this.abandon(manager, row);
          result.abandoned += 1;
          continue;
        }

        try {
          const publish = await this.queue.publish(row.id, parsed.payload);

          await manager.query(
            `UPDATE "analysis_job_outbox"
             SET "dispatchedAt" = now(), "jobId" = $2, "lastDispatchError" = NULL
             WHERE "id" = $1`,
            [row.id, row.id],
          );

          if (publish === 'created') {
            result.published += 1;
          } else {
            result.alreadyPublished += 1;
          }
        } catch (error) {
          result.failed += 1;
          const message = (
            error instanceof Error ? error.message : String(error)
          ).slice(0, DISPATCH_ERROR_MAX_LENGTH);

          this.logger.error(
            `[analysis-outbox] No se pudo publicar outboxId=${row.id} (analysisId=${row.analysisId}): ${message}`,
          );

          await manager.query(
            `UPDATE "analysis_job_outbox" SET "lastDispatchError" = $2 WHERE "id" = $1`,
            [row.id, message],
          );
        }
      }
    });

    if (result.claimed > 0) {
      this.logger.log(
        `[analysis-outbox] Tick de dispatch: ${JSON.stringify(result)}`,
      );
    }

    return result;
  }

  /**
   * Una fila con versión de payload/tipo de job desconocido nunca se publica (ningún consumidor la
   * entiende). Se marca abandonada y el Analysis (si sigue Queued) pasa a Error en la MISMA
   * transacción — nunca queda un Queued sin explicación durable.
   */
  private async abandon(manager: EntityManager, row: OutboxRow): Promise<void> {
    const classification = classificationFor(
      'unsupported_contract_version',
      false,
    );

    this.logger.error(
      `[analysis-outbox] outboxId=${row.id} (analysisId=${row.analysisId}) tiene jobType=${row.jobType} ` +
        `payloadVersion=${row.payloadVersion} no soportados; se abandona.`,
    );

    await manager.query(
      `UPDATE "analysis_job_outbox" SET "abandonedAt" = now(), "lastDispatchError" = $2 WHERE "id" = $1`,
      [row.id, classification.code],
    );

    await this.store.failActiveAnalysis(
      manager,
      row.analysisId,
      classification.publicMessage,
    );
  }
}
