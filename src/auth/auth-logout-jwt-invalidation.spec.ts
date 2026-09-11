import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

import { AuditLogService } from '../audit-log/audit-log.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

/**
 * SEC-003 (recorrido real de autenticación tras logout): mismo patrón que
 * auth-reset-jwt-invalidation.spec.ts — JWT real (JwtService.sign/verify, vía jsonwebtoken),
 * JwtStrategy.validate() real (sin mockear), JwtAuthGuard.canActivate() real (extrae el Bearer,
 * verifica firma/expiración de verdad vía passport-jwt, y llama a validate()), AuthService.login/
 * logout reales. SIMULADO, declarado explícitamente: no hay HTTP real (Express/Nest bootstrap —
 * eso se prueba aparte en auth.controller.spec.ts) ni PostgreSQL — el "request" es un objeto
 * mínimo con `headers.authorization`, y el repositorio de User es un doble en memoria que
 * interpreta `tokenVersion: () => '"tokenVersion" + 1'` como +1, igual que la sentencia SQL real
 * que reemplaza (ver UsersService.incrementTokenVersion).
 *
 * Objetivo: demostrar que logout invalida de verdad TODOS los JWT emitidos antes de esa llamada —
 * no solo que el controller invocó un método mockeado (ver auth.controller.spec.ts para esa otra
 * capa, con AuthService mockeado).
 */
describe('Recorrido real de autenticación tras logout (SEC-003)', () => {
  const TEST_JWT_SECRET = 'solo-para-esta-suite-nunca-un-secreto-real-000000';

  function buildHarness() {
    const fakeUser: User = {
      id: 'user-1',
      email: 'usera@example.com',
      passwordHash: bcrypt.hashSync('password123', 10),
      fullName: 'User A',
      companyName: 'Acme',
      role: 'user' as User['role'],
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    } as User;

    const fakeUsersRepository = {
      findOne: async ({ where }: { where: Partial<Pick<User, 'id' | 'email'>> }) => {
        if (where.id !== undefined) return where.id === fakeUser.id ? { ...fakeUser } : null;
        if (where.email !== undefined) return where.email === fakeUser.email ? { ...fakeUser } : null;
        return null;
      },
      update: async (id: string, changes: Record<string, unknown>) => {
        if (id !== fakeUser.id) {
          return { affected: 0 };
        }
        if (typeof changes.tokenVersion === 'function') {
          // Misma semántica que el fragmento SQL crudo `"tokenVersion" + 1` que emite
          // UsersService.incrementTokenVersion — un incremento atómico, no una asignación.
          fakeUser.tokenVersion += 1;
        }
        return { affected: 1 };
      },
    };

    const usersService = new UsersService(fakeUsersRepository as never);
    const jwtService = new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '1h' } });
    const auditLogService = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogService;

    const authService = new AuthService(
      usersService,
      jwtService,
      auditLogService,
      {} as never, // invitationRepository — no se usa en este recorrido.
      {} as never, // passwordResetRepository — no se usa.
      {} as never, // dataSource — no se usa (logout no abre transacción).
    );

    const configService = {
      get: (key: string) => (key === 'JWT_SECRET' ? TEST_JWT_SECRET : undefined),
    } as unknown as ConfigService;

    // jwtStrategy REAL — al instanciarla, PassportStrategy la autoregistra contra el `passport`
    // global bajo el nombre 'jwt' (mismo mecanismo que en producción).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const jwtStrategy = new JwtStrategy(configService, usersService);
    const guard = new JwtAuthGuard();

    function contextWithBearerToken(token?: string): ExecutionContext {
      const request: Record<string, unknown> = {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      };
      return {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
        }),
      } as unknown as ExecutionContext;
    }

    async function authenticate(token?: string): Promise<{ sub: string }> {
      const context = contextWithBearerToken(token);
      await guard.canActivate(context);
      return (context.switchToHttp().getRequest() as { user: { sub: string } }).user;
    }

    return { fakeUser, usersService, jwtService, auditLogService, authService, authenticate };
  }

  it('logout invalida TODOS los JWT emitidos antes (incluidos los de otras sesiones/dispositivos); login posterior emite un JWT nuevo y válido', async () => {
    const { fakeUser, jwtService, auditLogService, authService, authenticate } = buildHarness();

    // ---- 1. Dos logins ("dos dispositivos"): JWT #1 y JWT #2, ambos con tokenVersion=0 ----
    const login1 = await authService.login({ email: fakeUser.email, password: 'password123' });
    const login2 = await authService.login({ email: fakeUser.email, password: 'password123' });
    const jwtDevice1 = login1.accessToken;
    const jwtDevice2 = login2.accessToken;

    const decoded1 = await jwtService.verifyAsync(jwtDevice1, { secret: TEST_JWT_SECRET });
    expect(decoded1.tokenVersion).toBe(0);

    // ---- 2. Ambos se aceptan ANTES del logout ----
    await expect(authenticate(jwtDevice1)).resolves.toMatchObject({ sub: fakeUser.id });
    await expect(authenticate(jwtDevice2)).resolves.toMatchObject({ sub: fakeUser.id });

    // ---- 3. Logout desde "device 1": tokenVersion se incrementa de verdad, UNA sola vez ----
    expect(fakeUser.tokenVersion).toBe(0);
    const logoutResult = await authService.logout(fakeUser.id, { ip: '1.2.3.4', userAgent: 'jest' });
    expect(fakeUser.tokenVersion).toBe(1);
    expect(logoutResult).not.toHaveProperty('accessToken');

    // ---- 4. TANTO el JWT que ejecutó logout COMO el de la otra sesión quedan rechazados —
    // logout cierra TODAS las sesiones, no solo la que lo pidió (semántica aceptada de esta
    // ficha: no hay sesiones individuales ni JTI). Mismo token, sin reconstruir el payload a
    // mano: la firma sigue siendo válida, lo que cambia es que JwtStrategy compara tokenVersion
    // contra el usuario ya actualizado. ----
    await expect(authenticate(jwtDevice1)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authenticate(jwtDevice2)).rejects.toBeInstanceOf(UnauthorizedException);

    // ---- 5. Un segundo logout (p. ej. doble click, o el mismo usuario logueándose y
    // deslogueándose de nuevo) incrementa la versión otra vez — cada logout exitoso incrementa
    // exactamente una vez, de forma acumulativa. ----
    await authService.logout(fakeUser.id);
    expect(fakeUser.tokenVersion).toBe(2);

    // ---- 6. Login posterior emite un JWT nuevo, con la versión actual, que sí valida ----
    const loginAfter = await authService.login({ email: fakeUser.email, password: 'password123' });
    const jwtAfter = loginAfter.accessToken;
    const decodedAfter = await jwtService.verifyAsync(jwtAfter, { secret: TEST_JWT_SECRET });
    expect(decodedAfter.tokenVersion).toBe(2);
    await expect(authenticate(jwtAfter)).resolves.toMatchObject({ sub: fakeUser.id });

    // ---- 7. Se auditaron ambos logout, identificando acción y usuario, nunca el token ----
    expect(auditLogService.record).toHaveBeenCalledTimes(2);
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout',
        targetType: 'user',
        targetId: fakeUser.id,
        actor: expect.objectContaining({ actorUserId: fakeUser.id, ip: '1.2.3.4' }),
      }),
    );
  });

  it('sin Authorization header, el guard rechaza antes de llegar a AuthService — tokenVersion nunca cambia', async () => {
    const { fakeUser, authenticate } = buildHarness();

    await expect(authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fakeUser.tokenVersion).toBe(0);
  });
});
