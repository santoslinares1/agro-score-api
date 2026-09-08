// F03: consumo atómico de tokens de recuperación de contraseña.
//
// Esta suite atraviesa AuthService.resetPassword() REAL (sin mockear UsersService,
// AuditLogService, JwtService ni las escrituras a DB) contra una base PostgreSQL aislada y
// desechable, creada por esta misma ejecución con un nombre único (ver
// test/support/isolated-postgres-database.ts) — nunca contra `agro_score` ni contra las
// variables DB_* generales del backend. El destino de test se configura explícitamente vía
// TEST_DB_HOST/TEST_DB_PORT/TEST_DB_USER/TEST_DB_PASSWORD; sin esas variables, la suite falla al
// arrancar con un mensaje accionable en vez de improvisar sobre un servidor desconocido.
//
// Por qué un test aparte de auth.service.spec.ts (unitario, con repos mockeados): un mock no
// puede demostrar que Postgres realmente serializa dos transacciones que compiten por la misma
// fila, ni que un rollback real deshace las tres escrituras juntas después de que ya ocurrieron.
// Correr acá, vía `npm run test:e2e`, separado de la suite unitaria por defecto — necesita
// Docker/Postgres corriendo y variables TEST_DB_* configuradas, cosa que un `npm test` normal no
// debería requerir.
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../src/audit-log/audit-log.service';
import { AdminAuditLog } from '../src/audit-log/entities/admin-audit-log.entity';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { generateToken, hashToken } from '../src/auth/token.util';
import { PasswordResetToken } from '../src/users/entities/password-reset-token.entity';
import { UserInvitation } from '../src/users/entities/user-invitation.entity';
import { User } from '../src/users/user.entity';
import { UserRole } from '../src/users/user-role.enum';
import { UsersService } from '../src/users/users.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

/**
 * Espera (con timeout y polling acotado, nunca un sleep fijo usado como prueba en sí) a que
 * `pg_stat_activity` muestre al menos una conexión de `databaseName` bloqueada esperando un lock
 * (`wait_event_type = 'Lock'`). Esta es la evidencia real de contención: no una suposición de
 * timing, sino una observación directa del estado interno de Postgres. Usa una conexión de
 * observación INDEPENDIENTE de las que compiten por el lock (pg_stat_activity es visible desde
 * cualquier conexión al mismo servidor, sin necesidad de conectarse a `databaseName` en sí).
 */
async function waitForLockContention(
  observer: DataSource,
  databaseName: string,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const rows: Array<{ count: string }> = await observer.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = $1
         AND wait_event_type = 'Lock'`,
      [databaseName],
    );

    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `No se observó ninguna conexión de "${databaseName}" esperando un lock en ` +
          `pg_stat_activity dentro de ${options.timeoutMs}ms — la contención esperada no se ` +
          'produjo (o no se pudo observar), así que este test no puede afirmar que hubo una ' +
          'carrera real por el lock de fila.',
      );
    }

    // Cadencia de polling, NO la evidencia — la evidencia es la fila de pg_stat_activity de
    // arriba. Un timeout acotado (no un sleep fijo) es lo que decide si el test falla.
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

describe('F03 — atomicidad de AuthService.resetPassword (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let observerDataSource: DataSource | undefined;
  let moduleRef: TestingModule | undefined;

  let authService: AuthService;
  let usersService: UsersService;
  let jwtStrategy: JwtStrategy;
  let userRepo: Repository<User>;
  let tokenRepo: Repository<PasswordResetToken>;
  let auditLogRepo: Repository<AdminAuditLog>;
  let seedCounter = 0;

  beforeAll(async () => {
    // Configuración EXPLÍCITA del destino de test — nunca las DB_* generales del backend. Si
    // faltan, esto lanza acá mismo, antes de crear absolutamente nada.
    target = resolveExplicitTestDatabaseTarget();

    // Nombre único por ejecución, sin ningún DROP preventivo — ver isolated-postgres-database.ts.
    const created = await createIsolatedTestDatabase(
      target,
      'f03_reset_atomicity',
    );
    createdDatabaseName = created.name;

    // Conexión de SOLO OBSERVACIÓN para pg_stat_activity — nunca escribe, nunca compite por el
    // lock que se está probando. Conectada a la base de mantenimiento (no a `createdDatabaseName`
    // en sí): pg_stat_activity es visible para todo el servidor desde cualquier base.
    observerDataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: target.adminDatabase,
    });
    await observerDataSource.initialize();

    process.env.JWT_SECRET =
      process.env.JWT_SECRET ||
      'f03-test-secret-solo-para-esta-suite-nunca-real';

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          database: createdDatabaseName,
          entities: [User, PasswordResetToken, AdminAuditLog, UserInvitation],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          User,
          PasswordResetToken,
          AdminAuditLog,
          UserInvitation,
        ]),
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      providers: [AuthService, UsersService, AuditLogService, JwtStrategy],
    }).compile();

    authService = moduleRef.get(AuthService);
    usersService = moduleRef.get(UsersService);
    jwtStrategy = moduleRef.get(JwtStrategy);
    userRepo = moduleRef.get(getRepositoryToken(User));
    tokenRepo = moduleRef.get(getRepositoryToken(PasswordResetToken));
    auditLogRepo = moduleRef.get(getRepositoryToken(AdminAuditLog));
  });

  afterAll(async () => {
    // Cerrar conexiones PROPIAS primero, siempre — nunca se intenta el DROP con conexiones
    // propias todavía abiertas, y nunca se usa WITH (FORCE) para saltarse este orden.
    const cleanupErrors: unknown[] = [];

    if (moduleRef) {
      try {
        await moduleRef.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (observerDataSource?.isInitialized) {
      try {
        await observerDataSource.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    // Solo se borra la base si ESTA ejecución la creó (createdDatabaseName no es null). Si el
    // setup falló a mitad de camino después de crearla, igual se limpia acá — es exactamente el
    // recurso propio de esta ejecución, no uno ajeno.
    if (createdDatabaseName) {
      try {
        await dropIsolatedTestDatabase(target, createdDatabaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Fallo(s) durante la limpieza de recursos de la suite F03 — ver causas.',
      );
    }
  });

  /** Cada test crea su propio usuario + token — nunca comparten fila, así que no hace falta
   * truncar la base entre tests para mantenerlos independientes entre sí. */
  async function seedUserWithResetToken(
    overrides: Partial<Pick<User, 'tokenVersion' | 'isActive'>> = {},
  ): Promise<{ user: User; rawToken: string }> {
    seedCounter += 1;

    const user = await userRepo.save(
      userRepo.create({
        email: `f03-test-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: await bcrypt.hash('password-original-123', 10),
        fullName: 'Usuario de prueba F03',
        role: UserRole.USER,
        isActive: overrides.isActive ?? true,
        tokenVersion: overrides.tokenVersion ?? 0,
      }),
    );

    const rawToken = generateToken();
    await tokenRepo.save(
      tokenRepo.create({
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        usedAt: null,
      }),
    );

    return { user, rawToken };
  }

  it('CASO 1 — reset normal: password nueva válida, usedAt persistido y tokenVersion incrementado exactamente una vez', async () => {
    const { user, rawToken } = await seedUserWithResetToken();

    const result = await authService.resetPassword({
      token: rawToken,
      password: 'password-nueva-valida-1',
    });

    expect(result).toEqual({ message: expect.any(String) });

    const updatedUser = await userRepo.findOneByOrFail({ id: user.id });
    expect(
      await bcrypt.compare('password-nueva-valida-1', updatedUser.passwordHash),
    ).toBe(true);
    expect(updatedUser.tokenVersion).toBe(user.tokenVersion + 1);

    const consumedToken = await tokenRepo.findOneByOrFail({ userId: user.id });
    expect(consumedToken.usedAt).not.toBeNull();
  });

  it('CASO 2 — dos consumos con contención REAL y determinista del lock de fila: la primera transacción retiene el lock, la segunda queda observablemente esperando en pg_stat_activity, y solo al liberar/confirmar la primera la segunda rechaza el token ya consumido', async () => {
    const { user, rawToken } = await seedUserWithResetToken();
    const passwordA = 'password-de-A-11111';
    const passwordB = 'password-de-B-22222';

    // Instrumentación de TEST (no de producción): pausa la transacción ganadora justo DESPUÉS de
    // que ya tomó el lock de fila (SELECT ... FOR UPDATE ya corrió y el token ya se guardó con
    // usedAt dentro de esa misma transacción — ver AuthService.resetPassword) y ANTES de que
    // escriba passwordHash/tokenVersion y confirme. Mientras esta pausa está activa, la
    // transacción sigue abierta reteniendo el lock real de Postgres — es la ventana que permite
    // observar a la perdedora bloqueada de verdad, no simulada.
    let releaseGate!: () => void;
    let gateReleased = false;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const ensureGateReleased = () => {
      if (!gateReleased) {
        gateReleased = true;
        releaseGate();
      }
    };

    // updatePassword() SÍ se ejecuta de verdad (con el manager transaccional real) — la
    // instrumentación solo demora el momento en que se la llama, nunca reemplaza su
    // implementación ni el mecanismo productivo (SELECT ... FOR UPDATE, misma transacción, etc.).
    const originalUpdatePassword =
      usersService.updatePassword.bind(usersService);
    const updatePasswordSpy = jest
      .spyOn(usersService, 'updatePassword')
      .mockImplementationOnce(async (...args) => {
        await gate;
        return originalUpdatePassword(...args);
      });

    let settledPromise:
      | Promise<
          [
            PromiseSettledResult<{ message: string }>,
            PromiseSettledResult<{ message: string }>,
          ]
        >
      | undefined;

    try {
      settledPromise = Promise.allSettled([
        authService.resetPassword({ token: rawToken, password: passwordA }),
        authService.resetPassword({ token: rawToken, password: passwordB }),
      ]);

      // Evidencia real de contención: mientras la ganadora está pausada en el gate (reteniendo el
      // lock), pg_stat_activity debe mostrar a la otra conexión esperando ese lock. Timeout
      // acotado — si esto no se observa, el test falla explícitamente en vez de asumir que hubo
      // una carrera.
      await waitForLockContention(
        observerDataSource as DataSource,
        createdDatabaseName as string,
        { timeoutMs: 5_000, pollIntervalMs: 50 },
      );
    } finally {
      // Se libera el gate SIEMPRE, incluso si la espera de arriba falló por timeout — nunca se
      // deja una transacción abierta colgando de un assertion fallido.
      ensureGateReleased();
    }

    const [outcomeA, outcomeB] = await settledPromise;
    updatePasswordSpy.mockRestore();

    const fulfilled = [outcomeA, outcomeB].filter(
      (o): o is PromiseFulfilledResult<{ message: string }> =>
        o.status === 'fulfilled',
    );
    const rejected = [outcomeA, outcomeB].filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    // Error público controlado, no una excepción de infraestructura ni un detalle SQL.
    expect(String(rejected[0].reason.message)).not.toMatch(
      /sql|constraint|duplicate key/i,
    );

    const updatedUser = await userRepo.findOneByOrFail({ id: user.id });
    expect(updatedUser.tokenVersion).toBe(user.tokenVersion + 1); // exactamente UN incremento

    // La contraseña final corresponde ESPECÍFICAMENTE a la operación que fue fulfilled — no
    // "alguna de las dos", sino la identificada por índice (outcomeA=índice 0=passwordA).
    const winnerPassword =
      outcomeA.status === 'fulfilled' ? passwordA : passwordB;
    const loserPassword =
      outcomeA.status === 'fulfilled' ? passwordB : passwordA;

    expect(await bcrypt.compare(winnerPassword, updatedUser.passwordHash)).toBe(
      true,
    );
    expect(await bcrypt.compare(loserPassword, updatedUser.passwordHash)).toBe(
      false,
    );

    const tokens = await tokenRepo.find({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1); // no se duplicó ninguna fila
    expect(tokens[0].usedAt).not.toBeNull();
  });

  it('CASO 3 — reutilización secuencial de un token ya consumido: rechazo sin cambios de estado', async () => {
    const { user, rawToken } = await seedUserWithResetToken();
    await authService.resetPassword({
      token: rawToken,
      password: 'primer-uso-123456',
    });

    const userAfterFirst = await userRepo.findOneByOrFail({ id: user.id });

    await expect(
      authService.resetPassword({
        token: rawToken,
        password: 'segundo-uso-789012',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const userAfterSecond = await userRepo.findOneByOrFail({ id: user.id });
    expect(userAfterSecond.passwordHash).toBe(userAfterFirst.passwordHash);
    expect(userAfterSecond.tokenVersion).toBe(userAfterFirst.tokenVersion);
  });

  it('CASO 4 — token inexistente o vencido: rechazo sin cambios', async () => {
    const { user } = await seedUserWithResetToken();

    await expect(
      authService.resetPassword({
        token: 'este-token-no-existe-en-ningun-lado',
        password: 'x12345678',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const expiredRawToken = generateToken();
    await tokenRepo.save(
      tokenRepo.create({
        userId: user.id,
        tokenHash: hashToken(expiredRawToken),
        expiresAt: new Date(Date.now() - 60_000), // ya vencido
        usedAt: null,
      }),
    );

    await expect(
      authService.resetPassword({
        token: expiredRawToken,
        password: 'x12345678',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const untouchedUser = await userRepo.findOneByOrFail({ id: user.id });
    expect(untouchedUser.passwordHash).toBe(user.passwordHash);
    expect(untouchedUser.tokenVersion).toBe(user.tokenVersion);
  });

  it('CASO 5/6 — un fallo forzado DESPUÉS de escribir usedAt/passwordHash/tokenVersion (verificado dentro de la misma transacción) revierte las tres piezas juntas; el token sigue siendo válido después para un nuevo intento', async () => {
    const { user, rawToken } = await seedUserWithResetToken();

    let observedInsideTransaction: {
      usedAt: Date | null;
      passwordHash: string;
      tokenVersion: number;
    } | null = null;

    // updatePassword() se ejecuta REAL (con el manager transaccional que AuthService.resetPassword
    // le pasa) — nada se simula. Recién DESPUÉS de que esa escritura real ocurrió, se lee (con el
    // MISMO manager, o sea dentro de la transacción todavía abierta) el estado de usedAt/
    // passwordHash/tokenVersion para demostrar que las tres piezas ya cambiaron — y solo entonces
    // se fuerza el fallo, antes de que la transacción llegue a confirmar.
    const originalUpdatePassword =
      usersService.updatePassword.bind(usersService);
    const updatePasswordSpy = jest
      .spyOn(usersService, 'updatePassword')
      .mockImplementationOnce(async (id, passwordHash, manager) => {
        const updateResult = await originalUpdatePassword(
          id,
          passwordHash,
          manager,
        );
        expect(updateResult.affected).toBe(1); // la escritura real afectó una fila, no cero.

        if (!manager) {
          throw new Error(
            'Instrumentación F03: se esperaba un EntityManager transaccional — si esto falla, ' +
              'AuthService.resetPassword dejó de pasarle el manager a updatePassword().',
          );
        }

        const userRowInTx = await manager
          .getRepository(User)
          .findOneByOrFail({ id });
        const tokenRowInTx = await manager
          .getRepository(PasswordResetToken)
          .findOneByOrFail({ userId: id });

        observedInsideTransaction = {
          usedAt: tokenRowInTx.usedAt,
          passwordHash: userRowInTx.passwordHash,
          tokenVersion: userRowInTx.tokenVersion,
        };

        throw new Error(
          'Fallo forzado por el test — DESPUÉS de escribir las tres piezas, ANTES del commit.',
        );
      });

    await expect(
      authService.resetPassword({
        token: rawToken,
        password: 'no-deberia-persistir-nunca-1',
      }),
    ).rejects.toThrow('Fallo forzado por el test');

    // Si esto fuera null, la verificación de "las tres piezas ya habían cambiado dentro de la
    // transacción" nunca habría ocurrido, y el resto del test sería vacuo.
    if (!observedInsideTransaction) {
      throw new Error(
        'La instrumentación nunca observó el estado dentro de la transacción — el test no puede continuar.',
      );
    }
    const inside: {
      usedAt: Date | null;
      passwordHash: string;
      tokenVersion: number;
    } = observedInsideTransaction;
    expect(inside.usedAt).not.toBeNull();
    expect(inside.tokenVersion).toBe(user.tokenVersion + 1);
    expect(
      await bcrypt.compare('no-deberia-persistir-nunca-1', inside.passwordHash),
    ).toBe(true);

    // Desde AFUERA de la transacción (ya revertida), las tres piezas volvieron EXACTAMENTE al
    // estado inicial — este es el rollback real, no una lectura mockeada.
    const untouchedUser = await userRepo.findOneByOrFail({ id: user.id });
    expect(untouchedUser.passwordHash).toBe(user.passwordHash);
    expect(untouchedUser.tokenVersion).toBe(user.tokenVersion);

    const untouchedToken = await tokenRepo.findOneByOrFail({ userId: user.id });
    expect(untouchedToken.usedAt).toBeNull();

    // No se registró un reset exitoso para una operación revertida.
    const auditRowsAfterFailure = await auditLogRepo.find({
      where: { targetId: user.id, action: 'auth.password_reset.completed' },
    });
    expect(auditRowsAfterFailure).toHaveLength(0);

    updatePasswordSpy.mockRestore();

    // Tras el rollback, el mismo token (todavía sin usar) completa un intento normal.
    const result = await authService.resetPassword({
      token: rawToken,
      password: 'ahora-si-funciona-123456',
    });
    expect(result).toEqual({ message: expect.any(String) });

    const finalUser = await userRepo.findOneByOrFail({ id: user.id });
    expect(
      await bcrypt.compare('ahora-si-funciona-123456', finalUser.passwordHash),
    ).toBe(true);
    // Un solo incremento NETO en total: el intento fallido escribió tokenVersion+1 dentro de su
    // transacción (confirmado arriba), pero esa transacción se revirtió completa — no cuenta.
    expect(finalUser.tokenVersion).toBe(user.tokenVersion + 1);

    const auditRowsAfterSuccess = await auditLogRepo.find({
      where: { targetId: user.id, action: 'auth.password_reset.completed' },
    });
    expect(auditRowsAfterSuccess).toHaveLength(1); // el intento exitoso sí quedó auditado.
  });

  // F03: alcance real de esta prueba — JwtStrategy.validate() recibe un payload ya decodificado y
  // compara payload.tokenVersion contra el valor persistido en DB. NO firma un JWT real, NO
  // verifica una firma criptográfica, y NO atraviesa el guard HTTP/Passport ni un request real —
  // esas capas (firma/verificación de JwtService, ExtractJwt, PassportStrategy) no forman parte
  // de este test. Lo que sí demuestra: la comparación de tokenVersion que hace `validate()`
  // efectivamente lee el valor que el reset acaba de incrementar en DB real (no un mock), y
  // rechaza/acepta en consecuencia — la mitad del mecanismo de invalidación de sesiones que le
  // corresponde a esta ficha (la otra mitad, la firma/verificación JWT, ya la cubre
  // jwt.strategy.spec.ts con mocks, sin relación con la atomicidad de resetPassword).
  it('CASO 7 — JwtStrategy.validate() (comparación de tokenVersion contra DB, sin firma/verificación JWT) rechaza un payload con el tokenVersion anterior tras un reset exitoso, y acepta uno con el tokenVersion nuevo', async () => {
    const { user, rawToken } = await seedUserWithResetToken();
    const oldPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };

    await authService.resetPassword({
      token: rawToken,
      password: 'password-post-reset-1',
    });

    await expect(jwtStrategy.validate(oldPayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const updatedUser = await userRepo.findOneByOrFail({ id: user.id });
    const newPayload = {
      ...oldPayload,
      tokenVersion: updatedUser.tokenVersion,
    };

    await expect(jwtStrategy.validate(newPayload)).resolves.toEqual({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  });
});
