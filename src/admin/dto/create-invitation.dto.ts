import { IsEmail, IsEnum, MaxLength } from 'class-validator';

import { UserRole } from '../../users/user-role.enum';

export class CreateInvitationDto {
  @IsEmail()
  @MaxLength(160)
  email: string;

  @IsEnum(UserRole)
  role: UserRole;
}
