import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UserRole } from '../../users/user-role.enum';
import { CreateAdminUserDto } from './create-admin-user.dto';

describe('CreateAdminUserDto', () => {
  const validPayload = {
    fullName: 'Ana Admin',
    email: 'ana.admin@agroscorelatam.com',
    password: 'temporal123',
    role: UserRole.ADMIN,
  };

  const validateWith = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(CreateAdminUserDto, {
      ...validPayload,
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload válido con rol admin', async () => {
    const errors = await validateWith({});
    expect(errors).toHaveLength(0);
  });

  it('acepta un payload válido con rol owner e isActive explícito', async () => {
    const errors = await validateWith({ role: UserRole.OWNER, isActive: false });
    expect(errors).toHaveLength(0);
  });

  it('rechaza un rol inválido', async () => {
    const errors = await validateWith({ role: 'superadmin' });
    expect(errors.some((error) => error.property === 'role')).toBe(true);
  });

  it('rechaza un email inválido', async () => {
    const errors = await validateWith({ email: 'no-es-un-email' });
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it('rechaza password ausente/demasiado corto', async () => {
    const errors = await validateWith({ password: '123' });
    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });

  it('rechaza fullName vacío', async () => {
    const errors = await validateWith({ fullName: '' });
    expect(errors.some((error) => error.property === 'fullName')).toBe(true);
  });
});
