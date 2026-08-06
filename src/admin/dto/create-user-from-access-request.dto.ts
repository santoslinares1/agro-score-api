import { IsEnum, IsOptional } from 'class-validator';

import { UserRole } from '../../users/user-role.enum';

// ADMIN-2: no pide password ni fullName — el usuario se da de alta vía
// invitación (ver UserInvitation / POST /auth/accept-invitation), no con una
// password temporal que el admin tendría que ver y comunicar a mano (la
// consigna pide explícitamente que el admin nunca muestre passwords).
export class CreateUserFromAccessRequestDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
