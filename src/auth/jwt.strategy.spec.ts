import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { UserRole } from '../users/user-role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { JwtStrategy } from './jwt.strategy';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@agroscorelatam.com',
    passwordHash: 'hashed',
    fullName: 'Usuario de prueba',
    companyName: undefined,
    role: UserRole.USER,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ADMIN-1: sin este chequeo, desactivar a un usuario desde el panel admin no
// tiene efecto hasta que expire su JWT (hasta 7 días) — este test protege
// esa garantía.
describe('JwtStrategy — rechazo de usuarios desactivados (ADMIN-1)', () => {
  const config = { get: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService;

  it('rechaza a un usuario con isActive=false aunque el JWT sea válido', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue(buildUser({ isActive: false })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    await expect(
      strategy.validate({ sub: 'user-1', email: 'user@agroscorelatam.com', role: UserRole.USER }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acepta a un usuario activo y devuelve el role actual desde la DB', async () => {
    const usersService = {
      findById: jest
        .fn()
        .mockResolvedValue(buildUser({ isActive: true, role: UserRole.ADMIN })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    const result = await strategy.validate({
      sub: 'user-1',
      email: 'user@agroscorelatam.com',
      // El JWT trae 'user' pero la DB ya lo tiene como 'admin' — debe ganar la DB.
      role: UserRole.USER,
    });

    expect(result.role).toBe(UserRole.ADMIN);
  });
});
