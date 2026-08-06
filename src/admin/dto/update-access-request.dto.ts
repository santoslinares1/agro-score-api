import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import type { AccessRequestStatus } from '../../access-request/entities/access-request.entity';

const ACCESS_REQUEST_STATUSES: AccessRequestStatus[] = [
  'new',
  'contacted',
  'interested',
  'discarded',
  'converted',
];

// ADMIN-2: a propósito no incluye name/email/organization/profile/message —
// esos son datos de la solicitud tal como llegó desde la landing, el admin
// no los edita. Solo status/internalNotes/assignedToUserId son operables.
export class UpdateAccessRequestDto {
  @IsOptional()
  @IsIn(ACCESS_REQUEST_STATUSES)
  status?: AccessRequestStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  internalNotes?: string;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}
