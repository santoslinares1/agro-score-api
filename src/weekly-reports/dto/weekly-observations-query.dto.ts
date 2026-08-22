import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

import { ALLOWED_WEEKLY_INDICES } from './create-weekly-report.dto';

export class WeeklyObservationsQueryDto {
  @IsOptional()
  @IsIn(ALLOWED_WEEKLY_INDICES)
  index?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;

  @IsOptional()
  @IsDateString()
  campaignStart?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
