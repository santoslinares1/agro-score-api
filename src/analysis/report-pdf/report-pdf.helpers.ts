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

export function getFieldLots(
  resultJson: any,
): Array<{
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
export function getIndexScale(item: IndexImage | null | undefined): IndexScale | null {
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
    .map((lot) => ({ name: lot.name || 'Lote sin nombre', areaHa: lot.areaHa as number }));
}

export function getLotAreaTotalHa(rows: LotAreaRow[]): number {
  return rows.reduce((acc, row) => acc + row.areaHa, 0);
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
const CHART_PADDING = { top: 34, right: 20, bottom: 30, left: 46 };

/**
 * PDF-2: gráfico de líneas NDVI/NDMI en SVG puro (sin canvas, sin screenshot, sin librería de
 * gráficos) a partir de los mismos promedios por campaña que ya arma getCampaignRows — no
 * agrega ni inventa puntos, solo dibuja los que ya existen. Devuelve null si no hay ninguna
 * campaña (el caller decide qué mostrar en ese caso).
 */
export function buildNdviNdmiChartSvg(campaigns: CampaignRow[]): string | null {
  if (!campaigns.length) {
    return null;
  }

  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const allValues = campaigns.flatMap((c) => [c.ndviMean, c.ndmiMean]);
  let yMin = Math.min(...allValues);
  let yMax = Math.max(...allValues);

  if (yMin === yMax) {
    yMin -= 0.1;
    yMax += 0.1;
  }

  const valuePad = (yMax - yMin) * 0.15;
  yMin -= valuePad;
  yMax += valuePad;

  const scaleX = (index: number): number =>
    campaigns.length === 1
      ? CHART_PADDING.left + innerWidth / 2
      : CHART_PADDING.left + (index / (campaigns.length - 1)) * innerWidth;

  const scaleY = (value: number): number =>
    CHART_PADDING.top +
    innerHeight -
    ((value - yMin) / (yMax - yMin)) * innerHeight;

  const ndviPoints = campaigns.map((c, i) => ({
    x: scaleX(i),
    y: scaleY(c.ndviMean),
  }));
  const ndmiPoints = campaigns.map((c, i) => ({
    x: scaleX(i),
    y: scaleY(c.ndmiMean),
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

  const yTickValues = [yMax, (yMax + yMin) / 2, yMin];
  const yLabels = yTickValues
    .map((value) => {
      const y = scaleY(value);
      return `<text x="${CHART_PADDING.left - 8}" y="${(y + 3).toFixed(1)}" font-size="8" fill="#94a3b8" text-anchor="end">${value.toFixed(2)}</text>`;
    })
    .join('');

  const zeroLine =
    yMin < 0 && yMax > 0
      ? `<line x1="${CHART_PADDING.left}" y1="${scaleY(0).toFixed(1)}" x2="${CHART_WIDTH - CHART_PADDING.right}" y2="${scaleY(0).toFixed(1)}" stroke="#cbd5e1" stroke-width="0.75" stroke-dasharray="3,3" />`
      : '';

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
    `<line x1="${CHART_PADDING.left}" y1="${(CHART_HEIGHT - CHART_PADDING.bottom).toFixed(1)}" x2="${CHART_WIDTH - CHART_PADDING.right}" y2="${(CHART_HEIGHT - CHART_PADDING.bottom).toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />`,
    zeroLine,
    yLabels,
    xLabels,
    ndviLine,
    circles(ndviPoints, '#16a34a'),
    ndmiLine,
    circles(ndmiPoints, '#2563eb'),
    `<circle cx="${CHART_PADDING.left}" cy="14" r="4" fill="#16a34a" />`,
    `<text x="${CHART_PADDING.left + 8}" y="17" font-size="9" fill="#334155">NDVI</text>`,
    `<circle cx="${CHART_PADDING.left + 60}" cy="14" r="4" fill="#2563eb" />`,
    `<text x="${CHART_PADDING.left + 68}" y="17" font-size="9" fill="#334155">NDMI</text>`,
    `</svg>`,
  ].join('');
}
