import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

// SEC-003: verifica que /auth/login y /auth/register queden atados a
// ThrottlerGuard con un límite explícito, sin depender de un guard global
// (ver comentario en app.module.ts). Si alguien borra el @Throttle/@UseGuards
// de estos métodos, este test lo detecta.
describe('AuthController — rate limiting (SEC-003)', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: jest.fn(),
            login: jest.fn(),
            me: jest.fn(),
            acceptInvitation: jest.fn(),
            resetPassword: jest.fn(),
            changePassword: jest.fn(),
            revokeOtherSessions: jest.fn(),
            deactivateAccount: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(AuthController);
  });

  it.each([
    ['login', 5],
    ['register', 5],
    ['acceptInvitation', 5],
    ['resetPassword', 5],
    // PROFILE-SEC-1: change-password y deactivate-account verifican una
    // password contra el hash existente — mismo riesgo de fuerza bruta que
    // login/reset-password, aunque acá el atacante ya necesite un JWT
    // robado.
    ['changePassword', 5],
    ['deactivateAccount', 5],
  ])('%s tiene ThrottlerGuard con límite de %i req/min', (method, limit) => {
    const handler = (controller as unknown as Record<string, () => unknown>)[
      method
    ];

    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as
      | unknown[]
      | undefined;
    expect(guards).toContain(ThrottlerGuard);

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(limit);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('/auth/logout no lleva ThrottlerGuard (no es objetivo de SEC-003)', () => {
    const logout = (controller as unknown as Record<string, () => unknown>)
      .logout;
    const logoutGuards = Reflect.getMetadata(GUARDS_METADATA, logout) as
      | unknown[]
      | undefined;
    expect(logoutGuards ?? []).not.toContain(ThrottlerGuard);
  });

  // PROFILE-SEC-1: no verifica ninguna password, no hay superficie de
  // fuerza bruta que limitar — mismo criterio que /auth/me.
  it('/auth/revoke-other-sessions no lleva ThrottlerGuard', () => {
    const handler = (controller as unknown as Record<string, () => unknown>)
      .revokeOtherSessions;
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as
      | unknown[]
      | undefined;
    expect(guards ?? []).not.toContain(ThrottlerGuard);
  });
});
