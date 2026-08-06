import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { PipelineInput, WorkerAnalysisResult } from './types';

type NewWorkerPayload = {
  field_name: string;
  lots: {
    name: string;
    coordinates: number[][];
    lot_id?: string;
  }[];
  campaign_start: string;
  campaign_end: string;
  indices: string[];
  max_cloud_pct: number;
  scale: number;
  zone_campaign_years: number[];
  zone_indices: string[];
  n_zones: number;
  zone_resolution: number;
  include_zone_png: boolean;
  include_map_assets?: boolean;
  map_dimensions?: number;
  include_index_images?: boolean;
  index_image_indices?: string[];
  index_image_dimensions?: number;
};

type FieldWorkerInput = {
  fieldId: string;
  name: string;
  location?: string;
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  indices?: string[];
  zoneIndices?: string[];
  indexImageIndices?: string[];
  includeMapAssets?: boolean;
  includeIndexImages?: boolean;
  maxZoneCampaigns?: number;
  lots: Array<{
    id: string;
    name: string;
    geojson: unknown;
    areaHa: number;
    includeInProductivityClassification: boolean;
  }>;
};

/**
 * NDVI y NDMI son los índices base del producto: siempre viajan al worker,
 * sin importar qué mande el caller. Los avanzados (NDRE/EVI/MSAVI2/BSI) y
 * SWIR (solo asset visual) se agregan arriba de esta base cuando el usuario
 * los activa explícitamente desde la UI.
 */
const BASE_INDICES = ['NDVI', 'NDMI'];

/**
 * Fase PERF-1: por defecto la clasificación de zonas usa como mucho las
 * últimas DEFAULT_MAX_ZONE_CAMPAIGNS campañas, sin importar cuán largo sea
 * el rango startDate-endDate elegido. MAX_MAX_ZONE_CAMPAIGNS evita que un
 * caller pida un número arbitrariamente alto (cada campaña de más multiplica
 * llamadas getThumbURL en el worker: ver zones.py).
 */
const DEFAULT_MAX_ZONE_CAMPAIGNS = 3;
const MIN_MAX_ZONE_CAMPAIGNS = 1;
const MAX_MAX_ZONE_CAMPAIGNS = 6;

@Injectable()
export class PythonWorkerService {
  private readonly logger = new Logger(PythonWorkerService.name);
  private readonly workerUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.workerUrl =
      this.configService.get<string>('PYTHON_WORKER_URL') ||
      'http://localhost:8000';
  }

  /**
   * ADMIN-2: chequeo liviano para GET /admin/system/health — timeout corto
   * (3s) porque este endpoint es de un panel admin, no puede colgarse
   * esperando al worker. No dispara ningún llamado a Earth Engine (el
   * worker's /health no lo hace tampoco, ver agro-score-worker/app/main.py).
   */
  async checkHealth(): Promise<{ status: 'ok' | 'unreachable'; error?: string }> {
    try {
      await firstValueFrom(
        this.httpService.get(`${this.workerUrl}/health`, { timeout: 3000 }),
      );
      return { status: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Worker health check failed: ${message}`);
      return { status: 'unreachable', error: message };
    }
  }

  async runAnalysis(input: PipelineInput): Promise<WorkerAnalysisResult> {
    const workerPayload = this.mapPipelineInputToWorkerPayload(input);
    return this.postToWorker(workerPayload);
  }

  /**
   * Llama a POST /analyze del worker Python. Centraliza el logging/manejo de
   * errores para runAnalysis (lote único) y runFieldAnalysis (campo), que
   * antes duplicaban el mismo try/catch. El contrato público no cambia: ante
   * cualquier falla (timeout, red, 4xx/5xx del worker) se sigue lanzando
   * ServiceUnavailableException con el mismo mensaje.
   */
  private async postToWorker(
    payload: NewWorkerPayload,
  ): Promise<WorkerAnalysisResult> {
    this.logger.log(
      `Worker payload: indices=${JSON.stringify(payload.indices)} ` +
        `zone_indices=${JSON.stringify(payload.zone_indices)} ` +
        `zone_campaign_years=${JSON.stringify(payload.zone_campaign_years)} ` +
        `include_map_assets=${payload.include_map_assets ?? false} ` +
        `include_index_images=${payload.include_index_images ?? false} ` +
        `index_image_indices=${JSON.stringify(payload.index_image_indices)}`,
    );

    try {
      const response = await firstValueFrom(
        this.httpService.post<WorkerAnalysisResult>(
          `${this.workerUrl}/analyze`,
          payload,
          {
            timeout: 600_000,
          },
        ),
      );

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError?.response?.status;
      const isTimeout = axiosError?.code === 'ECONNABORTED';
      const reason = isTimeout
        ? 'timeout'
        : status
          ? `http ${status}`
          : 'network/unreachable';

      this.logger.error(
        `Python worker call failed (${reason}): ${JSON.stringify(
          axiosError?.response?.data ?? axiosError?.message ?? error,
        )}`,
      );

      throw new ServiceUnavailableException(
        'No se pudo conectar con el worker Python.',
      );
    }
  }

  /**
   * Garantiza NDVI y NDMI en la lista final, sin duplicados, preservando el
   * orden de los extras tal como los mandó el caller. El usuario puede
   * agregar índices avanzados pero nunca sacar la base — si el DTO manda
   * solo ['NDRE'], el resultado es ['NDVI','NDMI','NDRE'], no ['NDRE'].
   */
  private normalizeIndices(requested?: string[]): string[] {
    const extras = (requested ?? [])
      .map((idx) => idx.toUpperCase().trim())
      .filter((idx) => idx && !BASE_INDICES.includes(idx));

    return [...BASE_INDICES, ...Array.from(new Set(extras))];
  }

  private mapPipelineInputToWorkerPayload(
    input: PipelineInput,
  ): NewWorkerPayload {
    const coordinates = this.closeRing(
      this.extractPolygonCoordinates(input.geojson),
    );

    return {
      field_name: input.location
        ? `${input.name} / ${input.location}`
        : input.name,

      lots: [
        {
          name: input.name || `Lote ${input.lotId}`,
          coordinates,
          lot_id: input.lotId,
        },
      ],

      campaign_start: input.startDate,
      campaign_end: input.endDate,

      // Flujo legacy de lote único: no tiene DTO propio para elegir índices
      // todavía, así que siempre manda la base NDVI/NDMI.
      indices: this.normalizeIndices(),

      max_cloud_pct: input.maxCloudiness ?? 20,

      scale: 10,

      zone_campaign_years: this.getCampaignYears(
        input.startDate,
        input.endDate,
      ),

      zone_indices: ['NDVI', 'NDMI'],

      n_zones: 3,

      zone_resolution: 256,

      /**
       * Lo dejamos en false para no traer un base64 enorme al backend/front.
       * Después, si querés mostrar overlay de zonas, lo activamos desde un endpoint específico.
       */
      include_zone_png: false,
    };
  }

  private extractPolygonCoordinates(rawGeojson: unknown): number[][] {
    if (!rawGeojson) {
      throw new Error('geojson is required');
    }

    const geojson =
      typeof rawGeojson === 'string'
        ? JSON.parse(rawGeojson)
        : (rawGeojson as any);

    /**
     * Caso Feature:
     * {
     *   type: "Feature",
     *   geometry: {
     *     type: "Polygon",
     *     coordinates: [[[lon, lat], ...]]
     *   }
     * }
     */
    if (geojson.type === 'Feature' && geojson.geometry?.type === 'Polygon') {
      return geojson.geometry.coordinates[0];
    }

    /**
     * Caso Polygon:
     * {
     *   type: "Polygon",
     *   coordinates: [[[lon, lat], ...]]
     * }
     */
    if (geojson.type === 'Polygon') {
      return geojson.coordinates[0];
    }

    /**
     * Caso FeatureCollection:
     * {
     *   type: "FeatureCollection",
     *   features: [
     *     {
     *       geometry: {
     *         type: "Polygon",
     *         coordinates: [[[lon, lat], ...]]
     *       }
     *     }
     *   ]
     * }
     */
    if (
      geojson.type === 'FeatureCollection' &&
      Array.isArray(geojson.features)
    ) {
      const polygonFeature = geojson.features.find(
        (feature) => feature?.geometry?.type === 'Polygon',
      );

      if (polygonFeature) {
        return polygonFeature.geometry.coordinates[0];
      }
    }

    /**
     * Caso objeto con geometry directa.
     */
    if (geojson.geometry?.type === 'Polygon') {
      return geojson.geometry.coordinates[0];
    }

    throw new Error('Invalid geojson polygon format');
  }

  private closeRing(coordinates: number[][]): number[][] {
    if (!coordinates || coordinates.length < 3) {
      throw new Error('Polygon needs at least 3 coordinates');
    }

    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    if (first[0] !== last[0] || first[1] !== last[1]) {
      return [...coordinates, first];
    }

    return coordinates;
  }

  /**
   * Fase PERF-1: antes devolvía TODOS los años calendario entre startDate y
   * endDate (con los defaults de fecha del frontend, eso podía ser 6-8+
   * campañas). Ahora se queda con los `maxZoneCampaigns` años más recientes
   * del rango — cada campaña de más multiplica llamadas getThumbURL
   * secuenciales en zones.py, sin cambiar qué campaña representa cada año.
   */
  private getCampaignYears(
    startDate: string,
    endDate: string,
    maxZoneCampaigns?: number,
  ): number[] {
    const startYear = new Date(startDate).getFullYear();
    const endYear = new Date(endDate).getFullYear();

    if (Number.isNaN(startYear) || Number.isNaN(endYear)) {
      return [new Date().getFullYear()];
    }

    const years: number[] = [];

    for (let year = startYear; year <= endYear; year++) {
      years.push(year);
    }

    if (!years.length) {
      return [endYear];
    }

    return years.slice(-this.clampMaxZoneCampaigns(maxZoneCampaigns));
  }

  private clampMaxZoneCampaigns(value?: number): number {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return DEFAULT_MAX_ZONE_CAMPAIGNS;
    }

    return Math.min(
      MAX_MAX_ZONE_CAMPAIGNS,
      Math.max(MIN_MAX_ZONE_CAMPAIGNS, Math.round(value)),
    );
  }
  private mapFieldInputToWorkerPayload(
    input: FieldWorkerInput,
  ): NewWorkerPayload {
    const workerLots = input.lots
      .filter((lot) => lot.includeInProductivityClassification)
      .map((lot) => ({
        name: lot.name,
        coordinates: this.closeRing(
          this.extractPolygonCoordinates(lot.geojson),
        ),
        lot_id: lot.id,
      }));

    if (!workerLots.length) {
      throw new Error(
        'No hay lotes habilitados para clasificación productiva.',
      );
    }

    return {
      field_name: input.location
        ? `${input.name} / ${input.location}`
        : input.name,

      lots: workerLots,

      campaign_start: input.startDate,
      campaign_end: input.endDate,

      // NDVI/NDMI siempre presentes (normalizeIndices los garantiza); los
      // avanzados que haya activado el usuario en el modal viajan como
      // extras arriba de esa base.
      indices: this.normalizeIndices(input.indices),

      max_cloud_pct: input.maxCloudiness ?? 30,

      scale: 10,

      zone_campaign_years: this.getCampaignYears(
        input.startDate,
        input.endDate,
        input.maxZoneCampaigns,
      ),

      // zone_indices sigue NDVI+NDMI por default aunque `indices` traiga
      // avanzados — el usuario tiene que pedirlo explícito para que la
      // clasificación de zonas los use también.
      zone_indices: this.normalizeIndices(input.zoneIndices),

      n_zones: 3,

      zone_resolution: 256,

      include_zone_png: false,

      /**
       * Fase PERF-1: antes estos dos quedaban fijos en `true` para todo
       * análisis de campo, sin importar lo que pidiera el caller — el modo
       * "rápido" del frontend no tenía forma de apagarlos. Ahora respetan lo
       * que mande el caller (RunFieldAnalysisDto), con default `false` para
       * que el análisis por defecto sea rápido. "Informe completo" los
       * prende explícitamente desde field-detail.component.ts.
       *
       * index_image_indices decide cuáles assets visuales genera el worker
       * (NDVI/NDMI por default; NDRE y SWIR quedan disponibles si el
       * usuario los activa — SWIR nunca es un índice de `indices`,
       * solo existe como asset visual).
       */
      include_map_assets: input.includeMapAssets ?? false,
      map_dimensions: 280,
      include_index_images: input.includeIndexImages ?? false,
      index_image_indices: this.normalizeIndices(input.indexImageIndices),
      index_image_dimensions: 280,
    };
  }
  async runFieldAnalysis(
    input: FieldWorkerInput,
  ): Promise<WorkerAnalysisResult> {
    const workerPayload = this.mapFieldInputToWorkerPayload(input);
    return this.postToWorker(workerPayload);
  }
}
