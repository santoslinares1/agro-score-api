import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type AnalysisQueueInvariantCode =
  | 'queued_without_outbox'
  | 'queued_with_abandoned_outbox'
  | 'processing_without_active_attempt'
  | 'terminal_with_active_attempt'
  | 'dispatched_outbox_without_job'
  | 'multiple_active_attempts';

export type AnalysisQueueInvariantViolation = {
  code: AnalysisQueueInvariantCode;
  analysisId: string;
  detail: string;
};

/**
 * ADR-001: chequeo de invariantes de la ejecución durable. Solo LEE — nunca repara nada (la
 * reparación de un job perdido la hace AnalysisJobReconcilerService, con el estado real de
 * pg-boss). Invocable desde `npm run queue:check-invariants` y probado en integración.
 *
 * Nota sobre 'Procesando': entre reintentos (backoff de pg-boss) un Analysis durable queda
 * 'Procesando' con su último intento en 'failed_retryable' y ninguno 'running' — el ticket no
 * permite volver a 'Queued'. Ese estado es válido y no se reporta; solo se reporta un Procesando
 * durable sin intento activo NI un último intento reintentable.
 */
@Injectable()
export class AnalysisQueueInvariantsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async check(): Promise<AnalysisQueueInvariantViolation[]> {
    const violations: AnalysisQueueInvariantViolation[] = [];
    const collect = async (
      code: AnalysisQueueInvariantCode,
      detail: string,
      sql: string,
    ): Promise<void> => {
      const rows: Array<{ analysisId: string }> =
        await this.dataSource.query(sql);
      for (const row of rows) {
        violations.push({ code, analysisId: row.analysisId, detail });
      }
    };

    await collect(
      'queued_without_outbox',
      'Analysis Queued sin fila de outbox (ni job).',
      `SELECT a."id" AS "analysisId" FROM "analysis" a
       WHERE a."status" = 'Queued'
         AND NOT EXISTS (SELECT 1 FROM "analysis_job_outbox" o WHERE o."analysisId" = a."id")`,
    );

    await collect(
      'queued_with_abandoned_outbox',
      'Analysis Queued cuyo outbox fue abandonado (debería estar en Error).',
      `SELECT a."id" AS "analysisId" FROM "analysis" a
       INNER JOIN "analysis_job_outbox" o ON o."analysisId" = a."id"
       WHERE a."status" = 'Queued' AND o."abandonedAt" IS NOT NULL`,
    );

    await collect(
      'processing_without_active_attempt',
      'Analysis Procesando durable sin intento activo ni reintento pendiente.',
      `SELECT a."id" AS "analysisId" FROM "analysis" a
       WHERE a."status" = 'Procesando'
         AND a."inputSnapshot" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "analysis_attempt" t
           WHERE t."analysisId" = a."id" AND t."outcome" = 'running')
         AND COALESCE((
           SELECT t."outcome" FROM "analysis_attempt" t
           WHERE t."analysisId" = a."id"
           ORDER BY t."startedAt" DESC, t."attemptNumber" DESC
           LIMIT 1), '') <> 'failed_retryable'`,
    );

    await collect(
      'terminal_with_active_attempt',
      'Analysis terminal (Finalizado/Error) con un intento todavía running.',
      `SELECT DISTINCT a."id" AS "analysisId" FROM "analysis" a
       INNER JOIN "analysis_attempt" t ON t."analysisId" = a."id"
       WHERE a."status" IN ('Finalizado', 'Error') AND t."outcome" = 'running'`,
    );

    await collect(
      'dispatched_outbox_without_job',
      'Outbox marcado como despachado sin referencia de job.',
      `SELECT o."analysisId" FROM "analysis_job_outbox" o
       WHERE o."dispatchedAt" IS NOT NULL AND o."jobId" IS NULL`,
    );

    await collect(
      'multiple_active_attempts',
      'Más de un intento running para el mismo Analysis.',
      `SELECT t."analysisId" FROM "analysis_attempt" t
       WHERE t."outcome" = 'running'
       GROUP BY t."analysisId" HAVING COUNT(*) > 1`,
    );

    return violations;
  }
}
