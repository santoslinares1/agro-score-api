import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { Analysis, AnalysisStatus } from '../analysis/entities/analysis.entity';
import type { AnalysisFailureClassification } from './analysis-failure-classifier';
import {
  AnalysisInputSnapshot,
  isSupportedAnalysisInputSnapshot,
} from './analysis-input-snapshot';
import type { AnalysisAttemptOutcome } from './entities/analysis-attempt.entity';

const ERROR_MESSAGE_MAX_LENGTH = 500;
const ERROR_CATEGORY = 'Error al procesar análisis de campo';
const ERROR_RESULT_MESSAGE = 'Error al ejecutar el pipeline de campo.';

export type ClaimResult =
  | {
      kind: 'claimed';
      attemptId: string;
      attemptNumber: number;
      fieldId: string;
      analysisStartedAt: Date;
      snapshot: AnalysisInputSnapshot;
    }
  | { kind: 'not_found' }
  | { kind: 'terminal'; status: AnalysisStatus }
  | { kind: 'busy'; runningAttemptId: string }
  | { kind: 'duplicate_attempt' }
  | { kind: 'invalid_snapshot' }
  | { kind: 'field_unavailable' };

type AnalysisLockRow = {
  id: string;
  status: AnalysisStatus;
  startedAt: Date | null;
  fieldId: string | null;
  inputSnapshot: unknown;
};

function truncate(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
    : message;
}

function durationSince(startedAt: Date | null, now: Date): number | null {
  return startedAt ? now.getTime() - new Date(startedAt).getTime() : null;
}

/**
 * ADR-001: todas las transiciones persistidas del ciclo de ejecución durable. Cada transición de
 * Analysis está GUARDADA por su estado de origen en el mismo UPDATE (Queued→Procesando,
 * Procesando→Finalizado, Queued|Procesando→Error): un retry tardío o un duplicado nunca puede
 * sobrescribir un estado terminal. Los timestamps salen del proceso Node (mismo criterio que el
 * resto de AnalysisService, que persiste `new Date()` vía TypeORM).
 */
@Injectable()
export class AnalysisExecutionStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Reclama la ejecución de `analysisId` para el intento (jobId, attemptNumber) en UNA transacción:
   * bloquea la fila del Analysis (serializa consumidores concurrentes del mismo análisis), cierra
   * como lease_lost cualquier intento 'running' abandonado, valida snapshot y disponibilidad del
   * campo, pasa Queued→Procesando y crea el intento 'running'. El índice parcial
   * UQ_analysis_attempt_running_per_analysis es la garantía final de un solo intento activo.
   */
  async claimAttempt(input: {
    analysisId: string;
    jobId: string;
    attemptNumber: number;
    now: Date;
    heartbeatStaleMs: number;
  }): Promise<ClaimResult> {
    const { analysisId, jobId, attemptNumber, now } = input;

    return this.dataSource.transaction(async (manager) => {
      const rows: AnalysisLockRow[] = await manager.query(
        `SELECT "id", "status", "startedAt", "fieldId", "inputSnapshot"
         FROM "analysis" WHERE "id" = $1 FOR UPDATE`,
        [analysisId],
      );
      const analysis = rows[0];

      if (!analysis) {
        return { kind: 'not_found' } as const;
      }

      if (analysis.status === 'Finalizado' || analysis.status === 'Error') {
        return { kind: 'terminal', status: analysis.status } as const;
      }

      const running: Array<{
        id: string;
        jobId: string;
        heartbeatAt: Date | null;
      }> = await manager.query(
        `SELECT "id", "jobId", "heartbeatAt" FROM "analysis_attempt"
           WHERE "analysisId" = $1 AND "outcome" = 'running' FOR UPDATE`,
        [analysisId],
      );

      for (const attempt of running) {
        const fresh =
          attempt.heartbeatAt !== null &&
          now.getTime() - new Date(attempt.heartbeatAt).getTime() <
            input.heartbeatStaleMs;

        // Otro job (id distinto) con un intento vivo: nunca dos llamadas efectivas al Worker.
        // Mismo job: pg-boss solo lo re-entrega después de expirar/fallar el intento previo, así
        // que ese intento quedó abandonado.
        if (attempt.jobId !== jobId && fresh) {
          return { kind: 'busy', runningAttemptId: attempt.id } as const;
        }

        await this.completeAttempt(manager, attempt.id, 'lease_lost', now, {
          code: 'lease_lost',
          retryable: true,
          publicMessage:
            'Intento abandonado: el lease del job expiró o el runner se detuvo.',
        });
      }

      const duplicate: Array<{ id: string }> = await manager.query(
        `SELECT "id" FROM "analysis_attempt" WHERE "jobId" = $1 AND "attemptNumber" = $2`,
        [jobId, attemptNumber],
      );

      if (duplicate.length > 0) {
        return { kind: 'duplicate_attempt' } as const;
      }

      if (
        !isSupportedAnalysisInputSnapshot(analysis.inputSnapshot) ||
        !analysis.fieldId
      ) {
        return { kind: 'invalid_snapshot' } as const;
      }

      const available: Array<{ ok: boolean }> = await manager.query(
        `SELECT u."isActive" AS ok
         FROM "fields" f INNER JOIN "users" u ON u."id" = f."userId"
         WHERE f."id"::text = $1`,
        [analysis.fieldId],
      );

      if (!available[0]?.ok) {
        return { kind: 'field_unavailable' } as const;
      }

      const analysisStartedAt = analysis.startedAt
        ? new Date(analysis.startedAt)
        : now;

      await manager.query(
        `UPDATE "analysis" SET "status" = 'Procesando', "startedAt" = $2, "updatedAt" = $3
         WHERE "id" = $1 AND "status" IN ('Queued', 'Procesando')`,
        [analysisId, analysisStartedAt, now],
      );

      const attemptId = randomUUID();
      await manager.query(
        `INSERT INTO "analysis_attempt"
           ("id", "analysisId", "jobId", "attemptNumber", "startedAt", "heartbeatAt", "outcome")
         VALUES ($1, $2, $3, $4, $5, $5, 'running')`,
        [attemptId, analysisId, jobId, attemptNumber, now],
      );

      return {
        kind: 'claimed',
        attemptId,
        attemptNumber,
        fieldId: analysis.fieldId,
        analysisStartedAt,
        snapshot: analysis.inputSnapshot,
      } as const;
    });
  }

  async touchAttempt(attemptId: string, now: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE "analysis_attempt" SET "heartbeatAt" = $2 WHERE "id" = $1 AND "outcome" = 'running'`,
      [attemptId, now],
    );
  }

  /**
   * Persiste el resultado EXACTAMENTE una vez: solo si el Analysis sigue 'Procesando' (guard en el
   * UPDATE). Si ya es terminal (otro intento ganó, o se cerró por DLQ), el intento queda
   * 'superseded' y no se toca nada del Analysis.
   */
  async finalizeSuccess(input: {
    analysisId: string;
    attemptId: string;
    fields: Partial<Analysis>;
    now: Date;
  }): Promise<'finalized' | 'superseded'> {
    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ status: AnalysisStatus; startedAt: Date | null }> =
        await manager.query(
          `SELECT "status", "startedAt" FROM "analysis" WHERE "id" = $1 FOR UPDATE`,
          [input.analysisId],
        );
      const current = rows[0];

      if (!current || current.status !== 'Procesando') {
        await this.completeAttempt(
          manager,
          input.attemptId,
          'superseded',
          input.now,
          null,
        );
        return 'superseded';
      }

      const update = await manager
        .createQueryBuilder()
        .update(Analysis)
        .set({
          ...input.fields,
          status: 'Finalizado',
          completedAt: input.now,
          durationMs: durationSince(current.startedAt, input.now),
        } as QueryDeepPartialEntity<Analysis>)
        .where('id = :id', { id: input.analysisId })
        .andWhere(`status = 'Procesando'`)
        .execute();

      if (!update.affected) {
        await this.completeAttempt(
          manager,
          input.attemptId,
          'superseded',
          input.now,
          null,
        );
        return 'superseded';
      }

      await this.completeAttempt(
        manager,
        input.attemptId,
        'succeeded',
        input.now,
        null,
      );
      return 'finalized';
    });
  }

  /**
   * Registra el fallo de un intento ya reclamado. `terminal` = no reintentable o sin intentos
   * restantes: además pasa el Analysis a Error en la misma transacción.
   */
  async recordAttemptFailure(input: {
    analysisId: string;
    attemptId: string;
    classification: AnalysisFailureClassification;
    terminal: boolean;
    now: Date;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.completeAttempt(
        manager,
        input.attemptId,
        input.terminal ? 'failed_terminal' : 'failed_retryable',
        input.now,
        input.classification,
      );

      if (input.terminal) {
        await this.failActiveAnalysis(
          manager,
          input.analysisId,
          input.classification.publicMessage,
          input.now,
        );
      }
    });
  }

  /**
   * Falla terminal ANTES de ejecutar (snapshot inválido, campo/usuario no disponible, contrato
   * no soportado): deja un intento terminal (el Analysis Error siempre tiene explicación durable)
   * y pasa el Analysis a Error. Idempotente ante re-entregas del mismo intento.
   */
  async failBeforeExecution(input: {
    analysisId: string;
    jobId: string;
    attemptNumber: number;
    classification: AnalysisFailureClassification;
    now: Date;
  }): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const exists: Array<{ id: string }> = await manager.query(
        `SELECT "id" FROM "analysis" WHERE "id" = $1`,
        [input.analysisId],
      );

      if (!exists[0]) {
        return;
      }

      await manager.query(
        `INSERT INTO "analysis_attempt"
           ("id", "analysisId", "jobId", "attemptNumber", "startedAt", "finishedAt", "outcome",
            "errorCode", "errorMessage", "retryable", "durationMs")
         VALUES ($1, $2, $3, $4, $5, $5, 'failed_terminal', $6, $7, false, 0)
         ON CONFLICT ("jobId", "attemptNumber") DO NOTHING`,
        [
          randomUUID(),
          input.analysisId,
          input.jobId,
          input.attemptNumber,
          input.now,
          input.classification.code,
          truncate(input.classification.publicMessage),
        ],
      );

      await this.failActiveAnalysis(
        manager,
        input.analysisId,
        input.classification.publicMessage,
        input.now,
      );
    });
  }

  /**
   * Cierra una ejecución durable cuyo job ya no puede completarla (pg-boss lo dejó failed/cancelled
   * — p. ej. el runner murió durante el último intento — o el job desapareció): intentos 'running'
   * → lease_lost, Analysis activo → Error. Guardado: no toca un Analysis ya terminal.
   */
  async closeLostExecution(input: {
    analysisId: string;
    classification: AnalysisFailureClassification;
    now: Date;
  }): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT "id" FROM "analysis" WHERE "id" = $1 FOR UPDATE`,
        [input.analysisId],
      );

      const running: Array<{ id: string }> = await manager.query(
        `SELECT "id" FROM "analysis_attempt" WHERE "analysisId" = $1 AND "outcome" = 'running'`,
        [input.analysisId],
      );

      for (const attempt of running) {
        await this.completeAttempt(
          manager,
          attempt.id,
          'lease_lost',
          input.now,
          {
            code: 'lease_lost',
            retryable: false,
            publicMessage: input.classification.publicMessage,
          },
        );
      }

      return this.failActiveAnalysis(
        manager,
        input.analysisId,
        input.classification.publicMessage,
        input.now,
      );
    });
  }

  /**
   * Queued|Procesando → Error (guardado). Misma forma de resultJson de error que el camino legacy
   * (AnalysisService.buildErrorResultFields): mode='error' + fieldId para el frontend.
   */
  async failActiveAnalysis(
    manager: EntityManager,
    analysisId: string,
    publicMessage: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const rows: Array<{ startedAt: Date | null; fieldId: string | null }> =
      await manager.query(
        `SELECT "startedAt", "fieldId" FROM "analysis"
       WHERE "id" = $1 AND "status" IN ('Queued', 'Procesando') FOR UPDATE`,
        [analysisId],
      );
    const current = rows[0];

    if (!current) {
      return false;
    }

    const errorMessage = truncate(publicMessage);
    const [, affected]: [unknown, number] = await manager.query(
      `UPDATE "analysis"
       SET "status" = 'Error', "failedAt" = $2, "durationMs" = $3, "errorMessage" = $4,
           "category" = $5, "resultJson" = $6::jsonb, "updatedAt" = $2
       WHERE "id" = $1 AND "status" IN ('Queued', 'Procesando')`,
      [
        analysisId,
        now,
        durationSince(current.startedAt, now),
        errorMessage,
        ERROR_CATEGORY,
        JSON.stringify({
          mode: 'error',
          message: ERROR_RESULT_MESSAGE,
          error: errorMessage,
          fieldId: current.fieldId ?? undefined,
        }),
      ],
    );

    return affected > 0;
  }

  private async completeAttempt(
    manager: EntityManager,
    attemptId: string,
    outcome: Exclude<AnalysisAttemptOutcome, 'running'>,
    now: Date,
    failure: Pick<
      AnalysisFailureClassification,
      'code' | 'retryable' | 'publicMessage'
    > | null,
  ): Promise<void> {
    await manager.query(
      `UPDATE "analysis_attempt"
       SET "outcome" = $2, "finishedAt" = $3,
           "durationMs" = GREATEST(0, (EXTRACT(EPOCH FROM ($3::timestamp - "startedAt")) * 1000)::int),
           "errorCode" = $4, "errorMessage" = $5, "retryable" = $6
       WHERE "id" = $1 AND "outcome" = 'running'`,
      [
        attemptId,
        outcome,
        now,
        failure?.code ?? null,
        failure ? truncate(failure.publicMessage) : null,
        failure ? failure.retryable : null,
      ],
    );
  }
}
