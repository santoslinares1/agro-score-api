import { ArrayNotEmpty, IsArray, IsBoolean, IsDateString, IsIn, IsOptional } from 'class-validator';

// NDRE vive acá porque el DTO tiene que aceptarlo en `indices` para poder rechazarlo con un
// mensaje claro si includeNdreExperimental no está prendido (ver WeeklyReportsService — es una
// regla cruzada entre dos campos, no expresable con un solo @IsIn a nivel columna).
export const ALLOWED_WEEKLY_INDICES = ['NDVI', 'NDMI', 'NDRE'] as const;

export class CreateWeeklyReportDto {
  @IsDateString()
  campaignStart: string;

  @IsOptional()
  @IsDateString()
  campaignEnd?: string;

  /** Default: hoy (resuelto en el service, no acá — un DTO no debe fijar "ahora" al parsear). */
  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ALLOWED_WEEKLY_INDICES, { each: true })
  indices?: string[];

  @IsOptional()
  @IsBoolean()
  includeNdreExperimental?: boolean;
}
