import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from './roles.guard';
import { UserRole } from '../users/user-role.enum';

function buildContext(user: { role: UserRole } | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  function buildGuard(requiredRoles: UserRole[] | undefined) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
    } as unknown as Reflector;

    return new RolesGuard(reflector);
  }

  it('permite el acceso si la ruta no declara @Roles(...)', () => {
    const guard = buildGuard(undefined);

    expect(guard.canActivate(buildContext({ role: UserRole.USER }))).toBe(true);
  });

  it('deniega si no hay request.user (sin JWT / JwtAuthGuard no corrió)', () => {
    const guard = buildGuard([UserRole.OWNER, UserRole.ADMIN]);

    expect(guard.canActivate(buildContext(undefined))).toBe(false);
  });

  it('deniega a un usuario con role "user" en rutas admin', () => {
    const guard = buildGuard([UserRole.OWNER, UserRole.ADMIN]);

    expect(guard.canActivate(buildContext({ role: UserRole.USER }))).toBe(false);
  });

  it('permite a un usuario con role "admin" en rutas admin', () => {
    const guard = buildGuard([UserRole.OWNER, UserRole.ADMIN]);

    expect(guard.canActivate(buildContext({ role: UserRole.ADMIN }))).toBe(true);
  });

  it('permite a un usuario con role "owner" en rutas admin', () => {
    const guard = buildGuard([UserRole.OWNER, UserRole.ADMIN]);

    expect(guard.canActivate(buildContext({ role: UserRole.OWNER }))).toBe(true);
  });
});
