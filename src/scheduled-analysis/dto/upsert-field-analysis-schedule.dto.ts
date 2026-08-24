import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { SUPPORTED_TIMEZONE_OFFSETS_MINUTES } from '../schedule-time.util';

const SUPPORTED_TIMEZONES = Object.keys(SUPPORTED_TIMEZONE_OFFSETS_MINUTES);

/**
 * Upsert: todos los campos opcionales. Un PUT sin body (o con solo `enabled`) usa los defaults
 * del MVP (lunes 9:00 America/Argentina/Cordoba, flags de informe visual completo en true) — ver
 * FieldAnalysisScheduleService.upsert.
 *
 * Fase 4D: includeMapAssets/includeIndexImages/includeImageSeries se siguen validando y
 * guardando acá, pero ScheduledAnalysisRunnerService.triggerRun los ignora al ejecutar — el
 * análisis semanal por email es siempre el informe más completo, sin importar qué se mande acá.
 */
export class UpsertFieldAnalysisScheduleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  hour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(59)
  minute?: number;

  @IsOptional()
  @IsIn(SUPPORTED_TIMEZONES)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  includeMapAssets?: boolean;

  @IsOptional()
  @IsBoolean()
  includeIndexImages?: boolean;

  @IsOptional()
  @IsBoolean()
  includeImageSeries?: boolean;
}
