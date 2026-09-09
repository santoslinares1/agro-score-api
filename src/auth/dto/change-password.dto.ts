import { IsString, MinLength } from 'class-validator';

// PROFILE-SEC-1: misma regla de longitud que RegisterDto/ResetPasswordDto —
// no se suma validación de complejidad nueva. `currentPassword` no lleva
// MinLength: solo se compara contra el hash existente, nunca se persiste.
export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
