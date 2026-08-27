import { IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from './pagination-query.dto';

// Admin PR 2: trazabilidad — "saltar al usuario" desde Campos/Diagnósticos/Programados
// (/users?userId=<uuid>). `search` (heredado de PaginationQueryDto) ya matchea por email/nombre
// vía ILIKE (ver UsersService.findAllPaginated), así que /users?email=<email> se resuelve
// reusando ese mismo filtro — no hace falta un campo `email` aparte.
export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;
}
