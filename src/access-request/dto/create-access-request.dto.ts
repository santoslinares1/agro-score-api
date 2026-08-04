import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AccessRequestProfile } from '../access-request-profile.enum';

export class CreateAccessRequestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsEmail()
  @MaxLength(160)
  email: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  organization: string;

  @IsEnum(AccessRequestProfile)
  profile: AccessRequestProfile;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  estimatedSurface?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
