import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

// class-transformer's `@Type(() => Boolean)` uses the Boolean() constructor,
// which treats any non-empty string ('false' included) as true — clásico
// gotcha con query params. Este transform interpreta explícitamente
// 'true'/'false' (string, como llegan siempre desde un query param).
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

import type { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import { PaginationQueryDto } from './pagination-query.dto';

const ANALYSIS_STATUSES: AnalysisStatus[] = ['Procesando', 'Finalizado', 'Error'];

export class ListAnalysisQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ANALYSIS_STATUSES)
  status?: AnalysisStatus;

  @IsOptional()
  @IsUUID()
  fieldId?: string;

  // Filtra por el dueño (User) del field asociado al análisis, no por un
  // "userId" propio de Analysis (la entidad no tiene ownership directo — ver
  // comentarios en analysis.service.ts).
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyFailed?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onlyUnreviewed?: boolean;
}
