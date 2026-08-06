import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UserRole } from '../../users/user-role.enum';
import { CreateInvitationDto } from './create-invitation.dto';

describe('CreateInvitationDto', () => {
  it('acepta un payload válido', async () => {
    const instance = plainToInstance(CreateInvitationDto, {
      email: 'nuevo@agroscorelatam.com',
      role: UserRole.ADMIN,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza un email inválido', async () => {
    const instance = plainToInstance(CreateInvitationDto, {
      email: 'no-es-un-email',
      role: UserRole.USER,
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it('rechaza un rol inválido', async () => {
    const instance = plainToInstance(CreateInvitationDto, {
      email: 'nuevo@agroscorelatam.com',
      role: 'superadmin',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'role')).toBe(true);
  });

  it('rechaza role ausente', async () => {
    const instance = plainToInstance(CreateInvitationDto, {
      email: 'nuevo@agroscorelatam.com',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'role')).toBe(true);
  });
});
