import { PipelineInput } from '../lots/lots.service';

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
