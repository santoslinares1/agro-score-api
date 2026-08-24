import { WorkerResultJson } from '../python-worker/types';
import { WeeklySnapshotDataQuality } from './entities/weekly-analysis-snapshot.entity';

export interface ExtractedSnapshotMetrics {
  analyzedAreaHa: number | null;
  lotCount: number | null;
  dominantZone: string | null;
  dominantZonePercentage: number | null;
  ndviMean: number | null;
  ndmiMean: number | null;
  hasRgbImage: boolean;
  hasNdviImage: boolean;
  hasNdmiImage: boolean;
  hasImageSeries: boolean;
}

const EMPTY_METRICS: ExtractedSnapshotMetrics = {
  analyzedAreaHa: null,
  lotCount: null,
  dominantZone: null,
  dominantZonePercentage: null,
  ndviMean: null,
  ndmiMean: null,
  hasRgbImage: false,
  hasNdviImage: false,
  hasNdmiImage: false,
  hasImageSeries: false,
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * `resultJson.totalsByZone` (ver report-pdf.helpers.ts:getFieldZoneTotals) — zonas agregadas a
 * nivel campo, la misma fuente que ya usa el PDF para "zona predominante". La zona con más
 * hectáreas gana; en empate exacto, la primera encontrada (mismo criterio que
 * getTopZoneByHectares).
 */
function extractDominantZone(resultJson: WorkerResultJson): { name: string; percent: number } | null {
  const totals = Array.isArray(resultJson.totalsByZone) ? resultJson.totalsByZone : [];

  if (!totals.length) {
    return null;
  }

  const top = totals.reduce((best: any, zone: any) => {
    const hectares = Number(zone?.hectares ?? 0);
    return hectares > Number(best?.hectares ?? 0) ? zone : best;
  }, totals[0]);

  if (!top?.name) {
    return null;
  }

  return { name: String(top.name), percent: Number(top.percent ?? 0) };
}

/**
 * `resultJson.zones` (ver report-pdf.helpers.ts:getLotZoneDetails/getAnalyzedAreaHa) — superficie
 * realmente analizada por el worker (píxeles válidos), no la superficie de referencia cargada a
 * mano en el campo (`resultJson.fieldLots`).
 */
function extractAnalyzedAreaHa(resultJson: WorkerResultJson): number | null {
  const zones = Array.isArray(resultJson.zones) ? resultJson.zones : [];

  if (!zones.length) {
    return null;
  }

  const total = zones.reduce((acc: number, lot: any) => acc + Number(lot?.area_ha ?? 0), 0);
  return round(total, 2);
}

function extractLotCount(resultJson: WorkerResultJson): number | null {
  const zones = Array.isArray(resultJson.zones) ? resultJson.zones : [];

  if (zones.length) {
    return zones.length;
  }

  const fieldLots = Array.isArray((resultJson as any).fieldLots) ? (resultJson as any).fieldLots : [];
  return fieldLots.length || null;
}

/**
 * `resultJson.timeseries` (ver report-pdf.helpers.ts:getCampaignRows/avgMetric) — promedio plano
 * de `values.NDVI_mean`/`NDMI_mean` en TODAS las filas de TODOS los lotes que trae el resultJson
 * de esta corrida puntual. Sin agrupar por campaña (a diferencia del PDF): para una ventana de 7
 * días no hay campaña que agrupar, es directamente "el promedio de esta semana". Filas sin
 * NDVI_count (sin píxeles válidos) o con el mean como NaN se descartan, nunca se computan como 0.
 */
function extractIndexMean(resultJson: WorkerResultJson, key: 'NDVI_mean' | 'NDMI_mean'): number | null {
  const timeseries = Array.isArray(resultJson.timeseries) ? resultJson.timeseries : [];
  const rows: any[] = timeseries.flatMap((serie: any) => (Array.isArray(serie?.rows) ? serie.rows : []));

  const values = rows
    .filter((row) => Number(row?.values?.NDVI_count ?? 0) > 0)
    .map((row) => Number(row?.values?.[key]))
    .filter((value) => !Number.isNaN(value));

  if (!values.length) {
    return null;
  }

  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return round(mean, 4);
}

/** `resultJson.mapAssets.rgb` (ver report-pdf.helpers.ts:isRgbAvailable). */
function extractHasRgbImage(resultJson: WorkerResultJson): boolean {
  const rgb = (resultJson as any)?.mapAssets?.rgb;
  return rgb?.available === true && Boolean(rgb?.image_base64);
}

/**
 * `resultJson.mapAssets.indexImages[]` (ver report-pdf.helpers.ts:getPrimaryIndexImages) —
 * filtra por index exacto, disponible y con imagen real, mismo criterio que el PDF.
 */
function extractHasIndexImage(resultJson: WorkerResultJson, index: 'NDVI' | 'NDMI'): boolean {
  const items = Array.isArray((resultJson as any)?.mapAssets?.indexImages)
    ? (resultJson as any).mapAssets.indexImages
    : [];

  return items.some((item: any) => item?.index === index && item?.available === true && Boolean(item?.image_base64));
}

/**
 * `resultJson.imageSeries.ndvi[]/.ndmi[]` (Fase 2, solo presente si includeImageSeries=true) —
 * alcanza con que exista al menos una imagen `available=true` en cualquiera de las dos series.
 */
function extractHasImageSeries(resultJson: WorkerResultJson): boolean {
  const series = (resultJson as any)?.imageSeries;

  if (!series || typeof series !== 'object') {
    return false;
  }

  const campaigns: any[] = [...(Array.isArray(series.ndvi) ? series.ndvi : []), ...(Array.isArray(series.ndmi) ? series.ndmi : [])];

  return campaigns.some(
    (campaign) => Array.isArray(campaign?.images) && campaign.images.some((image: any) => image?.available === true),
  );
}

/**
 * Fase 5: extrae del resultJson YA GENERADO por el análisis semanal (mismo pipeline manual de
 * siempre) las métricas comparables semana a semana — nunca calcula nada nuevo, nunca cambia
 * resultJson. `resultJson` puede venir `null` (análisis viejo o corrupto): en ese caso todo queda
 * en su valor "sin datos", nunca inventado.
 */
export function extractSnapshotMetrics(resultJson: WorkerResultJson | null | undefined): ExtractedSnapshotMetrics {
  if (!resultJson) {
    return { ...EMPTY_METRICS };
  }

  const dominantZone = extractDominantZone(resultJson);

  return {
    analyzedAreaHa: extractAnalyzedAreaHa(resultJson),
    lotCount: extractLotCount(resultJson),
    dominantZone: dominantZone?.name ?? null,
    dominantZonePercentage: dominantZone ? round(dominantZone.percent, 2) : null,
    ndviMean: extractIndexMean(resultJson, 'NDVI_mean'),
    ndmiMean: extractIndexMean(resultJson, 'NDMI_mean'),
    hasRgbImage: extractHasRgbImage(resultJson),
    hasNdviImage: extractHasIndexImage(resultJson, 'NDVI'),
    hasNdmiImage: extractHasIndexImage(resultJson, 'NDMI'),
    hasImageSeries: extractHasImageSeries(resultJson),
  };
}

export interface DataQualityResult {
  status: WeeklySnapshotDataQuality;
  hasEnoughData: boolean;
  limitations: string | null;
}

/**
 * Reglas de producto (Fase 5):
 * - sufficient: hay alguna imagen (RGB/NDVI/NDMI/serie) O métricas NDVI/NDMI comparables.
 * - partial: no hay lo anterior, pero sí hubo clasificación real (zona dominante + superficie
 *   analizada > 0) — el score/categoría existen pero sin evidencia visual/temporal para comparar.
 * - insufficient: ni imágenes/métricas comparables ni evidencia de clasificación real.
 * Una semana insufficient se guarda igual — no bloquea el snapshot, es información real.
 */
export function classifyDataQuality(
  metrics: Pick<
    ExtractedSnapshotMetrics,
    'hasRgbImage' | 'hasNdviImage' | 'hasNdmiImage' | 'hasImageSeries' | 'ndviMean' | 'ndmiMean' | 'dominantZone' | 'analyzedAreaHa'
  >,
): DataQualityResult {
  const hasAnyImage = metrics.hasRgbImage || metrics.hasNdviImage || metrics.hasNdmiImage || metrics.hasImageSeries;
  const hasComparableMetrics = metrics.ndviMean !== null || metrics.ndmiMean !== null;
  const hasClassification = Boolean(metrics.dominantZone) && (metrics.analyzedAreaHa ?? 0) > 0;

  const missingImages: string[] = [];
  if (!metrics.hasRgbImage) missingImages.push('RGB');
  if (!metrics.hasNdviImage) missingImages.push('NDVI');
  if (!metrics.hasNdmiImage) missingImages.push('NDMI');

  const limitations = !missingImages.length
    ? null
    : missingImages.length === 3
      ? 'Esta semana no hubo imágenes satelitales válidas (RGB, NDVI ni NDMI).'
      : `Esta semana no hubo imagen ${missingImages.join('/')} válida.`;

  if (hasAnyImage || hasComparableMetrics) {
    return { status: 'sufficient', hasEnoughData: true, limitations };
  }

  if (hasClassification) {
    return { status: 'partial', hasEnoughData: true, limitations };
  }

  // insufficient exige hasAnyImage=false, lo que ya fuerza rgb/ndvi/ndmi=false — `limitations`
  // nunca es null en esta rama (siempre hay algo que reportar), pero se refuerza el motivo: acá
  // ni siquiera hubo clasificación real (zona/superficie), no solo imágenes.
  const insufficientReason = 'No hubo datos satelitales suficientes esta semana para un reporte comparativo.';

  return {
    status: 'insufficient',
    hasEnoughData: false,
    limitations: limitations ? `${limitations} ${insufficientReason}` : insufficientReason,
  };
}
