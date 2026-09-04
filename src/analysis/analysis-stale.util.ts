import { AnalysisStatus } from './entities/analysis.entity';

/**
 * PythonWorkerService.postToWorker corta la espera HTTP a los 10 minutos (timeout duro de
 * axios) — pasado ese punto, processFieldAnalysisInBackground SIEMPRE marca el Analysis
 * Finalizado o Error, salvo que el proceso Node haya muerto/reiniciado a mitad de camino. 20
 * minutos = 2x ese timeout: margen amplio para que nunca se confunda un análisis real (todavía
 * esperando al worker) con uno realmente colgado, sin dejar un campo bloqueado por más de esa
 * ventana cuando sí lo está.
 */
export const ANALYSIS_STALE_THRESHOLD_MS = 20 * 60 * 1000;

/**
 * Shape mínimo necesario para decidir staleness — compatible tanto con la entity `Analysis`
 * completa (tiene `startedAt`) como con la proyección liviana `FieldAnalysisSummary` (no trae
 * `startedAt`, solo `createdAt`). Un solo lugar define la regla; los dos consumidores
 * (AnalysisService y ScheduledAnalysisRunnerService) la llaman, ninguno la reimplementa.
 */
export type StaleAnalysisCandidate = {
  status: AnalysisStatus;
  startedAt?: Date | null;
  createdAt?: Date | null;
};

/**
 * true solo si `candidate` está 'Procesando' y su antigüedad (startedAt, o createdAt si no hay
 * startedAt) supera `thresholdMs`. Sin ningún timestamp disponible, nunca es stale — mismo
 * criterio que computeDurationMs en AnalysisService: sin dato conocido, no se inventa una edad.
 */
export function isAnalysisStale(
  candidate: StaleAnalysisCandidate,
  now: Date,
  thresholdMs: number = ANALYSIS_STALE_THRESHOLD_MS,
): boolean {
  if (candidate.status !== 'Procesando') {
    return false;
  }

  const referenceDate = candidate.startedAt ?? candidate.createdAt;

  if (!referenceDate) {
    return false;
  }

  return now.getTime() - new Date(referenceDate).getTime() > thresholdMs;
}
