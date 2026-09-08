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
    tokenVersion: 0,
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

// PROFILE-SEC-1: sin este chequeo, "cambiar contraseña" y "cerrar otras
// sesiones" no invalidarían ningún JWT ya emitido hasta que expire (hasta
// 7 días) — estos tests protegen esa garantía.
describe('JwtStrategy — invalidación por tokenVersion (PROFILE-SEC-1)', () => {
  const config = { get: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService;

  it('rechaza un JWT cuyo tokenVersion no coincide con el del usuario', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue(buildUser({ tokenVersion: 2 })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    await expect(
      strategy.validate({
        sub: 'user-1',
        email: 'user@agroscorelatam.com',
        role: UserRole.USER,
        tokenVersion: 1,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('acepta un JWT cuyo tokenVersion coincide con el del usuario', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue(buildUser({ tokenVersion: 2 })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    await expect(
      strategy.validate({
        sub: 'user-1',
        email: 'user@agroscorelatam.com',
        role: UserRole.USER,
        tokenVersion: 2,
      }),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('trata un payload sin tokenVersion (tokens emitidos antes de esta ficha) como versión 0', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue(buildUser({ tokenVersion: 0 })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    await expect(
      strategy.validate({ sub: 'user-1', email: 'user@agroscorelatam.com', role: UserRole.USER }),
    ).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('rechaza un payload sin tokenVersion si el usuario ya incrementó el suyo', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue(buildUser({ tokenVersion: 1 })),
    } as unknown as UsersService;

    const strategy = new JwtStrategy(config, usersService);

    await expect(
      strategy.validate({ sub: 'user-1', email: 'user@agroscorelatam.com', role: UserRole.USER }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
