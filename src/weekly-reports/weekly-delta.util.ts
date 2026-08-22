import { WeeklyDeltaDirection } from './entities/weekly-lot-index-observation.entity';

/**
 * Valor de prototipo, sin validación agronómica (ver handoff de Fase 1, sección 17/18) — mismo
 * UMBRAL_DELTA=0.015 que el notebook usa para decidir ▲▼● en el reporte semanal.
 */
export const DEFAULT_DELTA_THRESHOLD = 0.015;

export function computeDeltaDirection(
  delta: number | null | undefined,
  threshold: number = DEFAULT_DELTA_THRESHOLD,
): WeeklyDeltaDirection | null {
  if (delta === null || delta === undefined || Number.isNaN(delta)) {
    return null;
  }

  if (delta > threshold) {
    return 'up';
  }

  if (delta < -threshold) {
    return 'down';
  }

  return 'stable';
}
