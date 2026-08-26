import {
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
} from './entities/analysis-technical-verdict.entity';

/**
 * PR 12A: mismos labels que analysis-result.component.ts (PR 11C) y report-pdf.helpers.ts
 * (PR 11D) — copy duplicado a propósito en vez de importado desde report-pdf.helpers.ts: ese
 * archivo vive bajo analysis/report-pdf (pensado para pdfmake) y este PR es backend-only sobre el
 * mail semanal, sin tocar el módulo de PDF. Si un futuro cambio de copy toca esto, hay que
 * actualizar los tres lugares.
 */
const VERDICT_LABELS: Record<AnalysisVerdictLabel, string> = {
  favorable: 'Favorable',
  attention: 'Requiere atención',
  critical: 'Crítico',
  insufficient_data: 'Datos insuficientes',
};

const CONFIDENCE_LABELS: Record<AnalysisVerdictConfidence, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
};

export function verdictLabel(verdict: AnalysisVerdictLabel | null): string {
  return verdict ? VERDICT_LABELS[verdict] : 'No disponible';
}

export function confidenceLabel(
  confidence: AnalysisVerdictConfidence | null,
): string {
  return confidence ? CONFIDENCE_LABELS[confidence] : '';
}
