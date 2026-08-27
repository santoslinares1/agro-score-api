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
//
// Admin PR 3: hasRuns usa la existencia REAL de filas en scheduled_analysis_runs (EXISTS/NOT
// EXISTS, ver AdminService.listScheduledAnalysis) — a propósito no reusa
// FieldAnalysisSchedule.lastRunAt: hoy ambos coinciden siempre (ScheduledAnalysisRunnerService
// setea lastRunAt en el mismo momento en que crea la primera corrida), pero lastRunAt es un
// campo cacheado y este filtro debe reflejar el dato real, no una copia. mailStatus (sent/failed/
// pending) queda fuera de este PR: filtrar el LISTADO (no solo contarlo) por el mail de la
// corrida más reciente de cada schedule exige llevar el mismo DISTINCT ON de
// getLatestRunsByScheduleId al query principal, no solo a un agregado — la info de mail por fila
// ya está disponible en la respuesta (latestRun.emailSentAt/status/failedAt) y en el resumen
// agregado (mailSentLast7Days/mailSentLast30Days/mailPendingOrFailed), así que no bloquea nada
// operativo. Documentado como deuda futura en docs/admin-ux-notes.md.
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

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasRuns?: boolean;
}
