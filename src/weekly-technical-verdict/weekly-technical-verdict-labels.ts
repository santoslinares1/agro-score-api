import {
  WeeklyVerdictConfidence,
  WeeklyVerdictLabel,
  WeeklyVerdictTrend,
} from './entities/weekly-technical-verdict.entity';

/**
 * PR 16C: mismos labels de verdict/confidence que analysis-verdict-labels.ts (mismos valores de
 * enum: favorable/attention/critical/insufficient_data, low/medium/high) — copy duplicado a
 * propósito, no importado desde analysis-verdict, mismo criterio ya usado en todo
 * weekly-technical-verdict (ver doc-comment de WeeklyTechnicalVerdict entity): este módulo es
 * hermano de analysis-verdict, no una dependencia suya. `trendLabel` es nuevo — no tiene
 * equivalente en el veredicto individual, que no tiene eje temporal.
 */
const VERDICT_LABELS: Record<WeeklyVerdictLabel, string> = {
  favorable: 'Favorable',
  attention: 'Requiere atención',
  critical: 'Crítico',
  insufficient_data: 'Datos insuficientes',
};

const CONFIDENCE_LABELS: Record<WeeklyVerdictConfidence, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
};

const TREND_LABELS: Record<WeeklyVerdictTrend, string> = {
  improving: 'En mejora',
  stable: 'Estable',
  worsening: 'En deterioro',
  mixed: 'Mixta',
  insufficient_data: 'Datos insuficientes',
};

export function verdictLabel(verdict: WeeklyVerdictLabel | null): string {
  return verdict ? VERDICT_LABELS[verdict] : 'No disponible';
}

export function confidenceLabel(
  confidence: WeeklyVerdictConfidence | null,
): string {
  return confidence ? CONFIDENCE_LABELS[confidence] : '';
}

export function trendLabel(trend: WeeklyVerdictTrend | null): string {
  return trend ? TREND_LABELS[trend] : 'No disponible';
}
