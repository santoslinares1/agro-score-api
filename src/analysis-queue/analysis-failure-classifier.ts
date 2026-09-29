import { HttpException } from '@nestjs/common';

import { getWorkerCallFailure } from '../python-worker/worker-call-failure';

/**
 * ADR-001: única clasificación de fallas del consumidor de la cola. Decide por datos
 * estructurados (status HTTP / código de transporte adjuntos por PythonWorkerService, o el tipo
 * de falla de preparación) — nunca parseando mensajes humanos.
 */
export type AnalysisFailureCode =
  | 'worker_timeout'
  | 'worker_unreachable'
  | 'worker_rate_limited'
  | 'worker_server_error'
  | 'worker_bad_request'
  | 'worker_unprocessable'
  | 'worker_rejected'
  | 'invalid_input'
  | 'invalid_snapshot'
  | 'unsupported_contract_version'
  | 'invalid_payload'
  | 'field_unavailable'
  | 'lease_lost'
  | 'attempts_exhausted'
  | 'internal_error';

export type AnalysisFailureClassification = {
  code: AnalysisFailureCode;
  retryable: boolean;
  /** Mensaje público sanitizado — es lo que termina en Analysis.errorMessage. */
  publicMessage: string;
};

const PUBLIC_MESSAGES: Record<AnalysisFailureCode, string> = {
  worker_timeout: 'El motor de análisis excedió el tiempo máximo de respuesta.',
  worker_unreachable: 'El motor de análisis no está disponible temporalmente.',
  worker_rate_limited: 'El motor de análisis está saturado temporalmente.',
  worker_server_error: 'El motor de análisis no pudo completar la operación.',
  worker_bad_request:
    'Los parámetros enviados al motor de análisis no son válidos.',
  worker_unprocessable:
    'El motor de análisis rechazó el formato de los datos enviados.',
  worker_rejected: 'El motor de análisis rechazó la solicitud.',
  invalid_input: 'Los datos del campo no son válidos para el análisis.',
  invalid_snapshot: 'El análisis no tiene un input válido para ejecutarse.',
  unsupported_contract_version:
    'El análisis usa una versión de contrato no soportada.',
  invalid_payload: 'El trabajo del análisis tiene un formato inválido.',
  field_unavailable:
    'El campo o su propietario ya no están disponibles para el análisis.',
  lease_lost: 'El procesamiento del análisis se interrumpió antes de terminar.',
  attempts_exhausted:
    'El análisis no pudo completarse después de varios intentos.',
  internal_error: 'Error interno al procesar el análisis.',
};

const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
]);

export function classificationFor(
  code: AnalysisFailureCode,
  retryable: boolean,
): AnalysisFailureClassification {
  return { code, retryable, publicMessage: PUBLIC_MESSAGES[code] };
}

/**
 * Clasifica un error lanzado por PythonWorkerService.runFieldAnalysis. Todo error del tramo HTTP
 * trae un WorkerCallFailure como `cause` (ver handleWorkerError); un error SIN esa metadata salió
 * del mapeo del input antes de cualquier llamada HTTP (geometría/formato inválido) y nunca se
 * reintenta: reintentar el mismo snapshot inmutable produciría exactamente el mismo fallo.
 */
export function classifyWorkerCallError(
  error: unknown,
): AnalysisFailureClassification {
  const failure = getWorkerCallFailure(error);

  if (!failure) {
    if (error instanceof HttpException && error.getStatus() >= 500) {
      return classificationFor('worker_unreachable', true);
    }

    return classificationFor('invalid_input', false);
  }

  const status = failure.httpStatus;

  if (status === 400) {
    return classificationFor('worker_bad_request', false);
  }

  if (status === 422) {
    return classificationFor('worker_unprocessable', false);
  }

  if (status === 429) {
    return classificationFor('worker_rate_limited', true);
  }

  if (status !== null && status >= 500) {
    // El Worker actual colapsa distintas fallas de Earth Engine en un 500: se tratan como
    // transitorias dentro del máximo de intentos configurado.
    return classificationFor('worker_server_error', true);
  }

  if (status === 408) {
    return classificationFor('worker_timeout', true);
  }

  if (status !== null) {
    // 401/403/404/otros 4xx: el Worker fue alcanzado y rechazó la solicitud de forma determinista
    // (token o ruta mal configurados) — reintentar no cambia el resultado.
    return classificationFor('worker_rejected', false);
  }

  if (
    failure.transportCode &&
    RETRYABLE_TRANSPORT_CODES.has(failure.transportCode)
  ) {
    return classificationFor('worker_timeout', true);
  }

  // Sin response: conexión rechazada, DNS, red.
  return classificationFor('worker_unreachable', true);
}
