import { IsOptional, IsString, IsUUID } from 'class-validator';

import { PaginationQueryDto } from './pagination-query.dto';

// ADMIN-2: no extiende `search` genérico — los audit logs se filtran por
// campos exactos (actor/acción/target), no por texto libre.
export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;
}
