import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from './pagination-query.dto';

// Mismo transform que el resto de los DTOs admin con filtros booleanos (hasAnalysis,
// onlyFailed/onlyUnreviewed) — Boolean() de class-transformer trata cualquier string no vacía
// como true, 'false' incluido.
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

// Admin PR 2: trazabilidad — "ver programados de este campo/usuario" desde Campos/Usuarios
// (/scheduled-analysis?fieldId=<uuid>, ?userId=<uuid>), y "solo activos" (?enabled=true).
// hasRuns=false (schedules activos sin ninguna corrida) queda fuera de este PR — el criterio
// para filtrar por eso vive en AdminService.countActiveSchedulesWithoutRuns() como agregado, no
// como filtro de listado; llevarlo a un filtro real implica tocar el join DISTINCT ON contra
// ScheduledAnalysisRun (ver getLatestRunsByScheduleId) y queda documentado como deuda para
// Admin PR 3.
export class ListScheduledAnalysisQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  enabled?: boolean;
}
