import { FieldLot } from '../../fields/entities/field-lot.entity';

export type ZoneRow = {
  zone: number;
  name: string;
  hectares: number;
  percent: number;
};

export type LotZoneDetail = {
  lot: string;
  lotId: string | null;
  areaHa: number;
  zones: ZoneRow[];
  pngBase64: string | null;
};

export type LotOverviewRow = {
  name: string;
  referenceAreaHa: number | null;
  includedLabel: string;
  notes: string;
};

export type CampaignRow = {
  campaign: string;
  ndviMean: number;
  ndmiMean: number;
};

/** Una observación satelital real (fecha real de resultJson.timeseries, sin promediar). */
export type NdviTimeseriesPoint = {
  date: string;
  ndviMean: number;
  ndviStdDev: number | null;
};

export type LotNdviCampaignSeries = {
  lot: string;
  lotId: string | null;
  points: NdviTimeseriesPoint[];
};

export type NdviCampaignGroup = {
  campaign: string;
  lots: LotNdviCampaignSeries[];
};

export type IndexImage = {
  index: string;
  available?: boolean;
  image_base64?: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  vmin?: number;
  vmax?: number;
  palette?: string[];
};

export type IndexScale = {
  vmin: number;
  vmax: number;
  palette: string[];
};

export type LotAreaRow = {
  name: string;
  areaHa: number;
};

/**
 * Fase 2 mínima: una imagen mensual (o su ausencia informada) dentro de
 * resultJson.imageSeries.ndvi/ndmi. Mismos nombres de campo que IndexImage (image_base64,
 * vmin, vmax, palette) — ver agro-score-worker/app/pipeline/response_mapper.py.
 */
export type MonthlyImage = {
  date?: string;
  label?: string;
  available: boolean;
  image_base64?: string;
  cloudiness?: number;
  vmin?: number;
  vmax?: number;
  palette?: string[];
  notes?: string[];
};

export type CampaignImageSeries = {
  campaign: string;
  images: MonthlyImage[];
};

/**
 * Mismo criterio de color que analysis-report.component.ts / analysis-result.component.ts
 * (Fase 8E.1): se mapea por nombre real de zona, no por tier genérico, para no repetir el bug
 * donde "Alta" y "Muy Alta" terminaban con el mismo verde. Rojo queda reservado para
 * error/sin datos, nunca para "Baja".
 */
export function zoneColorHex(name: string): string {
  const normalized = (name || '').trim().toLowerCase();

  if (normalized === 'muy alta') {
    return '#004529';
  }

  if (normalized === 'alta') {
    return '#1a9850';
  }

  if (normalized === 'baja' || normalized === 'muy baja') {
    return '#fee08b';
  }

  if (
    normalized === 'sin datos' ||
    normalized === 'inválido' ||
    normalized === 'invalido'
  ) {
    return '#d73027';
  }

  return '#475569';
}

export function zoneTextColorHex(name: string): string {
  const normalized = (name || '').trim().toLowerCase();
  return normalized === 'baja' || normalized === 'muy baja'
    ? '#78350f'
    : '#ffffff';
}

function zoneNameFromNumber(zone: number): string {
  if (zone === 2) {
    return 'Muy Alta';
  }

  if (zone === 1) {
    return 'Alta';
  }

  return 'Baja';
}

function buildZoneRow(zone: any): ZoneRow {
  const name = zone?.name || zoneNameFromNumber(Number(zone?.zone));

  return {
    zone: Number(zone?.zone ?? 0),
    name,
    hectares: Number(zone?.hectares ?? 0),
    percent: Number(zone?.percent ?? 0),
  };
}

export function getFieldLots(resultJson: any): Array<{
  id: string;
  name: string;
  areaHa?: number;
  includeInProductivityClassification?: boolean;
}> {
  return Array.isArray(resultJson?.fieldLots) ? resultJson.fieldLots : [];
}

function resolveLotLabel(
  resultJson: any,
  lotId: string | null | undefined,
  fallbackName: string | undefined,
): string {
  if (lotId) {
    const match = getFieldLots(resultJson).find((fl) => fl.id === lotId);

    if (match?.name) {
      return match.name;
    }
  }

  return fallbackName || 'Lote sin nombre';
}

export function getFieldZoneTotals(resultJson: any): ZoneRow[] {
  const totals = Array.isArray(resultJson?.totalsByZone)
    ? resultJson.totalsByZone
    : [];
  return totals
    .map(buildZoneRow)
    .sort((a: ZoneRow, b: ZoneRow) => a.zone - b.zone);
}

export function getLotZoneDetails(resultJson: any): LotZoneDetail[] {
  const lots = Array.isArray(resultJson?.zones) ? resultJson.zones : [];

  return lots
    .filter((item: any) => Array.isArray(item?.zones))
    .map((lot: any) => ({
      lot: resolveLotLabel(resultJson, lot.lot_id, lot.lot),
      lotId: lot.lot_id ?? null,
      areaHa: Number(lot.area_ha ?? 0),
      zones: lot.zones.map(buildZoneRow),
      pngBase64: lot.png_base64 || null,
    }));
}

export function getAnalyzedAreaHa(resultJson: any): number {
  return getLotZoneDetails(resultJson).reduce(
    (acc, lot) => acc + Number(lot.areaHa || 0),
    0,
  );
}

export function getLotsCount(resultJson: any): number {
  const details = getLotZoneDetails(resultJson);
  return details.length || getFieldLots(resultJson).length;
}

export function getTopZoneByHectares(zones: ZoneRow[]): ZoneRow | null {
  if (!zones.length) {
    return null;
  }

  return zones.reduce(
    (best, zone) => (zone.hectares > best.hectares ? zone : best),
    zones[0],
  );
}

/**
 * Tabla de lotes del PDF (mismo criterio que lotsOverview en
 * analysis-report.component.ts): superficie de referencia cargada a mano en el campo, no la
 * superficie de pixeles válidos que calculó el worker. Las notas se leen del Field actual (no
 * del resultJson histórico, que no las persiste).
 */
export function getLotsOverview(
  resultJson: any,
  currentLots: FieldLot[],
): LotOverviewRow[] {
  const fieldLotsRaw = getFieldLots(resultJson);
  const notesByLotId = new Map(
    currentLots.map((lot) => [lot.id, lot.notes || '']),
  );

  if (fieldLotsRaw.length) {
    return fieldLotsRaw.map((fl) => ({
      name: fl.name || 'Lote sin nombre',
      referenceAreaHa: typeof fl.areaHa === 'number' ? fl.areaHa : null,
      includedLabel: includedLabel(fl.includeInProductivityClassification),
      notes: notesByLotId.get(fl.id) || '',
    }));
  }

  return getLotZoneDetails(resultJson).map((lot) => ({
    name: lot.lot,
    referenceAreaHa: null,
    includedLabel: 'No disponible',
    notes: (lot.lotId && notesByLotId.get(lot.lotId)) || '',
  }));
}

function includedLabel(value: unknown): string {
  if (value === true) {
    return 'Sí';
  }

  if (value === false) {
    return 'No';
  }

  return 'No disponible';
}

export function getClassificationScopeNote(resultJson: any): string {
  return resultJson?.classificationScope === 'field-global'
    ? 'Las zonas fueron clasificadas con criterios globales del campo, por lo que Baja, Alta y Muy Alta son comparables entre lotes.'
    : 'Zonas calculadas por lote (sin información de alcance global disponible en este análisis).';
}

export function getClassificationScopeLabel(resultJson: any): string {
  return resultJson?.classificationScope === 'field-global'
    ? 'Global del campo (comparable entre lotes)'
    : 'Por lote (sin alcance global disponible)';
}

export function isRgbAvailable(resultJson: any): boolean {
  return (
    resultJson?.mapAssets?.rgb?.available === true &&
    Boolean(resultJson?.mapAssets?.rgb?.image_base64)
  );
}

export function getRgbImage(
  resultJson: any,
): { base64: string; dateRangeLabel: string } | null {
  if (!isRgbAvailable(resultJson)) {
    return null;
  }

  const rgb = resultJson.mapAssets.rgb;

  return {
    base64: rgb.image_base64,
    dateRangeLabel:
      rgb.dateRangeStart && rgb.dateRangeEnd
        ? `${rgb.dateRangeStart} — ${rgb.dateRangeEnd}`
        : 'No disponible',
  };
}

/**
 * Análisis previos al rename NDWI→NDMI (worker) todavía tienen "NDWI" persistido en
 * resultJson — se filtra para no exponer ese nombre viejo en el PDF.
 */
export function getIndexImages(resultJson: any): IndexImage[] {
  const items = Array.isArray(resultJson?.mapAssets?.indexImages)
    ? resultJson.mapAssets.indexImages
    : [];
  return items.filter(
    (item: any) =>
      item?.index !== 'NDWI' && item?.available && item?.image_base64,
  );
}

export function getPrimaryIndexImages(resultJson: any): IndexImage[] {
  return getIndexImages(resultJson).filter(
    (item) => item.index === 'NDVI' || item.index === 'NDMI',
  );
}

export function getAdditionalIndexImages(resultJson: any): IndexImage[] {
  return getIndexImages(resultJson).filter(
    (item) => item.index !== 'NDVI' && item.index !== 'NDMI',
  );
}

export function indexImageDateRangeLabel(item: IndexImage): string {
  return item.dateRangeStart && item.dateRangeEnd
    ? `${item.dateRangeStart} — ${item.dateRangeEnd}`
    : 'No disponible';
}

/**
 * REPORT-IMG-1: escala de color real (vmin/vmax/paleta) con la que el worker generó la imagen —
 * ver `INDEX_IMAGE_CONFIG` en agro-score-worker/app/pipeline/map_assets.py. `null` si el análisis
 * no trae esos datos (análisis viejos); nunca inventa un rango.
 */
export function getIndexScale(
  item: { vmin?: number; vmax?: number; palette?: string[] } | null | undefined,
): IndexScale | null {
  if (
    typeof item?.vmin !== 'number' ||
    typeof item?.vmax !== 'number' ||
    !Array.isArray(item?.palette) ||
    !item.palette.length
  ) {
    return null;
  }

  return { vmin: item.vmin, vmax: item.vmax, palette: item.palette };
}

/**
 * REPORT-IMG-1: superficie de referencia por lote (la cargada en el campo, no la de píxeles
 * válidos del worker — mismo criterio que getLotsOverview), para la tabla junto al RGB.
 */
export function getLotAreaRows(resultJson: any): LotAreaRow[] {
  return getFieldLots(resultJson)
    .filter((lot) => typeof lot.areaHa === 'number')
    .map((lot) => ({
      name: lot.name || 'Lote sin nombre',
      areaHa: lot.areaHa as number,
    }));
}

export function getLotAreaTotalHa(rows: LotAreaRow[]): number {
  return rows.reduce((acc, row) => acc + row.areaHa, 0);
}

/**
 * Fase 2 mínima: campañas con al menos una imagen (disponible o no) para el índice pedido.
 * `null`/ausente en resultJson.imageSeries (análisis viejos, o includeImageSeries=false) da
 * lista vacía — nunca se inventa una campaña.
 */
export function getImageSeries(
  resultJson: any,
  index: 'ndvi' | 'ndmi',
): CampaignImageSeries[] {
  const series = resultJson?.imageSeries?.[index];
  return Array.isArray(series)
    ? series.filter((s: any) => Array.isArray(s?.images) && s.images.length > 0)
    : [];
}

/** Escala real (vmin/vmax/paleta) de la serie — todas las imágenes de un mismo índice la comparten. */
export function getImageSeriesScale(
  series: CampaignImageSeries[],
): IndexScale | null {
  return getIndexScale(series[0]?.images?.[0]);
}

function yearFromDate(date: string | undefined): string | null {
  if (!date) {
    return null;
  }

  const year = new Date(date).getFullYear();
  return Number.isNaN(year) ? null : String(year);
}

function avgMetric(rows: any[], key: string): number {
  const values = rows
    .map((row) => Number(row?.values?.[key]))
    .filter((value) => !Number.isNaN(value));

  if (!values.length) {
    return 0;
  }

  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function buildCampaignRowsFromRows(rows: any[]): CampaignRow[] {
  const grouped = new Map<string, any[]>();

  for (const row of rows) {
    const year = yearFromDate(row?.date);

    if (!year) {
      continue;
    }

    const values = row?.values || {};
    const count = Number(values.NDVI_count ?? 0);

    if (!count || Number.isNaN(Number(values.NDVI_mean))) {
      continue;
    }

    if (!grouped.has(year)) {
      grouped.set(year, []);
    }

    grouped.get(year)?.push(row);
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, yearRows]) => ({
      campaign: year,
      ndviMean: avgMetric(yearRows, 'NDVI_mean'),
      ndmiMean: avgMetric(yearRows, 'NDMI_mean'),
    }));
}

/**
 * Evolución temporal resumida por campaña (mismo agrupamiento que campaignRows en
 * analysis-result.component.ts): se promedia NDVI/NDMI por año en vez de graficar cada fecha
 * de imagen individual, para mantener el PDF en una tabla acotada en vez de un gráfico.
 */
export function getCampaignRows(resultJson: any): CampaignRow[] {
  const timeseries = Array.isArray(resultJson?.timeseries)
    ? resultJson.timeseries
    : [];
  const rows: any[] = timeseries.flatMap((serie: any) => serie?.rows || []);
  return buildCampaignRowsFromRows(rows);
}

export type LotCampaignRows = {
  lot: string;
  lotId: string | null;
  rows: CampaignRow[];
};

/**
 * REPORT-IMG-1: evolución temporal agrupada por lote (lot/lot_id — ver LotTimeSeriesResult en
 * agro-score-worker/app/pipeline/timeseries.py), cada elemento de resultJson.timeseries ya es la
 * serie de un lote. Con 0 o 1 lote no aporta nada sobre el gráfico combinado, así que queda vacío
 * y el caller decide no mostrar la sección.
 */
export function getCampaignRowsByLot(resultJson: any): LotCampaignRows[] {
  const timeseries = Array.isArray(resultJson?.timeseries)
    ? resultJson.timeseries
    : [];

  if (timeseries.length < 2) {
    return [];
  }

  return timeseries
    .map((serie: any) => ({
      lot: resolveLotLabel(resultJson, serie?.lot_id, serie?.lot),
      lotId: serie?.lot_id ?? null,
      rows: buildCampaignRowsFromRows(serie?.rows || []),
    }))
    .filter((group: LotCampaignRows) => group.rows.length > 0);
}

/**
 * Campaña agrícola real a partir de la fecha de una imagen puntual (no del calendario), con el
 * mismo corte de octubre y el mismo formato 'YYYY/YY' que ya usan zones.py/sentinel.py en el
 * worker y _campaign_label en map_assets.py (que el propio worker documenta como "mismo formato
 * que usa el reporte histórico"). Oct-Dic pertenecen a la campaña que arranca ese año calendario;
 * Ene-Sep pertenecen a la campaña que arrancó el año calendario anterior.
 */
export function campaignLabelFromDate(date: string | undefined): string | null {
  if (!date) {
    return null;
  }

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const month = parsed.getUTCMonth() + 1;
  const year = parsed.getUTCFullYear();
  const startYear = month >= 10 ? year : year - 1;

  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}

/**
 * REPORT-NDVI-EVOL-1: evolución NDVI real (fecha por fecha, sin promediar) agrupada primero por
 * campaña agrícola y luego por lote — mismo patrón que el reporte histórico de referencia
 * (Horacio Heinz): una página por campaña, un gráfico de línea NDVI por lote dentro de cada
 * campaña. Solo usa resultJson.timeseries; nunca inventa fechas ni valores. Cada campaña incluye
 * todos los lotes conocidos (con lista de puntos vacía si ese lote no tuvo observaciones válidas
 * esa campaña), para que el caller pueda mostrar un aviso honesto en vez de hacer desaparecer el
 * lote silenciosamente.
 */
export function getNdviEvolutionByCampaign(
  resultJson: any,
): NdviCampaignGroup[] {
  const timeseries = Array.isArray(resultJson?.timeseries)
    ? resultJson.timeseries
    : [];

  if (!timeseries.length) {
    return [];
  }

  const lots = timeseries.map((serie: any) => ({
    lot: resolveLotLabel(resultJson, serie?.lot_id, serie?.lot),
    lotId: (serie?.lot_id ?? null) as string | null,
    rows: Array.isArray(serie?.rows) ? serie.rows : [],
  }));

  const campaignSet = new Set<string>();
  const pointsByLotCampaign = new Map<
    string,
    Map<string, NdviTimeseriesPoint[]>
  >();

  for (const lot of lots) {
    const lotKey = lot.lotId ?? lot.lot;
    const byCampaign = new Map<string, NdviTimeseriesPoint[]>();

    for (const row of lot.rows) {
      const values = row?.values || {};
      const count = Number(values.NDVI_count ?? 0);
      const mean = values.NDVI_mean;

      if (
        !count ||
        typeof mean !== 'number' ||
        Number.isNaN(mean) ||
        !row?.date
      ) {
        continue;
      }

      const campaign = campaignLabelFromDate(row.date);

      if (!campaign) {
        continue;
      }

      const stdDevRaw = values.NDVI_stdDev;
      const ndviStdDev =
        typeof stdDevRaw === 'number' && !Number.isNaN(stdDevRaw)
          ? stdDevRaw
          : null;

      campaignSet.add(campaign);

      if (!byCampaign.has(campaign)) {
        byCampaign.set(campaign, []);
      }

      byCampaign
        .get(campaign)
        ?.push({ date: row.date, ndviMean: mean, ndviStdDev });
    }

    for (const points of byCampaign.values()) {
      points.sort((a, b) => a.date.localeCompare(b.date));
    }

    pointsByLotCampaign.set(lotKey, byCampaign);
  }

  const campaigns = Array.from(campaignSet).sort((a, b) => a.localeCompare(b));

  return campaigns.map((campaign) => ({
    campaign,
    lots: lots.map((lot) => ({
      lot: lot.lot,
      lotId: lot.lotId,
      points:
        pointsByLotCampaign.get(lot.lotId ?? lot.lot)?.get(campaign) ?? [],
    })),
  }));
}

export function getBestLotByNdvi(
  resultJson: any,
): { lot: string; avgNdvi: number } | null {
  const timeseries = Array.isArray(resultJson?.timeseries)
    ? resultJson.timeseries
    : [];
  let best: { lot: string; avgNdvi: number } | null = null;

  for (const serie of timeseries) {
    const rows = Array.isArray(serie?.rows) ? serie.rows : [];
    const values = rows
      .map((row: any) => Number(row?.values?.NDVI_mean))
      .filter((value: number) => !Number.isNaN(value));

    if (!values.length) {
      continue;
    }

    const avg =
      values.reduce((acc: number, value: number) => acc + value, 0) /
      values.length;

    if (!best || avg > best.avgNdvi) {
      best = {
        lot: resolveLotLabel(resultJson, serie.lot_id, serie.lot),
        avgNdvi: avg,
      };
    }
  }

  return best;
}

export function isSoilClimateAvailable(resultJson: any): boolean {
  if (resultJson?.soilClimateAvailable === false) {
    return false;
  }

  return Boolean(
    resultJson?.soilClimate?.soil || resultJson?.soilClimate?.climate,
  );
}

export function scoreInterpretation(score: number): string {
  if (score >= 70) {
    return 'El campo muestra una respuesta satelital favorable en los indicadores evaluados.';
  }

  if (score >= 40) {
    return 'El diagnóstico muestra variabilidad interna relevante para revisar por zonas.';
  }

  return 'El diagnóstico identifica sectores con menor desempeño relativo dentro del campo.';
}

export function fieldLocationLabel(field: {
  location?: string;
  province?: string;
  country?: string;
}): string {
  const parts = [field.location, field.province, field.country].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join(', ') : 'No disponible';
}

/**
 * Para strings "YYYY-MM-DD" (startDate/endDate, columnas `date` sin hora) parsea a mano en vez
 * de `new Date(date).getDate()`: esa conversión pasa por la zona horaria local y corre el día
 * mostrado en husos horarios negativos (mismo bug ya documentado y evitado en
 * analysis-report.component.ts). Para timestamps reales (createdAt) sí tiene sentido convertir
 * a hora local, porque ahí el string representa un instante, no un día calendario puro.
 */
export function formatDateDMY(date: string | Date | undefined | null): string {
  if (!date) {
    return 'No disponible';
  }

  if (typeof date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);

    if (match) {
      return `${match[3]}/${match[2]}/${match[1]}`;
    }
  }

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return 'No disponible';
  }

  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${parsed.getFullYear()}`;
}

export function slugify(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'campo';
}

export function buildPdfFilename(
  fieldName: string,
  createdAt: string | Date,
): string {
  const dateIso = new Date(createdAt).toISOString().slice(0, 10);
  return `agroscore-reporte-${slugify(fieldName)}-${dateIso}.pdf`;
}

/** PDF-2: formatea hectáreas de forma consistente en todo el PDF (o "No disponible" si falta). */
export function formatHa(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'No disponible';
  }

  return `${value.toFixed(2)} ha`;
}

/** PDF-2: coerciona un valor potencialmente ausente a texto, sin inventar contenido. */
export function safeText(value: unknown, fallback = 'No disponible'): string {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  return String(value);
}

const CHART_WIDTH = 500;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 34, right: 34, bottom: 30, left: 46 };

// NDVI-1: NDVI se grafica siempre en su rango físico fijo 0–1 (nunca auto-escalado).
const NDVI_AXIS_MIN = 0;
const NDVI_AXIS_MAX = 1;
// NDVI-1: NDMI tiene un rango físico propio y mucho más angosto que NDVI — graficarlo en el
// mismo eje 0–1 de NDVI lo deja visualmente "planchado" contra el piso del gráfico. Usa su
// propio eje fijo (derecha), calibrado al rango real que suele tomar NDMI en este reporte.
const NDMI_AXIS_MIN = -0.3;
const NDMI_AXIS_MAX = 0.6;

function clampToAxis(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * PDF-2 / NDVI-1: gráfico de líneas NDVI/NDMI en SVG puro (sin canvas, sin screenshot, sin
 * librería de gráficos) a partir de los mismos promedios por campaña que ya arma
 * getCampaignRows — no agrega ni inventa puntos, solo dibuja los que ya existen. Devuelve null
 * si no hay ninguna campaña (el caller decide qué mostrar en ese caso).
 *
 * NDVI y NDMI tienen escalas físicas distintas (NDVI 0–1, NDMI típicamente entre -0.3 y 0.6), así
 * que este gráfico combinado usa dos ejes Y independientes y fijos en vez de uno solo
 * auto-escalado: NDVI contra el eje izquierdo (verde, 0–1, con líneas de grilla), NDMI contra el
 * eje derecho (azul, -0.3–0.6, solo con marcas de referencia para no saturar el gráfico con dos
 * grillas cruzadas). Ninguno de los dos ejes se recalcula según los datos — son fijos siempre,
 * para que el mismo valor de NDVI o NDMI se vea siempre en la misma altura entre distintos PDFs.
 */
export function buildNdviNdmiChartSvg(campaigns: CampaignRow[]): string | null {
  if (!campaigns.length) {
    return null;
  }

  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const scaleX = (index: number): number =>
    campaigns.length === 1
      ? CHART_PADDING.left + innerWidth / 2
      : CHART_PADDING.left + (index / (campaigns.length - 1)) * innerWidth;

  const scaleYNdvi = (value: number): number =>
    CHART_PADDING.top +
    innerHeight -
    ((clampToAxis(value, NDVI_AXIS_MIN, NDVI_AXIS_MAX) - NDVI_AXIS_MIN) /
      (NDVI_AXIS_MAX - NDVI_AXIS_MIN)) *
      innerHeight;

  const scaleYNdmi = (value: number): number =>
    CHART_PADDING.top +
    innerHeight -
    ((clampToAxis(value, NDMI_AXIS_MIN, NDMI_AXIS_MAX) - NDMI_AXIS_MIN) /
      (NDMI_AXIS_MAX - NDMI_AXIS_MIN)) *
      innerHeight;

  const ndviPoints = campaigns.map((c, i) => ({
    x: scaleX(i),
    y: scaleYNdvi(c.ndviMean),
  }));
  const ndmiPoints = campaigns.map((c, i) => ({
    x: scaleX(i),
    y: scaleYNdmi(c.ndmiMean),
  }));

  const linePath = (points: Array<{ x: number; y: number }>): string =>
    points
      .map(
        (p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`,
      )
      .join(' ');

  const circles = (
    points: Array<{ x: number; y: number }>,
    color: string,
  ): string =>
    points
      .map(
        (p) =>
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}" />`,
      )
      .join('');

  const xLabels = campaigns
    .map((c, i) => {
      const x = scaleX(i);
      return `<text x="${x.toFixed(1)}" y="${CHART_HEIGHT - 10}" font-size="9" fill="#64748b" text-anchor="middle">${c.campaign}</text>`;
    })
    .join('');

  // Eje izquierdo (NDVI, fijo 0-1): con grilla horizontal completa, como el resto del reporte.
  const ndviTickValues = [
    NDVI_AXIS_MIN,
    (NDVI_AXIS_MIN + NDVI_AXIS_MAX) / 2,
    NDVI_AXIS_MAX,
  ];
  const ndviAxis = ndviTickValues
    .map((value) => {
      const y = scaleYNdvi(value);
      return (
        `<line x1="${CHART_PADDING.left}" y1="${y.toFixed(1)}" x2="${CHART_WIDTH - CHART_PADDING.right}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="0.75" />` +
        `<text x="${CHART_PADDING.left - 8}" y="${(y + 3).toFixed(1)}" font-size="8" fill="#16a34a" text-anchor="end">${value.toFixed(2)}</text>`
      );
    })
    .join('');

  // Eje derecho (NDMI, fijo -0.3-0.6): solo marcas + etiqueta, sin grilla propia — dos grillas
  // completas cruzadas (una por eje, con dominios distintos) se pisarían entre sí sin aportar
  // nada, ya que NDVI y NDMI no comparten alturas comparables.
  const ndmiTickValues = [NDMI_AXIS_MIN, 0, NDMI_AXIS_MAX];
  const ndmiAxis = ndmiTickValues
    .map((value) => {
      const y = scaleYNdmi(value);
      const xTick = CHART_WIDTH - CHART_PADDING.right;
      return (
        `<line x1="${xTick}" y1="${y.toFixed(1)}" x2="${(xTick + 4).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2563eb" stroke-width="0.75" />` +
        `<text x="${(xTick + 7).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="8" fill="#2563eb" text-anchor="start">${value.toFixed(2)}</text>`
      );
    })
    .join('');

  const ndviLine =
    ndviPoints.length > 1
      ? `<path d="${linePath(ndviPoints)}" fill="none" stroke="#16a34a" stroke-width="2" />`
      : '';
  const ndmiLine =
    ndmiPoints.length > 1
      ? `<path d="${linePath(ndmiPoints)}" fill="none" stroke="#2563eb" stroke-width="2" />`
      : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">`,
    `<rect x="0" y="0" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#ffffff" />`,
    ndviAxis,
    ndmiAxis,
    xLabels,
    ndviLine,
    circles(ndviPoints, '#16a34a'),
    ndmiLine,
    circles(ndmiPoints, '#2563eb'),
    `<circle cx="${CHART_PADDING.left}" cy="14" r="4" fill="#16a34a" />`,
    `<text x="${CHART_PADDING.left + 8}" y="17" font-size="9" fill="#334155">NDVI (eje izq., 0–1)</text>`,
    `<circle cx="${CHART_PADDING.left + 130}" cy="14" r="4" fill="#2563eb" />`,
    `<text x="${CHART_PADDING.left + 138}" y="17" font-size="9" fill="#334155">NDMI (eje der., -0.3–0.6)</text>`,
    `</svg>`,
  ].join('');
}

const NDVI_EVOL_WIDTH = 480;
const NDVI_EVOL_HEIGHT = 150;
const NDVI_EVOL_PADDING = { top: 10, right: 14, bottom: 20, left: 32 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 'YYYY-MM-DD' -> 'DD/MM', sin pasar por Date (evita corrimientos de huso horario). */
function formatShortDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return month && day ? `${day}/${month}` : isoDate;
}

/**
 * REPORT-NDVI-EVOL-1: curva NDVI real (SVG inline) de un lote dentro de una campaña — eje X por
 * fecha real (no categórico), eje Y fijo 0–1. Nunca agrega ni inventa puntos, solo dibuja los que
 * ya trae resultJson.timeseries. Con menos de 2 puntos no hay curva que trazar, así que devuelve
 * null y el caller decide qué aviso honesto mostrar. La banda ±1σ (NDVI_stdDev) solo se dibuja si
 * TODOS los puntos de la serie tienen desvío válido — una banda parcial sería engañosa. El
 * fill-opacity de SVG no lo soporta el renderer de pdfmake (svg-to-pdfkit embebido), así que la
 * banda usa un verde pastel sólido en vez de transparencia.
 */
export function buildNdviEvolutionChartSvg(
  points: NdviTimeseriesPoint[],
): string | null {
  if (points.length < 2) {
    return null;
  }

  const innerWidth =
    NDVI_EVOL_WIDTH - NDVI_EVOL_PADDING.left - NDVI_EVOL_PADDING.right;
  const innerHeight =
    NDVI_EVOL_HEIGHT - NDVI_EVOL_PADDING.top - NDVI_EVOL_PADDING.bottom;

  const times = points.map((p) => new Date(p.date).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = maxTime - minTime || 1;

  const scaleX = (time: number): number =>
    NDVI_EVOL_PADDING.left + ((time - minTime) / timeSpan) * innerWidth;
  const scaleY = (value: number): number =>
    NDVI_EVOL_PADDING.top + innerHeight - clamp01(value) * innerHeight;

  const coords = points.map((p, i) => ({
    x: scaleX(times[i]),
    y: scaleY(p.ndviMean),
  }));

  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');

  const hasFullBand = points.every((p) => typeof p.ndviStdDev === 'number');
  let bandPath = '';

  if (hasFullBand) {
    const upperCoords = points.map((p, i) => ({
      x: coords[i].x,
      y: scaleY(p.ndviMean + (p.ndviStdDev as number)),
    }));
    const lowerCoords = points.map((p, i) => ({
      x: coords[i].x,
      y: scaleY(p.ndviMean - (p.ndviStdDev as number)),
    }));
    const upperPath = upperCoords
      .map(
        (c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`,
      )
      .join(' ');
    const lowerPath = lowerCoords
      .slice()
      .reverse()
      .map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    bandPath = `<path d="${upperPath} ${lowerPath} Z" fill="#dcfce7" stroke="none" />`;
  }

  const yTicks = [0, 0.5, 1];
  const yGrid = yTicks
    .map((value) => {
      const y = scaleY(value);
      return (
        `<line x1="${NDVI_EVOL_PADDING.left}" y1="${y.toFixed(1)}" x2="${NDVI_EVOL_WIDTH - NDVI_EVOL_PADDING.right}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="0.75" />` +
        `<text x="${NDVI_EVOL_PADDING.left - 5}" y="${(y + 2.5).toFixed(1)}" font-size="7" fill="#94a3b8" text-anchor="end">${value.toFixed(1)}</text>`
      );
    })
    .join('');

  const tickCount = Math.min(5, points.length);
  const tickIndices = Array.from(
    new Set(
      Array.from({ length: tickCount }, (_, i) =>
        Math.round((i * (points.length - 1)) / Math.max(tickCount - 1, 1)),
      ),
    ),
  );
  const xLabels = tickIndices
    .map((idx) => {
      const c = coords[idx];
      return `<text x="${c.x.toFixed(1)}" y="${NDVI_EVOL_HEIGHT - 6}" font-size="7" fill="#64748b" text-anchor="middle">${formatShortDate(points[idx].date)}</text>`;
    })
    .join('');

  const circles = coords
    .map(
      (c) =>
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.25" fill="#16a34a" />`,
    )
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${NDVI_EVOL_WIDTH} ${NDVI_EVOL_HEIGHT}">`,
    `<rect x="0" y="0" width="${NDVI_EVOL_WIDTH}" height="${NDVI_EVOL_HEIGHT}" fill="#ffffff" />`,
    yGrid,
    bandPath,
    `<path d="${linePath}" fill="none" stroke="#16a34a" stroke-width="1.75" />`,
    circles,
    xLabels,
    `</svg>`,
  ].join('');
}
