import { IsDateString, IsOptional } from 'class-validator';

/**
 * `week`: cualquier fecha (YYYY-MM-DD) dentro de la semana calendario a reportar — se resuelve al
 * lunes-domingo que la contiene (ver resolveCalendarWeek). Omitido: la última semana calendario ya
 * completa antes de ahora (nunca la semana en curso, todavía parcial).
 */
export class AdminProductAnalyticsQueryDto {
  @IsOptional()
  @IsDateString()
  week?: string;
}
