import { IsString, MinLength } from 'class-validator';

// ADMIN-3: misma regla que AcceptInvitationDto — "reglas actuales", no se
// suma validación de complejidad nueva.
export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;
}
