import { IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from './pagination-query.dto';

// Admin PR 2: trazabilidad — "ver lotes de este campo/usuario" desde Campos/Usuarios
// (/lots?fieldId=<uuid>, /lots?userId=<uuid>).
export class ListLotsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  fieldId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;
}
