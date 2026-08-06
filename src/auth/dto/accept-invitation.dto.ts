import { IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;

  // La invitación (UserInvitation) solo guarda email/rol — el nombre lo
  // completa la persona invitada al aceptar, como un signup normal.
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName: string;
}
