import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AnalysisExecutionStore } from './analysis-execution.store';
import { classificationFor } from './analysis-failure-classifier';
import { ANALYSIS_JOB_QUEUE } from './analysis-job-queue';
import type { AnalysisJobQueue } from './analysis-job-queue';

export type DurableReconcileResult = { checked: number; closed: number };

/**
 * ADR-001: reemplaza, para los análisis administrados por la cola, lo que el reconciliador legacy
 * por edad hace con los fire-and-forget. Nunca decide por edad: consulta el estado REAL del job en
 * pg-boss. Solo cierra (Analysis→Error, intentos 'running'→lease_lost) cuando pg-boss ya no va a
 * volver a ejecutar el job:
 * - 'failed': se agotaron los intentos (p. ej. el runner murió durante el último intento, así que
 *   ningún handler llegó a marcar el Error) — el job queda inspeccionable en el dead-letter queue.
 * - 'cancelled': cancelado explícitamente por un operador.
 * - 'completed' con el Analysis todavía activo: no debería ocurrir; se cierra para no dejarlo
 *   colgado (el guard del UPDATE nunca pisa un terminal).
 * - job inexistente pese a un outbox despachado: retención vencida o borrado manual.
 * 'created' / 'retry' / 'active' no se tocan: la cola sigue siendo dueña de ese trabajo.
 */
@Injectable()
export class AnalysisJobReconcilerService {
  private readonly logger = new Logger(AnalysisJobReconcilerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ANALYSIS_JOB_QUEUE) private readonly queue: AnalysisJobQueue,
    private readonly store: AnalysisExecutionStore,
  ) {}

  async reconcile(now: Date = new Date()): Promise<DurableReconcileResult> {
    const rows: Array<{ analysisId: string; jobId: string }> =
      await this.dataSource.query(
        `SELECT a."id" AS "analysisId", o."jobId"
       FROM "analysis" a
       INNER JOIN "analysis_job_outbox" o ON o."analysisId" = a."id"
       WHERE a."status" IN ('Queued', 'Procesando')
         AND o."dispatchedAt" IS NOT NULL
         AND o."jobId" IS NOT NULL`,
      );

    let closed = 0;

    for (const row of rows) {
      try {
        const state = await this.queue.getJobState(row.jobId);

        if (state === 'created' || state === 'retry' || state === 'active') {
          continue;
        }

        const code = state === 'failed' ? 'attempts_exhausted' : 'lease_lost';
        const didClose = await this.store.closeLostExecution({
          analysisId: row.analysisId,
          classification: classificationFor(code, false),
          now,
        });

        if (didClose) {
          closed += 1;
          this.logger.warn(
            `[analysis-reconcile-durable] analysisId=${row.analysisId} cerrado como Error: job ${row.jobId} ` +
              `en estado ${state ?? 'inexistente'}.`,
          );
        }
      } catch (error) {
        this.logger.error(
          `[analysis-reconcile-durable] Fallo reconciliando analysisId=${row.analysisId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { checked: rows.length, closed };
  }
}
