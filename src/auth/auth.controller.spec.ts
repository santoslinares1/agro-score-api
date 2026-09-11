import { GUARDS_METADATA } from '@nestjs/common/constants';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';

import { UserRole } from '../users/user-role.enum';
import { UsersService } from '../users/users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

// SEC-003: verifica que /auth/login quede atado a ThrottlerGuard con un
// límite explícito, sin depender de un guard global (ver comentario en
// app.module.ts). Si alguien borra el @Throttle/@UseGuards de estos métodos,
// este test lo detecta.
describe('AuthController — rate limiting (SEC-003)', () => {
  let controller: AuthController;
  let authServiceMock: Record<string, jest.Mock>;

  beforeEach(async () => {
    authServiceMock = {
      login: jest.fn(),
      me: jest.fn(),
      acceptInvitation: jest.fn(),
      resetPassword: jest.fn(),
      logout: jest.fn(),
      changePassword: jest.fn(),
      revokeOtherSessions: jest.fn(),
      deactivateAccount: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authServiceMock }],
    }).compile();

    controller = module.get(AuthController);
  });

  it.each([
    ['login', 5],
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

  // SEC-003: logout no verifica ninguna password, no hay superficie de
  // fuerza bruta que limitar acá (mismo criterio que /auth/me y
  // /auth/revoke-other-sessions) — pero SÍ debe requerir un JWT válido
  // (JwtAuthGuard). Si alguien borra el @UseGuards(JwtAuthGuard), este test
  // lo detecta a nivel de metadata; el comportamiento real (guard + strategy
  // sin mockear) se prueba más abajo en el describe HTTP-level.
  it('/auth/logout no lleva ThrottlerGuard pero SÍ lleva JwtAuthGuard', () => {
    const logout = (controller as unknown as Record<string, () => unknown>)
      .logout;
    const logoutGuards = Reflect.getMetadata(GUARDS_METADATA, logout) as
      | unknown[]
      | undefined;
    expect(logoutGuards ?? []).not.toContain(ThrottlerGuard);
    expect(logoutGuards).toContain(JwtAuthGuard);
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

// SEC-002 (AUTH-POLICY-1): el registro público fue eliminado a nivel de ruta
// — no hay ningún método `register` en AuthController ni en AuthService (si
// alguien lo reintrodujera acá, este archivo ya no compilaría porque
// `authServiceMock` de arriba no declara esa key). Este describe prueba el
// contrato HTTP real que ve un cliente externo: sin ruta, ningún payload
// (válido, inválido o vacío) puede convertir el endpoint en fail-open, y
// ningún método de AuthService se invoca como efecto de ese request.
describe('POST /auth/register — eliminado (SEC-002 / AUTH-POLICY-1)', () => {
  let app: INestApplication<App>;
  let authServiceMock: Record<string, jest.Mock>;

  beforeEach(async () => {
    authServiceMock = {
      login: jest.fn(),
      me: jest.fn(),
      acceptInvitation: jest.fn(),
      resetPassword: jest.fn(),
      logout: jest.fn(),
      changePassword: jest.fn(),
      revokeOtherSessions: jest.fn(),
      deactivateAccount: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authServiceMock }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['payload válido', { email: 'nuevo@example.com', password: 'password123', fullName: 'Nuevo' }],
    ['payload inválido', { email: 'no-es-un-email' }],
    ['payload vacío', {}],
  ])(
    'responde 404 con %s — la ruta no existe, no es un rechazo de negocio',
    async (_case, payload) => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send(payload);

      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('accessToken');
      expect(response.body).not.toHaveProperty('user');
    },
  );

  it('ningún método de AuthService se llama como efecto del request (sin JWT, sin escritura, sin auditoría)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'nuevo@example.com', password: 'password123', fullName: 'Nuevo' });

    for (const fn of Object.values(authServiceMock)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

/**
 * SEC-003: a diferencia de los describes de arriba (AuthService mockeado por completo), acá
 * `JwtStrategy` y `JwtAuthGuard` son REALES — solo `AuthService`/`UsersService` están mockeados.
 * Objetivo: probar el contrato HTTP real que ve un cliente externo — sin Authorization, con un
 * JWT malformado/firmado con otro secreto/con tokenVersion desactualizado, o de un usuario
 * inactivo, el guard rechaza ANTES de que `AuthController.logout` (y por lo tanto
 * `AuthService.logout`/`UsersService.incrementTokenVersion`) se ejecute — y que `userId` viaja
 * exclusivamente vía `req.user.sub` (poblado por el guard), nunca desde el body, aunque el body
 * traiga un `userId`/`tokenVersion` propio. La invalidación real de un JWT DESPUÉS de que logout
 * corrió (tokenVersion incrementado de verdad) se prueba aparte, sin mocks, en
 * auth-logout-jwt-invalidation.spec.ts.
 */
describe('POST /auth/logout — requiere JWT válido (SEC-003)', () => {
  const TEST_JWT_SECRET = 'solo-para-esta-suite-nunca-un-secreto-real-000000';

  const activeUser = {
    id: 'user-1',
    email: 'usera@example.com',
    role: UserRole.USER,
    isActive: true,
    tokenVersion: 3,
  };

  let app: INestApplication<App>;
  let authServiceMock: Record<string, jest.Mock>;
  let usersServiceMock: { findById: jest.Mock };
  let jwtService: JwtService;

  function signToken(overrides: Record<string, unknown> = {}, secret = TEST_JWT_SECRET): string {
    return new JwtService({ secret }).sign({
      sub: activeUser.id,
      email: activeUser.email,
      role: activeUser.role,
      tokenVersion: activeUser.tokenVersion,
      ...overrides,
    });
  }

  beforeEach(async () => {
    authServiceMock = {
      login: jest.fn(),
      me: jest.fn(),
      acceptInvitation: jest.fn(),
      resetPassword: jest.fn(),
      logout: jest.fn().mockResolvedValue({ message: 'Sesión cerrada correctamente.' }),
      changePassword: jest.fn(),
      revokeOtherSessions: jest.fn(),
      deactivateAccount: jest.fn(),
    };

    usersServiceMock = { findById: jest.fn().mockResolvedValue({ ...activeUser }) };

    const configServiceMock = {
      get: (key: string) => (key === 'JWT_SECRET' ? TEST_JWT_SECRET : undefined),
    } as unknown as ConfigService;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule,
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        JwtStrategy,
      ],
    }).compile();

    // JwtService real, exclusivo de esta suite — nunca un secreto real. Necesario para poder
    // firmar tokens de prueba con exactamente el mismo secreto que JwtStrategy usa para verificar.
    jwtService = new JwtService({ secret: TEST_JWT_SECRET });

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sin Authorization → 401, AuthService.logout nunca se llama, tokenVersion nunca se toca', async () => {
    const response = await request(app.getHttpServer()).post('/auth/logout');

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('JWT malformado → 401, AuthService.logout nunca se llama', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', 'Bearer no-es-un-jwt-real');

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('JWT firmado con un secreto distinto → 401, AuthService.logout nunca se llama', async () => {
    const token = signToken({}, 'otro-secreto-completamente-distinto');

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('JWT con tokenVersion desactualizado → 401, AuthService.logout nunca se llama', async () => {
    const staleToken = signToken({ tokenVersion: activeUser.tokenVersion - 1 });

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${staleToken}`);

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('usuario inactivo → 401, AuthService.logout nunca se llama', async () => {
    usersServiceMock.findById.mockResolvedValueOnce({ ...activeUser, isActive: false });
    const token = signToken();

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('usuario inexistente (borrado después de emitido el JWT) → 401, AuthService.logout nunca se llama', async () => {
    usersServiceMock.findById.mockResolvedValueOnce(null);
    const token = signToken();

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(authServiceMock.logout).not.toHaveBeenCalled();
  });

  it('JWT válido → AuthService.logout se llama con el sub del token (nunca con userId/tokenVersion del body), sin accessToken en la respuesta', async () => {
    const token = signToken();

    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      // Payload adversarial: si algo derivara userId/tokenVersion del body en vez de req.user.sub,
      // este test lo detectaría.
      .send({ userId: 'otro-usuario-cualquiera', tokenVersion: 999, sub: 'otro-usuario-cualquiera' });

    expect(response.status).toBeLessThan(400);
    expect(authServiceMock.logout).toHaveBeenCalledTimes(1);
    expect(authServiceMock.logout).toHaveBeenCalledWith(activeUser.id, expect.any(Object));
    expect(response.body).not.toHaveProperty('accessToken');
  });
});
