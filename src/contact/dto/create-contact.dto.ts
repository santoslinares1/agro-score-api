import {
  IsEmail,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ContactProfile } from '../contact-profile.enum';

export class CreateContactDto {
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
  companyOrField: string;

  @IsEnum(ContactProfile)
  profile: ContactProfile;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  estimatedSurface: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message: string;
}
