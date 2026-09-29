import { Inject, Injectable, Logger } from '@nestjs/common';

import { AnalysisService } from '../analysis/analysis.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { WorkerAnalysisResult } from '../python-worker/types';
import { AnalysisExecutionStore } from './analysis-execution.store';
import {
  AnalysisFailureClassification,
  classificationFor,
  classifyWorkerCallError,
} from './analysis-failure-classifier';
import { snapshotToWorkerInput } from './analysis-input-snapshot';
import { parseAnalysisExecutePayload } from './analysis-job.contract';
import type { QueueJob, QueueJobDisposition } from './analysis-job-queue';
import { ANALYSIS_QUEUE_CONFIG } from './analysis-queue.config';
import type { AnalysisQueueConfig } from './analysis-queue.config';

/**
 * ADR-001: consumidor de analysis.execute.v1 (solo corre en el proceso job runner, nunca en la
 * API HTTP). Entrega at-least-once de pg-boss + efectos idempotentes:
 *
 * - El Worker se llama únicamente después de reclamar un intento (Queued→Procesando + intento
 *   'running' confirmados). Un Analysis terminal, inexistente o con otro intento vivo nunca llega
 *   al Worker.
 * - El input del Worker sale SIEMPRE de Analysis.inputSnapshot (nunca del Field vigente).
 * - El resultado se persiste una sola vez (guard Procesando→Finalizado); un retry tardío termina
 *   'superseded' sin sobrescribir nada.
 * - Reintentables → 'failed' (pg-boss reintenta con backoff; al agotar, 'failed' + DLQ). No
 *   reintentables → Analysis=Error + 'deadletter' (DLQ inmediato, sin consumir reintentos).
 *
 * Lo que at-least-once NO evita (documentado, no simulado): si el runner muere después de que el
 * Worker respondió y antes de persistir, el reintento vuelve a llamar al Worker.
 */
@Injectable()
export class AnalysisJobConsumerService {
  private readonly logger = new Logger(AnalysisJobConsumerService.name);

  constructor(
    private readonly store: AnalysisExecutionStore,
    private readonly pythonWorkerService: PythonWorkerService,
    private readonly analysisService: AnalysisService,
    @Inject(ANALYSIS_QUEUE_CONFIG) private readonly config: AnalysisQueueConfig,
  ) {}

  async handle(job: QueueJob): Promise<QueueJobDisposition> {
    const attemptNumber = job.retryCount + 1;
    const parsed = parseAnalysisExecutePayload(job.data);

    if (!parsed.ok) {
      this.logger.error(
        `[analysis-job] jobId=${job.id} con payload no soportado (${parsed.reason}); se envía a dead-letter.`,
      );

      if (parsed.analysisId) {
        await this.store.failBeforeExecution({
          analysisId: parsed.analysisId,
          jobId: job.id,
          attemptNumber,
          classification: classificationFor(parsed.reason, false),
          now: new Date(),
        });
      }

      return 'deadletter';
    }

    const { analysisId } = parsed.payload;
    const claim = await this.store.claimAttempt({
      analysisId,
      jobId: job.id,
      attemptNumber,
      now: new Date(),
      heartbeatStaleMs: this.config.heartbeatSeconds * 2 * 1000,
    });

    switch (claim.kind) {
      case 'not_found':
        this.logger.error(
          `[analysis-job] analysisId=${analysisId} no existe (jobId=${job.id}).`,
        );
        return 'deadletter';
      case 'terminal':
        this.logger.warn(
          `[analysis-job] analysisId=${analysisId} ya está ${claim.status}; jobId=${job.id} termina sin llamar al Worker.`,
        );
        return 'completed';
      case 'busy':
        this.logger.warn(
          `[analysis-job] analysisId=${analysisId} ya tiene un intento activo (attemptId=${claim.runningAttemptId}); ` +
            `jobId=${job.id} termina sin llamar al Worker.`,
        );
        return 'completed';
      case 'duplicate_attempt':
        this.logger.warn(
          `[analysis-job] intento duplicado jobId=${job.id} attempt=${attemptNumber}; se devuelve a la cola.`,
        );
        return 'failed';
      case 'invalid_snapshot':
      case 'field_unavailable':
        await this.store.failBeforeExecution({
          analysisId,
          jobId: job.id,
          attemptNumber,
          classification: classificationFor(claim.kind, false),
          now: new Date(),
        });
        return 'deadletter';
      case 'claimed':
        return this.execute(job, analysisId, claim);
    }
  }

  private async execute(
    job: QueueJob,
    analysisId: string,
    claim: Extract<
      Awaited<ReturnType<AnalysisExecutionStore['claimAttempt']>>,
      { kind: 'claimed' }
    >,
  ): Promise<QueueJobDisposition> {
    const heartbeat = setInterval(() => {
      this.store
        .touchAttempt(claim.attemptId, new Date())
        .catch((error) =>
          this.logger.warn(
            `[analysis-job] heartbeat de attemptId=${claim.attemptId} falló: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }, this.config.attemptHeartbeatIntervalMs);
    heartbeat.unref?.();

    this.logger.log(
      `[analysis-job] Ejecutando analysisId=${analysisId} jobId=${job.id} intento ${claim.attemptNumber}/${
        job.retryLimit + 1
      } (${claim.snapshot.lots.length} lotes del snapshot).`,
    );

    try {
      let result: WorkerAnalysisResult;

      try {
        result = await this.pythonWorkerService.runFieldAnalysis(
          snapshotToWorkerInput(claim.snapshot),
        );
      } catch (error) {
        return await this.handleExecutionFailure(
          job,
          analysisId,
          claim,
          classifyWorkerCallError(error),
        );
      }

      const outcome = await this.store.finalizeSuccess({
        analysisId,
        attemptId: claim.attemptId,
        fields: this.analysisService.buildFinalizedResultFields(
          result,
          claim.fieldId,
          claim.snapshot.lots,
        ),
        now: new Date(),
      });

      if (outcome === 'superseded') {
        this.logger.warn(
          `[analysis-job] analysisId=${analysisId} ya era terminal al terminar el intento; el resultado no se sobrescribe.`,
        );
        return 'completed';
      }

      this.logger.log(
        `[analysis-job] analysisId=${analysisId} Finalizado (jobId=${job.id}).`,
      );

      // Best-effort y POSTERIOR a Finalizado: nunca convierte en Error un análisis terminado.
      try {
        const analysis = await this.analysisService.findOne(analysisId);
        await this.analysisService.generateTechnicalVerdictBestEffort(analysis);
      } catch (error) {
        this.logger.error(
          `[analysis-job] No se pudo generar el veredicto técnico (analysisId=${analysisId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return 'completed';
    } catch (error) {
      // Falla de infraestructura propia (DB) al persistir: reintentable dentro del máximo.
      this.logger.error(
        `[analysis-job] Error interno procesando analysisId=${analysisId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.handleExecutionFailure(
        job,
        analysisId,
        claim,
        classificationFor('internal_error', true),
      ).catch(() => 'failed' as const);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async handleExecutionFailure(
    job: QueueJob,
    analysisId: string,
    claim: { attemptId: string; attemptNumber: number },
    classification: AnalysisFailureClassification,
  ): Promise<QueueJobDisposition> {
    const lastAttempt = job.retryCount >= job.retryLimit;
    const terminal = !classification.retryable || lastAttempt;
    const effective =
      classification.retryable && lastAttempt
        ? {
            ...classification,
            publicMessage: classificationFor('attempts_exhausted', false)
              .publicMessage,
          }
        : classification;

    this.logger.warn(
      `[analysis-job] analysisId=${analysisId} intento ${claim.attemptNumber} falló ` +
        `(code=${classification.code}, retryable=${classification.retryable}, terminal=${terminal}).`,
    );

    await this.store.recordAttemptFailure({
      analysisId,
      attemptId: claim.attemptId,
      classification: effective,
      terminal,
      now: new Date(),
    });

    if (!classification.retryable) {
      return 'deadletter';
    }

    // Reintentable: pg-boss reintenta con backoff; si era el último intento lo deja 'failed' y lo
    // copia al dead-letter queue (el Analysis ya quedó Error arriba).
    return 'failed';
  }
}
