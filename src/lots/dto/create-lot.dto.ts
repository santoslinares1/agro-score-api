import {
    IsDateString,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Max,
    Min,
  } from 'class-validator';
  
  export class CreateLotDto {
    @IsString()
    @IsNotEmpty()
    name: string;
  
    @IsString()
    @IsNotEmpty()
    location: string;
  
    @IsDateString()
    startDate: string;
  
    @IsDateString()
    endDate: string;
  
    @IsInt()
    @Min(0)
    @Max(100)
    maxCloudiness: number;
  
    
    @IsOptional()
    geojson?: any;
  }