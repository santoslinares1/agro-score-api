import type { ComparisonVsPrevious } from '../scheduled-analysis/weekly-analysis-snapshot-comparison.util';
import type { WeeklyAnalysisSnapshot } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import {
  WeeklyVerdictGeneratorInput,
  WeeklyVerdictIndividualContext,
} from './weekly-technical-verdict-generator.util';

/** Defensivo: comparisonVsPrevious es `nullable: true` a nivel de columna, pero
 * WeeklyAnalysisSnapshotService.createFromAnalysis SIEMPRE lo completa (incluso sin snapshot
 * anterior, ver compareWeeklySnapshots) — esto solo cubre una fila corrupta/legacy, nunca el
 * camino real. */
const EMPTY_COMPARISON: ComparisonVsPrevious = {
  previousSnapshotId: null,
  previousWeekStart: null,
  previousWeekEnd: null,
  scoreDelta: null,
  ndviMeanDelta: null,
  ndmiMeanDelta: null,
  dominantZoneChanged: false,
  dominantZoneFrom: null,
  dominantZoneTo: null,
  analyzedAreaDeltaHa: null,
  dataQualityChanged: false,
  summary: [],
};

/**
 * Traduce un WeeklyAnalysisSnapshot ya persistido (más contexto opcional) a la entrada del
 * generador — nunca dispara cálculo nuevo, nunca vuelve a tocar Analysis.resultJson: todo lo que
 * necesita ya está en el snapshot (métricas actuales) y en su comparisonVsPrevious (deltas ya
 * calculados por compareWeeklySnapshots). No hace falta cargar el snapshot anterior completo — el
 * propio PR 16A (sección 11) concluyó que comparisonVsPrevious ya alcanza como base.
 */
export function buildWeeklyVerdictGeneratorInput(
  snapshot: WeeklyAnalysisSnapshot,
  fieldName: string | null,
  individualVerdict: WeeklyVerdictIndividualContext | null,
): WeeklyVerdictGeneratorInput {
  const comparison =
    (snapshot.comparisonVsPrevious as unknown as ComparisonVsPrevious | null) ??
    EMPTY_COMPARISON;

  return {
    fieldName,
    weekStart: snapshot.weekStart,
    weekEnd: snapshot.weekEnd,
    score: snapshot.score,
    scoreLabel: snapshot.scoreLabel,
    ndviMean: snapshot.ndviMean,
    ndmiMean: snapshot.ndmiMean,
    dominantZone: snapshot.dominantZone,
    dominantZonePercentage: snapshot.dominantZonePercentage,
    analyzedAreaHa: snapshot.analyzedAreaHa,
    lotCount: snapshot.lotCount,
    dataQualityStatus: snapshot.dataQualityStatus,
    hasRgbImage: snapshot.hasRgbImage,
    hasNdviImage: snapshot.hasNdviImage,
    hasNdmiImage: snapshot.hasNdmiImage,
    hasImageSeries: snapshot.hasImageSeries,
    previousSnapshotId: comparison.previousSnapshotId,
    comparison,
    individualVerdict,
  };
}
