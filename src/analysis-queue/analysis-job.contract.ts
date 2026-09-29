/**
 * ADR-001: contrato de la cola durable de análisis. El job de pg-boss y la fila de
 * analysis_job_outbox transportan SOLO IDs y metadata de entrega — nunca GeoJSON, imágenes ni
 * resultJson. El input agronómico vive en Analysis.inputSnapshot (ver analysis-input-snapshot.ts).
 */
export const ANALYSIS_EXECUTE_JOB = 'analysis.execute.v1';
export const ANALYSIS_EXECUTE_DEAD_LETTER_QUEUE = 'analysis.execute.v1.dlq';
export const ANALYSIS_JOB_CONTRACT_VERSION = 1;

export type AnalysisJobTrigger = 'manual' | 'weekly';

export type AnalysisExecuteJobPayload = {
  analysisId: string;
  fieldId: string;
  requestedByUserId: string;
  trigger: AnalysisJobTrigger;
  scheduledRunId?: string;
  contractVersion: 1;
  idempotencyKey: string;
};

export function buildAnalysisIdempotencyKey(analysisId: string): string {
  return `analysis:${analysisId}`;
}

export function buildAnalysisExecutePayload(input: {
  analysisId: string;
  fieldId: string;
  requestedByUserId: string;
  trigger: AnalysisJobTrigger;
  scheduledRunId?: string;
}): AnalysisExecuteJobPayload {
  return {
    analysisId: input.analysisId,
    fieldId: input.fieldId,
    requestedByUserId: input.requestedByUserId,
    trigger: input.trigger,
    ...(input.scheduledRunId ? { scheduledRunId: input.scheduledRunId } : {}),
    contractVersion: ANALYSIS_JOB_CONTRACT_VERSION,
    idempotencyKey: buildAnalysisIdempotencyKey(input.analysisId),
  };
}

export type ParsedJobPayload =
  | { ok: true; payload: AnalysisExecuteJobPayload }
  | {
      ok: false;
      reason: 'unsupported_contract_version' | 'invalid_payload';
      analysisId: string | null;
    };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Valida el payload recibido por el consumidor. Una versión de contrato desconocida o un shape
 * inválido nunca se reintenta (ver analysis-failure-classifier.ts). `analysisId` se devuelve
 * cuando es legible, para poder cerrar el Analysis afectado de todos modos.
 */
export function parseAnalysisExecutePayload(data: unknown): ParsedJobPayload {
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: 'invalid_payload', analysisId: null };
  }

  const record = data as Record<string, unknown>;
  const analysisId = isNonEmptyString(record.analysisId)
    ? record.analysisId
    : null;

  if (record.contractVersion !== ANALYSIS_JOB_CONTRACT_VERSION) {
    return { ok: false, reason: 'unsupported_contract_version', analysisId };
  }

  const validTrigger =
    record.trigger === 'manual' || record.trigger === 'weekly';

  if (
    !analysisId ||
    !isNonEmptyString(record.fieldId) ||
    !isNonEmptyString(record.requestedByUserId) ||
    !validTrigger ||
    record.idempotencyKey !== buildAnalysisIdempotencyKey(analysisId) ||
    (record.scheduledRunId !== undefined &&
      !isNonEmptyString(record.scheduledRunId))
  ) {
    return { ok: false, reason: 'invalid_payload', analysisId };
  }

  return { ok: true, payload: record as unknown as AnalysisExecuteJobPayload };
}
