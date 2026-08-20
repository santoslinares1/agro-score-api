// Antes vivía en lots/lots.service.ts (borrado en CLEANUP-2 junto con el
// resto del módulo legacy `lots`); PythonWorkerService.runAnalysis todavía
// usa esta forma, así que el tipo queda acá.
export type PipelineInput = {
  lotId: string;
  name: string;
  location: string;
  geojson: any;
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  areaHa: number;
};

export type ZoneArea = {
  zone: number;
  name: string;
  hectares: number;
  percent: number;
  pixels: number;
};

export type LotZoneResult = {
  lot: string;
  lot_id?: string | null;
  area_ha: number;
  valid_pixels: number;
  zones: ZoneArea[];
  campaigns_used: number;
  png_base64?: string | null;
  warnings: string[];
};

export type ZoneClassificationMeta = {
  scope: string;
  method: string;
  indices: string[];
  campaignsUsed: number[];
};

/**
 * Fase 2 mínima: una imagen mensual (o su ausencia informada) dentro de resultJson.imageSeries.
 * Mismos nombres de campo que WorkerResultJson (no se agrega ninguna interfaz nueva acá arriba
 * como IndexImageAsset) que mapAssets.indexImages (image_base64, vmin, vmax, palette) — ver
 * agro-score-worker/app/pipeline/response_mapper.py.
 */
export type MonthlyImageAsset = {
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
  images: MonthlyImageAsset[];
};

export type ImageSeries = {
  ndvi: CampaignImageSeries[];
  ndmi: CampaignImageSeries[];
};

export type WorkerResultJson = {
  mode: 'fake' | 'python-worker' | 'python-worker-v2' | 'error';
  message: string;

  input?: PipelineInput;

  fieldName?: string;
  indices?: string[];
  timeseries?: unknown[];
  zones?: LotZoneResult[];
  totalsByZone?: ZoneArea[];

  classificationScope?: string | null;
  zoneClassification?: ZoneClassificationMeta | null;

  /** Fase 2 mínima: solo presente si el análisis se pidió con includeImageSeries=true. */
  imageSeries?: ImageSeries;

  raw?: Record<string, unknown>;

  report?: {
    htmlPath?: string;
    pdfPath?: string;
    [key: string]: unknown;
  };

  error?: string;

  [key: string]: unknown;
};

export type WorkerAnalysisResult = {
  globalScore: number;
  category: string;
  confidenceScore: number;
  productivityScore: number;
  stabilityScore: number;
  soilScore: number;
  climateScore: number;
  ndviAverageMax: number;
  ndviVariability: 'Baja' | 'Media' | 'Alta';
  zonesDetected: number;
  resultJson: WorkerResultJson;
};
