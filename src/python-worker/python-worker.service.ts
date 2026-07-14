import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

import { PipelineInput } from '../lots/lots.service';
import { WorkerAnalysisResult } from './types';

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
};

type FieldWorkerInput = {
  fieldId: string;
  name: string;
  location?: string;
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  lots: Array<{
    id: string;
    name: string;
    geojson: unknown;
    areaHa: number;
    includeInProductivityClassification: boolean;
  }>;
};

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

      indices: ['NDVI', 'NDMI', 'NDRE', 'EVI', 'MSAVI2', 'BSI'],

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

  private getCampaignYears(startDate: string, endDate: string): number[] {
    const startYear = new Date(startDate).getFullYear();
    const endYear = new Date(endDate).getFullYear();

    if (Number.isNaN(startYear) || Number.isNaN(endYear)) {
      return [new Date().getFullYear()];
    }

    const years: number[] = [];

    for (let year = startYear; year <= endYear; year++) {
      years.push(year);
    }

    return years.length ? years : [endYear];
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

      indices: ['NDVI', 'NDMI', 'NDRE', 'EVI', 'MSAVI2', 'BSI'],

      max_cloud_pct: input.maxCloudiness ?? 30,

      scale: 10,

      zone_campaign_years: this.getCampaignYears(
        input.startDate,
        input.endDate,
      ),

      zone_indices: ['NDVI', 'NDMI'],

      n_zones: 3,

      zone_resolution: 256,

      include_zone_png: false,
    };
  }
  async runFieldAnalysis(
    input: FieldWorkerInput,
  ): Promise<WorkerAnalysisResult> {
    const workerPayload = this.mapFieldInputToWorkerPayload(input);
    return this.postToWorker(workerPayload);
  }
}
