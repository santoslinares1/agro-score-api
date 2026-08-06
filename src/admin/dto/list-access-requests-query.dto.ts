import { IsIn, IsOptional } from 'class-validator';

import type { AccessRequestStatus } from '../../access-request/entities/access-request.entity';
import { PaginationQueryDto } from './pagination-query.dto';

const ACCESS_REQUEST_STATUSES: AccessRequestStatus[] = [
  'new',
  'contacted',
  'interested',
  'discarded',
  'converted',
];

export class ListAccessRequestsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ACCESS_REQUEST_STATUSES)
  status?: AccessRequestStatus;
}
