import { IsString } from 'class-validator';

// PROFILE-SEC-1: confirmación por contraseña antes de desactivar la cuenta
// propia — no hay MinLength porque solo se compara contra el hash existente.
export class DeactivateAccountDto {
  @IsString()
  password: string;
}
