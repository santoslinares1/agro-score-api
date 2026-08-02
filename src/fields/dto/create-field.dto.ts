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

  @IsInt()
  @Min(0)
  @Max(100)
  maxCloudiness: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFieldLotDto)
  lots: CreateFieldLotDto[];
}
