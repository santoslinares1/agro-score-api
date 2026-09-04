import {
  Allow,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

import { MAX_ANALYSIS_CLOUDINESS } from '../../analysis/analysis-constraints';

export class CreateFieldLotDto {
  @IsString()
  name: string;

  @Allow()
  geojson: unknown;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  areaHa?: number;

  @IsOptional()
  @IsNumber()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  includeInProductivityClassification?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateFieldDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  province?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @Allow()
  boundaryGeojson?: unknown;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  /**
   * OPS-2: tope alineado a MAX_ANALYSIS_CLOUDINESS — este valor viaja tal cual a
   * scheduled-analysis (ScheduledAnalysisRunnerService.triggerRun usa field.maxCloudiness
   * directo, sin volver a pasar por RunFieldAnalysisDto), así que un Field persistido con
   * maxCloudiness > 80 rompería el Worker en cada corrida semanal automática, no solo en el
   * análisis manual. UpdateFieldDto hereda este mismo límite (PartialType de este DTO).
   */
  @IsInt()
  @Min(0)
  @Max(MAX_ANALYSIS_CLOUDINESS)
  maxCloudiness: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFieldLotDto)
  lots: CreateFieldLotDto[];
}
