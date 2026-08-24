import { WeeklySnapshotDataQuality } from './entities/weekly-analysis-snapshot.entity';

export interface SnapshotComparisonInput {
  id: string;
  weekStart: string;
  weekEnd: string;
  score: number | null;
  ndviMean: number | null;
  ndmiMean: number | null;
  dominantZone: string | null;
  analyzedAreaHa: number | null;
  dataQualityStatus: WeeklySnapshotDataQuality;
  hasRgbImage: boolean;
  hasNdviImage: boolean;
  hasNdmiImage: boolean;
}

export interface ComparisonVsPrevious {
  previousSnapshotId: string | null;
  previousWeekStart: string | null;
  previousWeekEnd: string | null;
  scoreDelta: number | null;
  ndviMeanDelta: number | null;
  ndmiMeanDelta: number | null;
  dominantZoneChanged: boolean;
  dominantZoneFrom: string | null;
  dominantZoneTo: string | null;
  analyzedAreaDeltaHa: number | null;
  dataQualityChanged: boolean;
  summary: string[];
}

/** Umbrales heurísticos de producto (Fase 5) — NO son diagnóstico agronómico definitivo, solo
 * evitan que una variación mínima se lea como "mejora"/"baja" en el copy del email/UI. */
const SCORE_STABLE_THRESHOLD = 5;
const INDEX_STABLE_THRESHOLD = 0.03;

type Trend = 'up' | 'down' | 'stable';

function classifyDelta(delta: number, threshold: number): Trend {
  if (delta >= threshold) return 'up';
  if (delta <= -threshold) return 'down';
  return 'stable';
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function delta(current: number | null, previous: number | null, decimals: number): number | null {
  if (current === null || previous === null) {
    return null;
  }

  return round(current - previous, decimals);
}

function scoreSentence(scoreDelta: number | null): string | null {
  if (scoreDelta === null) {
    return null;
  }

  switch (classifyDelta(scoreDelta, SCORE_STABLE_THRESHOLD)) {
    case 'up':
      return `El score subió ${scoreDelta} puntos respecto de la semana anterior.`;
    case 'down':
      return `El score bajó ${Math.abs(scoreDelta)} puntos respecto de la semana anterior.`;
    default:
      return 'El score se mantuvo estable respecto de la semana anterior.';
  }
}

function indexSentence(label: string, indexDelta: number | null): string | null {
  if (indexDelta === null) {
    return null;
  }

  switch (classifyDelta(indexDelta, INDEX_STABLE_THRESHOLD)) {
    case 'up':
      return `${label} promedio subió respecto de la semana anterior.`;
    case 'down':
      return `${label} promedio bajó respecto de la semana anterior.`;
    default:
      return `${label} promedio estable.`;
  }
}

function dominantZoneSentence(current: string | null, previous: string | null): string | null {
  if (!current || !previous) {
    return null;
  }

  return current === previous
    ? `La zona predominante se mantiene ${current}.`
    : `La zona predominante cambió de ${previous} a ${current}.`;
}

function limitationSentence(current: Pick<SnapshotComparisonInput, 'hasRgbImage' | 'hasNdviImage' | 'hasNdmiImage'>): string | null {
  const missing: string[] = [];
  if (!current.hasRgbImage) missing.push('RGB');
  if (!current.hasNdviImage) missing.push('NDVI');
  if (!current.hasNdmiImage) missing.push('NDMI');

  if (!missing.length) {
    return null;
  }

  return missing.length === 3
    ? 'Esta semana no hubo imágenes satelitales válidas.'
    : `Esta semana no hubo imagen ${missing.join('/')} válida.`;
}

const DATA_QUALITY_LABEL: Record<WeeklySnapshotDataQuality, string> = {
  sufficient: 'datos suficientes',
  partial: 'datos parciales',
  insufficient: 'datos insuficientes',
};

/**
 * Fase 5: compara `current` contra el snapshot semanal inmediatamente anterior del mismo campo
 * (o `null` si es el primero). Nunca inventa un delta cuando falta un lado del dato — ver
 * `delta()`. Los umbrales de "sube/baja/estable" son heurísticos de producto, documentados en
 * SCORE_STABLE_THRESHOLD/INDEX_STABLE_THRESHOLD, no un diagnóstico agronómico.
 */
export function compareWeeklySnapshots(
  current: SnapshotComparisonInput,
  previous: SnapshotComparisonInput | null,
): ComparisonVsPrevious {
  if (!previous) {
    const summary = ['Primer reporte semanal disponible para este campo.'];
    const limitation = limitationSentence(current);

    if (limitation) {
      summary.push(limitation);
    }

    return {
      previousSnapshotId: null,
      previousWeekStart: null,
      previousWeekEnd: null,
      scoreDelta: null,
      ndviMeanDelta: null,
      ndmiMeanDelta: null,
      dominantZoneChanged: false,
      dominantZoneFrom: null,
      dominantZoneTo: current.dominantZone,
      analyzedAreaDeltaHa: null,
      dataQualityChanged: false,
      summary,
    };
  }

  const scoreDelta = delta(current.score, previous.score, 0);
  const ndviMeanDelta = delta(current.ndviMean, previous.ndviMean, 3);
  const ndmiMeanDelta = delta(current.ndmiMean, previous.ndmiMean, 3);
  const analyzedAreaDeltaHa = delta(current.analyzedAreaHa, previous.analyzedAreaHa, 2);
  const dominantZoneChanged = Boolean(
    current.dominantZone && previous.dominantZone && current.dominantZone !== previous.dominantZone,
  );
  const dataQualityChanged = current.dataQualityStatus !== previous.dataQualityStatus;

  const summary = [
    scoreSentence(scoreDelta),
    indexSentence('NDVI', ndviMeanDelta),
    dominantZoneSentence(current.dominantZone, previous.dominantZone),
    limitationSentence(current),
  ].filter((line): line is string => Boolean(line));

  if (dataQualityChanged) {
    summary.push(
      `La calidad del reporte pasó de ${DATA_QUALITY_LABEL[previous.dataQualityStatus]} a ${DATA_QUALITY_LABEL[current.dataQualityStatus]}.`,
    );
  }

  return {
    previousSnapshotId: previous.id,
    previousWeekStart: previous.weekStart,
    previousWeekEnd: previous.weekEnd,
    scoreDelta,
    ndviMeanDelta,
    ndmiMeanDelta,
    dominantZoneChanged,
    dominantZoneFrom: previous.dominantZone,
    dominantZoneTo: current.dominantZone,
    analyzedAreaDeltaHa,
    dataQualityChanged,
    summary,
  };
}
