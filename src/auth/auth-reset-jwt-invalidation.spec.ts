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
import { hashToken } from './token.util';

/**
 * F03 (recorrido real de autenticación tras un reset): a diferencia de jwt.strategy.spec.ts
 * (que arma un JwtPayload a mano y llama validate() directamente — cobertura real y necesaria,
 * pero que no prueba NADA sobre la firma/verificación criptográfica del token en sí) y de
 * auth-reset-password-atomicity.e2e-spec.ts (PostgreSQL real, foco en el lock/transacción, no en
 * el JWT), esta suite cierra el tramo que faltaba: emitir un JWT de verdad (JwtService.sign, con
 * un secreto EXCLUSIVO de esta suite, nunca uno real) y validarlo de vuelta a través del mismo
 * mecanismo que usa cada request HTTP protegido — JwtAuthGuard (@nestjs/passport AuthGuard('jwt')
 * real) invocando a JwtStrategy (real, autoregistrada contra el `passport` global igual que en
 * producción — ver PassportStrategy en @nestjs/passport) contra un ExecutionContext simulado.
 *
 * REAL en esta suite: JwtService.sign/verify (firma y verificación HMAC real, vía jsonwebtoken),
 * JwtStrategy.validate() (sin mockear), JwtAuthGuard.canActivate() (sin mockear — extrae el
 * Bearer token del header, ejecuta passport.authenticate('jwt', ...) de verdad, que verifica
 * firma+expiración antes de llegar a validate()), AuthService.login/resetPassword (sin mockear),
 * UsersService.updatePassword (sin mockear — el incremento de tokenVersion corre de verdad).
 *
 * SIMULADO (declarado explícitamente): no hay HTTP real (Express/Nest bootstrap) ni PostgreSQL —
 * el "request" es un objeto mínimo con `headers.authorization`, suficiente para
 * ExtractJwt.fromAuthHeaderAsBearerToken(); los repositorios de TypeORM (User, PasswordResetToken)
 * son dobles en memoria, mutados con la MISMA semántica que la sentencia SQL real que reemplazan
 * (ver fakeUsersRepository.update: interpreta el fragmento `tokenVersion: () => '"tokenVersion" +
 * 1'` como +1, igual que Postgres lo haría). DataSource.transaction() corre el callback real
 * contra un manager falso — la garantía de atomicidad/lock real ya se prueba aparte contra
 * Postgres (ver auth-reset-password-atomicity.e2e-spec.ts), no es el objetivo acá.
 */
describe('Recorrido real de autenticación tras un reset de password (F03)', () => {
  const TEST_JWT_SECRET = 'solo-para-esta-suite-nunca-un-secreto-real-000000';

  it('JWT anterior emitido con la password vieja queda inválido tras el reset; login con la password nueva emite un JWT válido con la versión actual; la password anterior queda rechazada', async () => {
    // ---- Estado en memoria (reemplaza Postgres) ----
    const fakeUser: User = {
      id: 'user-1',
      email: 'usera@example.com',
      passwordHash: bcrypt.hashSync('password-vieja', 10),
      fullName: 'User A',
      companyName: 'Acme',
      role: 'user' as User['role'],
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    } as User;

    const rawResetToken = 'reset-token-crudo-de-esta-suite';
    const fakeResetToken: PasswordResetToken = {
      id: 'reset-1',
      userId: fakeUser.id,
      tokenHash: hashToken(rawResetToken),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    } as PasswordResetToken;

    // ---- Dobles de repositorio: misma semántica que la sentencia SQL real que reemplazan ----
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
        if (typeof changes.passwordHash === 'string') {
          fakeUser.passwordHash = changes.passwordHash;
        }
        if (typeof changes.tokenVersion === 'function') {
          // Misma semántica que el fragmento SQL crudo `"tokenVersion" + 1` que emite
          // UsersService.updatePassword — un incremento atómico, no una asignación.
          fakeUser.tokenVersion += 1;
        }
        return { affected: 1 };
      },
    };

    const fakePasswordResetRepo = {
      findOne: async ({
        where,
      }: {
        where: { tokenHash: string; usedAt: null; expiresAt: unknown };
      }) =>
        where.tokenHash === fakeResetToken.tokenHash && fakeResetToken.usedAt === null
          ? { ...fakeResetToken }
          : null,
      save: async (token: PasswordResetToken) => {
        fakeResetToken.usedAt = token.usedAt;
        return token;
      },
    };

    // usersService REAL — updatePassword/findByEmail/findById corren de verdad, contra el
    // repositorio falso de arriba.
    const usersService = new UsersService(fakeUsersRepository as never);

    // jwtService REAL — firma y verifica con un secreto exclusivo de esta suite.
    const jwtService = new JwtService({
      secret: TEST_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    const auditLogService = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogService;

    // dataSource falso: transaction() corre el callback REAL de AuthService.resetPassword contra
    // un manager cuyo único método usado, getRepository(PasswordResetToken), devuelve el repo
    // falso de arriba — mismo patrón que auth.service.spec.ts.
    const dataSource = {
      transaction: async (work: (manager: { getRepository: (e: unknown) => unknown }) => Promise<unknown>) =>
        work({
          getRepository: (entity: unknown) => {
            if (entity === PasswordResetToken) return fakePasswordResetRepo;
            if (entity === User) return fakeUsersRepository;
            throw new Error(`dataSource falso: entidad inesperada ${String(entity)}`);
          },
        }),
    };

    // authService REAL — login/resetPassword corren de verdad.
    const authService = new AuthService(
      usersService,
      jwtService,
      auditLogService,
      {} as never, // invitationRepository — no se usa en este recorrido.
      fakePasswordResetRepo as never,
      dataSource as never,
    );

    // configService falso — únicamente resuelve JWT_SECRET, igual que en producción (ver
    // getRequiredJwtSecret), pero con el secreto exclusivo de esta suite.
    const configService = {
      get: (key: string) => (key === 'JWT_SECRET' ? TEST_JWT_SECRET : undefined),
    } as unknown as ConfigService;

    // jwtStrategy REAL — al instanciarla, PassportStrategy la autoregistra contra el `passport`
    // global bajo el nombre 'jwt' (mismo mecanismo que en producción, ver @nestjs/passport).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const jwtStrategy = new JwtStrategy(configService, usersService);

    const guard = new JwtAuthGuard();

    /** Construye el ExecutionContext mínimo que JwtAuthGuard necesita — sin HTTP real, pero
     * ejerciendo passport.authenticate('jwt', ...) de verdad (extracción del header, verificación
     * de firma/expiración vía jsonwebtoken, y la llamada real a jwtStrategy.validate()). */
    function contextWithBearerToken(token: string): ExecutionContext {
      const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
      return {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
        }),
      } as unknown as ExecutionContext;
    }

    async function authenticate(token: string): Promise<unknown> {
      const context = contextWithBearerToken(token);
      await guard.canActivate(context);
      return (context.switchToHttp().getRequest() as { user: unknown }).user;
    }

    // ---- 1. Login con la password vieja: emite JWT #1 (tokenVersion=0) ----
    const loginBefore = await authService.login({
      email: fakeUser.email,
      password: 'password-vieja',
    });
    const jwtBefore = loginBefore.accessToken;

    const decodedBefore = await jwtService.verifyAsync(jwtBefore, { secret: TEST_JWT_SECRET });
    expect(decodedBefore.tokenVersion).toBe(0);

    // ---- 2. JWT #1 se acepta ANTES del reset ----
    const authenticatedBefore = await authenticate(jwtBefore);
    expect(authenticatedBefore).toMatchObject({ sub: fakeUser.id });

    // ---- 3. Reset exitoso: tokenVersion se incrementa de verdad ----
    expect(fakeUser.tokenVersion).toBe(0);
    const resetResult = await authService.resetPassword({
      token: rawResetToken,
      password: 'password-nueva',
    });
    expect(resetResult).toEqual({ message: expect.any(String) });
    expect(fakeUser.tokenVersion).toBe(1);
    expect(bcrypt.compareSync('password-nueva', fakeUser.passwordHash)).toBe(true);

    // ---- 4. JWT #1 (emitido antes del reset) ahora se RECHAZA — mismo token, sin volver a
    // construir el payload a mano: la verificación de firma sigue pasando (el token no cambió),
    // lo que cambia es que JwtStrategy.validate() compara tokenVersion contra el usuario YA
    // actualizado. ----
    await expect(authenticate(jwtBefore)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authenticate(jwtBefore)).rejects.toMatchObject({
      message: expect.stringContaining('Sesión inválida'),
    });

    // ---- 5. Login con la password nueva: emite JWT #2 (tokenVersion=1) ----
    const loginAfter = await authService.login({
      email: fakeUser.email,
      password: 'password-nueva',
    });
    const jwtAfter = loginAfter.accessToken;
    expect(jwtAfter).not.toBe(jwtBefore);

    const decodedAfter = await jwtService.verifyAsync(jwtAfter, { secret: TEST_JWT_SECRET });
    expect(decodedAfter.tokenVersion).toBe(1);

    // ---- 6. JWT #2 se acepta ----
    const authenticatedAfter = await authenticate(jwtAfter);
    expect(authenticatedAfter).toMatchObject({ sub: fakeUser.id });

    // ---- 7. La password anterior queda rechazada en login ----
    await expect(
      authService.login({ email: fakeUser.email, password: 'password-vieja' }),
    ).rejects.toMatchObject({ message: 'Credenciales inválidas.' });
  });
});
