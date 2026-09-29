/**
 * ADR-001: metadata ESTRUCTURADA de una llamada fallida al Worker, adjuntada como `cause` a la
 * excepción pública que lanza PythonWorkerService.handleWorkerError. Permite clasificar
 * reintentables/no reintentables (analysis-failure-classifier.ts) sin parsear mensajes humanos.
 * Nunca incluye el body de respuesta del Worker, headers, URL ni el mensaje crudo de Axios.
 */
export class WorkerCallFailure extends Error {
  constructor(
    readonly operation: 'analyze' | 'weekly-report',
    readonly httpStatus: number | null,
    readonly transportCode: string | null,
  ) {
    super(
      `Worker call failed (operation=${operation}, status=${httpStatus ?? 'none'}, code=${
        transportCode ?? 'none'
      })`,
    );
    this.name = 'WorkerCallFailure';
  }
}

export function getWorkerCallFailure(error: unknown): WorkerCallFailure | null {
  if (error instanceof WorkerCallFailure) {
    return error;
  }

  const cause = (error as { cause?: unknown } | null)?.cause;

  return cause instanceof WorkerCallFailure ? cause : null;
}
