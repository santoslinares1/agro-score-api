import type { WeeklySnapshotDataQuality } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import type { ComparisonVsPrevious } from '../scheduled-analysis/weekly-analysis-snapshot-comparison.util';
import {
  SCORE_STABLE_THRESHOLD,
  INDEX_STABLE_THRESHOLD,
  classifyDelta,
} from '../scheduled-analysis/weekly-analysis-snapshot-comparison.util';
import {
  WeeklyVerdictConfidence,
  WeeklyVerdictLabel,
  WeeklyVerdictTrend,
} from './entities/weekly-technical-verdict.entity';

/** PR 16A, sección 6: technicalVerdict describe el ESTADO; weeklyTechnicalVerdict describe el
 * DELTA. individualVerdict acá es enriquecimiento opcional (nunca una dependencia dura, ver PR
 * 16A sección 8) — solo summary/verdict/confidence, nunca se espera a que exista. */
export interface WeeklyVerdictIndividualContext {
  verdict: string | null;
  confidence: string | null;
  summary: string | null;
}

export interface WeeklyVerdictGeneratorInput {
  fieldName: string | null;
  weekStart: string;
  weekEnd: string;
  score: number | null;
  scoreLabel: string | null;
  ndviMean: number | null;
  ndmiMean: number | null;
  dominantZone: string | null;
  dominantZonePercentage: number | null;
  analyzedAreaHa: number | null;
  lotCount: number | null;
  dataQualityStatus: WeeklySnapshotDataQuality;
  hasRgbImage: boolean;
  hasNdviImage: boolean;
  hasNdmiImage: boolean;
  hasImageSeries: boolean;
  previousSnapshotId: string | null;
  comparison: ComparisonVsPrevious;
  individualVerdict: WeeklyVerdictIndividualContext | null;
}

export interface GeneratedWeeklyVerdict {
  verdict: WeeklyVerdictLabel;
  trend: WeeklyVerdictTrend;
  confidence: WeeklyVerdictConfidence;
  summary: string;
  keyChanges: string[];
  areasToReview: string[];
  recommendations: string[];
  limitations: string[];
}

const COMMON_LIMITATIONS = [
  'La comparación se basa en índices satelitales y debe validarse con observación en campo.',
  'El diagnóstico semanal no reemplaza el criterio de un profesional agronómico.',
];

const FAVORABLE_SCORE_THRESHOLD = 75;
const ATTENTION_SCORE_THRESHOLD = 50;

/** Mismos umbrales que analysis-verdict-generator.util.ts (classifyVerdict) — el "estado actual"
 * de una semana se clasifica con el mismo criterio que un análisis puntual, la diferencia la hace
 * `trend`, no `verdict`. */
function classifyCurrentVerdict(
  score: number | null,
  dataQualityStatus: WeeklySnapshotDataQuality,
): WeeklyVerdictLabel {
  if (score === null || dataQualityStatus === 'insufficient') {
    return 'insufficient_data';
  }

  if (score >= FAVORABLE_SCORE_THRESHOLD) return 'favorable';
  if (score >= ATTENTION_SCORE_THRESHOLD) return 'attention';
  return 'critical';
}

/**
 * PR 16A, sección 8: "si score estable pero NDVI/NDMI se mueven en direcciones opuestas → mixed".
 * Sin snapshot anterior, o con datos insuficientes esta semana (la comparación no es confiable),
 * `insufficient_data` — nunca inventa una tendencia sin base.
 */
function deriveTrend(input: WeeklyVerdictGeneratorInput): WeeklyVerdictTrend {
  if (!input.previousSnapshotId || input.dataQualityStatus === 'insufficient') {
    return 'insufficient_data';
  }

  const { scoreDelta, ndviMeanDelta, ndmiMeanDelta } = input.comparison;

  if (scoreDelta === null && ndviMeanDelta === null && ndmiMeanDelta === null) {
    return 'insufficient_data';
  }

  if (scoreDelta !== null) {
    const scoreTrend = classifyDelta(scoreDelta, SCORE_STABLE_THRESHOLD);
    if (scoreTrend === 'up') return 'improving';
    if (scoreTrend === 'down') return 'worsening';
  }

  const ndviTrend =
    ndviMeanDelta !== null
      ? classifyDelta(ndviMeanDelta, INDEX_STABLE_THRESHOLD)
      : null;
  const ndmiTrend =
    ndmiMeanDelta !== null
      ? classifyDelta(ndmiMeanDelta, INDEX_STABLE_THRESHOLD)
      : null;

  if (
    ndviTrend &&
    ndmiTrend &&
    ((ndviTrend === 'up' && ndmiTrend === 'down') ||
      (ndviTrend === 'down' && ndmiTrend === 'up'))
  ) {
    return 'mixed';
  }

  return 'stable';
}

function classifyConfidence(
  trend: WeeklyVerdictTrend,
  input: WeeklyVerdictGeneratorInput,
): WeeklyVerdictConfidence {
  if (trend === 'insufficient_data') {
    return 'low';
  }

  return input.comparison.ndmiMeanDelta !== null ? 'high' : 'medium';
}

function areasToReviewFor(
  verdict: WeeklyVerdictLabel,
  input: WeeklyVerdictGeneratorInput,
): string[] {
  if (verdict === 'favorable' || verdict === 'insufficient_data') {
    return [];
  }

  const areas = [
    'Priorizar zonas con menor desempeño relativo según los mapas del análisis semanal.',
  ];

  if (input.dominantZone) {
    areas.push(
      `Revisar sectores asociados a la zona dominante actual ("${input.dominantZone}") si se mantiene en desempeño bajo.`,
    );
  }

  return areas;
}

function recommendationsFor(trend: WeeklyVerdictTrend): string[] {
  switch (trend) {
    case 'insufficient_data':
      return [
        'Usar este reporte como línea de base para comparar próximas semanas.',
        'Continuar el monitoreo semanal.',
      ];
    case 'improving':
      return [
        'Mantener el manejo y el monitoreo semanal para confirmar que la tendencia se sostiene.',
      ];
    case 'worsening':
      return [
        'Revisar en campo las zonas de menor desempeño.',
        'Comparar con riego, suelo, relieve, manejo reciente y clima.',
        'Repetir el análisis en los próximos días para confirmar la tendencia.',
      ];
    case 'mixed':
      return [
        'Revisar en campo los sectores donde algún índice bajó, aunque el resultado general se mantenga.',
        'Continuar el monitoreo semanal para confirmar si la variación se sostiene.',
      ];
    case 'stable':
    default:
      return ['Continuar el monitoreo semanal habitual.'];
  }
}

function summaryFor(
  trend: WeeklyVerdictTrend,
  input: WeeklyVerdictGeneratorInput,
): string {
  switch (trend) {
    case 'insufficient_data':
      return input.previousSnapshotId
        ? 'No hay datos suficientes esta semana para comparar de forma confiable con el reporte anterior.'
        : 'Este es el primer reporte semanal disponible para el campo, por lo que todavía no hay una base histórica suficiente para evaluar la evolución.';
    case 'improving':
      return 'Respecto del reporte anterior, los índices disponibles sugieren una mejora general. Conviene validar en campo antes de sacar conclusiones definitivas.';
    case 'worsening':
      return 'Respecto del reporte anterior, los índices disponibles sugieren un retroceso general. Conviene revisar en campo las zonas de menor desempeño antes de concluir una causa.';
    case 'mixed':
      return 'Respecto del reporte anterior, los índices disponibles muestran señales mixtas: algunos indicadores mejoran y otros retroceden. Conviene revisar en campo antes de sacar conclusiones.';
    case 'stable':
    default:
      return 'Respecto del reporte anterior, el campo mantiene un estado general similar, sin variaciones relevantes en los índices disponibles.';
  }
}

/**
 * PR 16B: generador determinístico del diagnóstico semanal — mismo rol que
 * generateTechnicalVerdict (analysis-verdict-generator.util.ts) para el veredicto individual:
 * reglas locales, sin red, sin API key, seguro por default (WEEKLY_TECHNICAL_VERDICT_PROVIDER
 * vacío/no reconocido cae acá). `keyChanges` reusa comparisonVsPrevious.summary tal cual — ya es
 * una redacción determinística honesta del delta (ver weekly-analysis-snapshot-comparison.util.ts),
 * no hace falta redactar de nuevo lo mismo.
 */
export function generateWeeklyTechnicalVerdict(
  input: WeeklyVerdictGeneratorInput,
): GeneratedWeeklyVerdict {
  const verdict = classifyCurrentVerdict(input.score, input.dataQualityStatus);
  const trend = deriveTrend(input);
  const confidence = classifyConfidence(trend, input);

  const limitations = [...COMMON_LIMITATIONS];
  if (!input.previousSnapshotId) {
    limitations.push(
      'No hay un reporte semanal anterior para calcular una tendencia.',
    );
  } else if (input.dataQualityStatus === 'insufficient') {
    limitations.push(
      'Los datos satelitales de esta semana fueron insuficientes para una comparación confiable.',
    );
  }

  return {
    verdict,
    trend,
    confidence,
    summary: summaryFor(trend, input),
    keyChanges: [...input.comparison.summary],
    areasToReview: areasToReviewFor(verdict, input),
    recommendations: recommendationsFor(trend),
    limitations,
  };
}
