/**
 * KPIs P0: "Time to First Technical Value" — MIN(Analysis.completedAt sufficient) - User.createdAt
 * por usuario activado. El ticket pide explícitamente p50/p75/p95 en vez de promedio ("No usar
 * promedio como medida principal" — un solo usuario con una espera de meses infla el promedio de
 * un cohorte chico de forma engañosa, un percentil no).
 */

const MS_PER_HOUR = 60 * 60 * 1000;

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_HOUR;
}

export interface TimeToValuePercentiles {
  p50: number | null;
  p75: number | null;
  /** null si el volumen de usuarios activados no alcanza MIN_SAMPLES_FOR_P95 — mostrar un p95
   * calculado con pocas muestras (ej. 1-2) equivaldría a mostrar el máximo como si fuera un
   * percentil real, e "inventar resultados" con apariencia de precisión que el ticket prohíbe. */
  p95: number | null;
}

/**
 * Umbral mínimo de muestras para que un p95 tenga sentido estadístico real: con 1/(1-0.95) = 20
 * muestras hay margen para que al menos una quede genuinamente por encima del percentil 95 — por
 * debajo de eso, el "p95" nearest-rank coincide con el máximo (o está muy cerca), y mostrarlo como
 * percentil sería engañoso. Documentado acá porque es una decisión de producto, no un detalle de
 * implementación — ver el ticket ("p95 solo si el volumen permite calcularlo sin inventar
 * resultados").
 */
export const MIN_SAMPLES_FOR_P95 = 20;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Percentil por "nearest rank" (sin interpolación) sobre `sorted` — ascendente, ya ordenado por el
 * caller. Nunca inventa un valor entre dos muestras reales: el resultado siempre ES una de las
 * duraciones observadas.
 */
function nearestRank(sorted: number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

/**
 * `durationsHours` = horas entre User.createdAt y su primer Analysis.completedAt sufficient, SOLO
 * de usuarios ya activados (ver AdminService) — nunca incluye usuarios sin activar (no hay
 * duración que medir todavía, y no se inventa un valor "infinito" ni se excluye silenciosamente
 * del cómputo de otra forma que no sea, justamente, no aparecer acá).
 */
export function computeTimeToValuePercentiles(
  durationsHours: number[],
): TimeToValuePercentiles {
  if (durationsHours.length === 0) {
    return { p50: null, p75: null, p95: null };
  }

  const sorted = [...durationsHours].sort((a, b) => a - b);

  return {
    p50: round(nearestRank(sorted, 50), 2),
    p75: round(nearestRank(sorted, 75), 2),
    p95:
      sorted.length >= MIN_SAMPLES_FOR_P95
        ? round(nearestRank(sorted, 95), 2)
        : null,
  };
}
