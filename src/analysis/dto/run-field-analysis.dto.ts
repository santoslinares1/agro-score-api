import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { MAX_ANALYSIS_CLOUDINESS } from '../analysis-constraints';

export class RunFieldAnalysisDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  /**
   * OPS-2: tope alineado a MAX_ANALYSIS_CLOUDINESS (lo que el Worker acepta hoy por default,
   * ver analysis-constraints.ts) — antes era 100, lo que permitía crear un Analysis=Procesando
   * que el Worker siempre terminaba rechazando con 81..100 (RISK-004).
   */
  @IsInt()
  @Min(0)
  @Max(MAX_ANALYSIS_CLOUDINESS)
  maxCloudiness: number;

  /**
   * Índices avanzados opcionales para timeseries (además de NDVI/NDMI, que
   * el backend siempre incluye — ver PythonWorkerService.normalizeIndices).
   * Si no se manda, el worker usa el default NDVI+NDMI.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  indices?: string[];

  /**
   * Índices para la clasificación de zonas productivas. Opcional: por
   * default sigue siendo NDVI+NDMI aunque `indices` traiga avanzados.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  zoneIndices?: string[];

  /**
   * Qué índices generar como imagen visual de floración (independiente de
   * `indices`: puede incluir SWIR, que nunca es un índice de timeseries).
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  indexImageIndices?: string[];

  /**
   * Fase PERF-1: assets pesados (RGB, imágenes de índices) apagados por
   * default — el análisis rápido no los pide. "Informe completo" los
   * prende explícitamente desde el frontend.
   */
  @IsOptional()
  @IsBoolean()
  includeMapAssets?: boolean;

  @IsOptional()
  @IsBoolean()
  includeIndexImages?: boolean;

  /**
   * Fase 2 mínima: grillas mensuales NDVI/NDMI por campaña (resultJson.imageSeries). Apagado
   * por default — independiente de includeMapAssets/includeIndexImages, no se genera salvo que
   * se pida explícito.
   */
  @IsOptional()
  @IsBoolean()
  includeImageSeries?: boolean;

  /**
   * Tope de campañas para la clasificación de zonas productivas. Antes se
   * usaba un año por cada año calendario entre startDate y endDate (podía
   * ser 6-8+ con los rangos default del frontend); ahora se acota a los N
   * años más recientes del rango. Ver PythonWorkerService.getCampaignYears.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  maxZoneCampaigns?: number;
}
