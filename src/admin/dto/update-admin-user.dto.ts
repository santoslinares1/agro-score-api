import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { UserRole } from '../../users/user-role.enum';

// ADMIN-1: a propósito NO incluye password/passwordHash — no hay flujo de
// "resetear contraseña desde el admin" en esta fase. El ValidationPipe
// global (whitelist + forbidNonWhitelisted) rechaza cualquier campo fuera
// de esta lista, incluido si alguien intenta mandar password acá.
export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
