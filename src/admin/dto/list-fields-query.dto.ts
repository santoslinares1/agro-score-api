import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { PaginationQueryDto } from './pagination-query.dto';

// Mismo transform que ListAnalysisQueryDto (onlyFailed/onlyUnreviewed) — el @Type(() => Boolean)
// de class-transformer usa el constructor Boolean(), que trata cualquier string no vacía como
// true ('false' incluido). Acá se interpreta 'true'/'false' de forma explícita, como llegan
// siempre desde un query param.
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class ListFieldsQueryDto extends PaginationQueryDto {
  // Admin PR 1: filtro real detrás de la alerta "Campos sin diagnóstico" del Dashboard — ver
  // AdminService.listFields (hasAnalysis=false) y countFieldsWithNoAnalysis (mismo criterio
  // NOT EXISTS, usado para la métrica agregada).
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasAnalysis?: boolean;
}
