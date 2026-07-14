import { IsDateString, IsInt, Max, Min } from 'class-validator';

export class RunFieldAnalysisDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsInt()
  @Min(0)
  @Max(100)
  maxCloudiness: number;
}
