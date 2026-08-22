import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import type { WeeklyReportStatus } from '../entities/weekly-field-report.entity';

const WEEKLY_REPORT_STATUSES: WeeklyReportStatus[] = ['pending', 'processing', 'completed', 'failed'];

export class ListWeeklyReportsQueryDto {
  @IsOptional()
  @IsDateString()
  campaignStart?: string;

  @IsOptional()
  @IsIn(WEEKLY_REPORT_STATUSES)
  status?: WeeklyReportStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
