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

export class CreateAdminUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName: string;

  @IsEmail()
  @MaxLength(160)
  email: string;

  // Contraseña temporal: el admin la crea y se la comunica al usuario nuevo
  // por fuera de este endpoint (no hay flujo de "olvidé mi contraseña" en
  // esta fase, así que no se fuerza cambio en el primer login).
  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
