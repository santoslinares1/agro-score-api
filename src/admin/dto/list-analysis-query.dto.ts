import { IsIn, IsOptional } from 'class-validator';

import type { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import { PaginationQueryDto } from './pagination-query.dto';

const ANALYSIS_STATUSES: AnalysisStatus[] = ['Procesando', 'Finalizado', 'Error'];

export class ListAnalysisQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ANALYSIS_STATUSES)
  status?: AnalysisStatus;
}
