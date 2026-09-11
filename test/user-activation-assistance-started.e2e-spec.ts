// MEASUREMENT GAP P1-06 ("Self-service frente a asistencia"): set-once real de
// User.activationAssistanceStartedAt vía UsersService.markActivationAssistanceStarted, la
// migración 1789156202657 en sí, y la auditoría exactamente-una-vez de
// AdminService.markActivationAssistanceStarted — contra PostgreSQL real, en una base aislada y
// desechable creada por esta misma ejecución (nunca `agro_score` ni las variables DB_* generales
// del backend, ver test/support/isolated-postgres-database.ts).
//
// Por qué un test aparte de users.service.spec.ts/admin.service.spec.ts (unitarios, con repos
// mockeados): un mock puede demostrar que el service arma el UPDATE con el guard
// `"activationAssistanceStartedAt" IS NULL` y que AdminService decide auditar según `wasNewlySet`,
// pero no puede demostrar que Postgres real serializa dos llamadas concurrentes disputando la
// misma fila y que, de esa carrera real, sale EXACTAMENTE una entrada de auditoría (nunca dos, una
// por cada llamada que "cree" haber ganado).
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { AddUserActivationAssistanceStartedAt1789156202657 } from '../src/migrations/1789156202657-AddUserActivationAssistanceStartedAt';
import { AccessRequest } from '../src/access-request/entities/access-request.entity';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { AnalysisTechnicalVerdict } from '../src/analysis-verdict/entities/analysis-technical-verdict.entity';
import { AdminService } from '../src/admin/admin.service';
import { AuditLogService } from '../src/audit-log/audit-log.service';
import { AdminAuditLog } from '../src/audit-log/entities/admin-audit-log.entity';
import { EmailService } from '../src/email/email.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { FieldAnalysisSchedule } from '../src/scheduled-analysis/entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from '../src/scheduled-analysis/entities/field-analysis-schedule-status-transition.entity';
import { ScheduledAnalysisRun } from '../src/scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from '../src/scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { PasswordResetToken } from '../src/users/entities/password-reset-token.entity';
import { UserInvitation } from '../src/users/entities/user-invitation.entity';
import { User } from '../src/users/user.entity';
import { UsersService } from '../src/users/users.service';
import { WeeklyTechnicalVerdictService } from '../src/weekly-technical-verdict/weekly-technical-verdict.service';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

// Repos que AdminService/AuditLogService no ejercitan en este archivo — solo deben existir como
// provider para que Nest arme el módulo (mismo criterio que
// product-analytics-north-star-eligibility.e2e-spec.ts).
function noopRepo() {
  return {
    count: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: unknown) => v),
    createQueryBuilder: jest.fn(),
    manager: { query: jest.fn().mockResolvedValue([]) },
  };
}

describe('MEASUREMENT GAP P1-06 — migración 1789156202657 sobre User preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'activation_assistance_migration',
    );
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [User],
      synchronize: true, // esquema completo desde la entidad real (ya incluye activationAssistanceStartedAt).
    });
    await dataSource.initialize();

    // Simula el esquema "de antes del rollout": la única diferencia real es esta columna — se
    // elimina manualmente para que la migración de abajo tenga algo genuino que agregar.
    await dataSource.query(
      `ALTER TABLE "users" DROP COLUMN "activationAssistanceStartedAt"`,
    );
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

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
        'Fallo(s) durante la limpieza de esta suite — ver causas.',
      );
    }
  });

  it('up() agrega la columna sin tocar filas preexistentes (quedan NULL); down() la elimina sin tocar nada más', async () => {
    const ds = dataSource as DataSource;

    const [preexistingUser] = await ds.query(
      `INSERT INTO "users" ("email", "passwordHash", "fullName", "role", "isActive")
       VALUES ($1, $2, $3, 'user', true) RETURNING "id"`,
      ['gap-p1-06-user@example.com', 'hash-no-usado', 'Usuario preexistente'],
    );

    const migration = new AddUserActivationAssistanceStartedAt1789156202657();
    const queryRunner = ds.createQueryRunner();

    try {
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    const [afterUp] = await ds.query(
      `SELECT "activationAssistanceStartedAt", "email", "fullName" FROM "users" WHERE "id" = $1`,
      [preexistingUser.id],
    );
    expect(afterUp.activationAssistanceStartedAt).toBeNull(); // preexistente: sin cobertura histórica conocida.
    expect(afterUp.email).toBe('gap-p1-06-user@example.com'); // ninguna otra columna se tocó.
    expect(afterUp.fullName).toBe('Usuario preexistente');

    // Columna aceptando escritura real para filas NUEVAS.
    await ds.query(
      `UPDATE "users" SET "activationAssistanceStartedAt" = now() WHERE "id" = $1`,
      [preexistingUser.id],
    );
    const [afterWrite] = await ds.query(
      `SELECT "activationAssistanceStartedAt" FROM "users" WHERE "id" = $1`,
      [preexistingUser.id],
    );
    expect(afterWrite.activationAssistanceStartedAt).not.toBeNull();

    const queryRunnerDown = ds.createQueryRunner();
    try {
      await migration.down(queryRunnerDown);
    } finally {
      await queryRunnerDown.release();
    }

    const columns: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain(
      'activationAssistanceStartedAt',
    );

    // down() no borró la fila ni ninguna otra columna — solo la nueva.
    const [afterDown] = await ds.query(
      `SELECT "email", "fullName" FROM "users" WHERE "id" = $1`,
      [preexistingUser.id],
    );
    expect(afterDown.email).toBe('gap-p1-06-user@example.com');
    expect(afterDown.fullName).toBe('Usuario preexistente');
  });
});

describe('MEASUREMENT GAP P1-06 — markActivationAssistanceStarted set-once real (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let usersService: UsersService;
  let adminService: AdminService;
  let userRepo: Repository<User>;
  let auditLogRepo: Repository<AdminAuditLog>;
  let dataSource: DataSource;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(
      target,
      'activation_assistance_service',
    );
    createdDatabaseName = created.name;

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          database: createdDatabaseName,
          entities: [User, AdminAuditLog],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([User, AdminAuditLog]),
      ],
      providers: [
        UsersService, // real — la atomicidad del UPDATE set-once es justo lo que se quiere probar.
        AuditLogService, // real — se quiere confirmar la fila realmente persistida, no un mock.
        AdminService, // real — orquesta ambos: decide SI auditar según wasNewlySet.
        { provide: EmailService, useValue: {} },
        { provide: PythonWorkerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: getRepositoryToken(Field), useValue: noopRepo() },
        { provide: getRepositoryToken(FieldLot), useValue: noopRepo() },
        { provide: getRepositoryToken(Analysis), useValue: noopRepo() },
        {
          provide: getRepositoryToken(AnalysisTechnicalVerdict),
          useValue: noopRepo(),
        },
        {
          provide: getRepositoryToken(FieldAnalysisSchedule),
          useValue: noopRepo(),
        },
        {
          provide: getRepositoryToken(ScheduledAnalysisRun),
          useValue: noopRepo(),
        },
        {
          provide: getRepositoryToken(WeeklyAnalysisSnapshot),
          useValue: noopRepo(),
        },
        {
          provide: getRepositoryToken(FieldAnalysisScheduleStatusTransition),
          useValue: noopRepo(),
        },
        { provide: getRepositoryToken(AccessRequest), useValue: noopRepo() },
        { provide: getRepositoryToken(UserInvitation), useValue: noopRepo() },
        {
          provide: getRepositoryToken(PasswordResetToken),
          useValue: noopRepo(),
        },
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: { findResponsesByScheduledRunIds: jest.fn() },
        },
        {
          provide: AnalysisVerdictService,
          useValue: { generateAndPersist: jest.fn() },
        },
      ],
    }).compile();

    usersService = moduleRef.get(UsersService);
    adminService = moduleRef.get(AdminService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    auditLogRepo = moduleRef.get(getRepositoryToken(AdminAuditLog));
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (moduleRef) {
      try {
        await moduleRef.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

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
        'Fallo(s) durante la limpieza de esta suite — ver causas.',
      );
    }
  });

  async function seedUser(overrides: Partial<User> = {}): Promise<User> {
    seedCounter += 1;
    return userRepo.save(
      userRepo.create({
        email: `activation-assistance-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado',
        fullName: `Usuario ${seedCounter}`,
        ...overrides,
      }),
    );
  }

  describe('UsersService.markActivationAssistanceStarted — atomicidad', () => {
    it('CONCURRENCIA REAL — dos llamadas concurrentes sobre el mismo usuario dejan EXACTAMENTE un timestamp, ambas responden éxito con el mismo valor', async () => {
      const user = await seedUser();

      const [resultA, resultB] = await Promise.all([
        usersService.markActivationAssistanceStarted(user.id),
        usersService.markActivationAssistanceStarted(user.id),
      ]);

      // Exactamente una de las dos ganó la carrera — nunca ambas a la vez (eso sería el bug que
      // este test existe para detectar).
      expect(
        [resultA.wasNewlySet, resultB.wasNewlySet].filter(Boolean),
      ).toHaveLength(1);
      expect(resultA.user.activationAssistanceStartedAt).toEqual(
        resultB.user.activationAssistanceStartedAt,
      );

      const persisted = await userRepo.findOneOrFail({
        where: { id: user.id },
      });
      expect(persisted.activationAssistanceStartedAt).not.toBeNull();
    });

    it('reutilización secuencial: la segunda llamada responde éxito, wasNewlySet=false, y conserva el timestamp original sin reescribirlo', async () => {
      const user = await seedUser();

      const first = await usersService.markActivationAssistanceStarted(user.id);
      const second = await usersService.markActivationAssistanceStarted(
        user.id,
      );

      expect(first.wasNewlySet).toBe(true);
      expect(second.wasNewlySet).toBe(false);
      expect(second.user.activationAssistanceStartedAt).toEqual(
        first.user.activationAssistanceStartedAt,
      );
    });

    it('usa el timestamp del SERVIDOR (now() de Postgres) — el valor persistido cae dentro de una ventana real alrededor de la llamada, nunca un valor arbitrario', async () => {
      const user = await seedUser();

      // Bracket de "antes/después" tomado DENTRO de Postgres, con el mismo cast a `timestamp`
      // (sin zona) que usa la columna — mismo criterio ya documentado en
      // weekly-analysis-snapshot-viewed.e2e-spec.ts / analysis-result-viewed.e2e-spec.ts.
      const [{ n: beforeRaw }]: Array<{ n: Date }> = await dataSource.query(
        'SELECT now()::timestamp AS n',
      );
      const before = beforeRaw.getTime();

      const result = await usersService.markActivationAssistanceStarted(
        user.id,
      );

      const [{ n: afterRaw }]: Array<{ n: Date }> = await dataSource.query(
        'SELECT now()::timestamp AS n',
      );
      const after = afterRaw.getTime();

      const markedAtMs = (
        result.user.activationAssistanceStartedAt as Date
      ).getTime();
      expect(markedAtMs).toBeGreaterThanOrEqual(before);
      expect(markedAtMs).toBeLessThanOrEqual(after);
    });

    it('ninguna otra columna del usuario cambia como efecto de markActivationAssistanceStarted', async () => {
      const user = await seedUser({ fullName: 'No debe cambiar' });

      await usersService.markActivationAssistanceStarted(user.id);

      const persisted = await userRepo.findOneOrFail({
        where: { id: user.id },
      });
      expect(persisted.email).toBe(user.email);
      expect(persisted.fullName).toBe('No debe cambiar');
      expect(persisted.role).toBe(user.role);
      expect(persisted.isActive).toBe(user.isActive);
    });
  });

  describe('AdminService.markActivationAssistanceStarted — auditoría exactamente-una-vez por transición efectiva', () => {
    // AdminAuditLog.actorUserId lleva una FK real hacia "users" — el actor de auditoría tiene que
    // ser un usuario efectivamente persistido (mismo criterio que el owner/admin real que ejecuta
    // la acción en producción), nunca un id inventado.
    async function seedActor(): Promise<{
      actorUserId: string;
      ip: string;
      userAgent: string;
    }> {
      const adminUser = await seedUser({ fullName: 'Admin actor' });
      return { actorUserId: adminUser.id, ip: '127.0.0.1', userAgent: 'jest' };
    }

    it('CONCURRENCIA REAL — dos llamadas admin concurrentes sobre el mismo usuario producen EXACTAMENTE una entrada de auditoría, con el actor y el target correctos', async () => {
      const user = await seedUser();
      const actor = await seedActor();

      await Promise.all([
        adminService.markActivationAssistanceStarted(user.id, actor),
        adminService.markActivationAssistanceStarted(user.id, actor),
      ]);

      const entries = await auditLogRepo.find({
        where: {
          targetId: user.id,
          action: 'admin.user.activation_assistance_started',
        },
      });
      expect(entries).toHaveLength(1); // nunca dos, aunque ambas llamadas "respondieron éxito".
      expect(entries[0].actorUserId).toBe(actor.actorUserId);
      expect(entries[0].targetType).toBe('user');
      expect(entries[0].targetId).toBe(user.id);
    });

    it('repetir la operación (secuencial, sobre un usuario ya marcado) no fabrica una segunda entrada de auditoría', async () => {
      const user = await seedUser();
      const actor = await seedActor();

      await adminService.markActivationAssistanceStarted(user.id, actor);
      await adminService.markActivationAssistanceStarted(user.id, actor);
      await adminService.markActivationAssistanceStarted(user.id, actor);

      const entries = await auditLogRepo.find({
        where: {
          targetId: user.id,
          action: 'admin.user.activation_assistance_started',
        },
      });
      expect(entries).toHaveLength(1);
    });

    it('NEGATIVO: usuario inexistente — 404 real, sin escribir ni auditar', async () => {
      const actor = await seedActor();

      await expect(
        adminService.markActivationAssistanceStarted(
          '00000000-0000-0000-0000-000000000000',
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Filtra por este actor puntual (seedActor() generó un usuario nuevo, único a esta prueba) —
      // así el aserto no se ve afectado por las entradas ya creadas por otras pruebas de este
      // mismo describe, que comparten tabla pero no comparten actor.
      const entries = await auditLogRepo.find({
        where: {
          actorUserId: actor.actorUserId,
          action: 'admin.user.activation_assistance_started',
        },
      });
      expect(entries).toHaveLength(0);
    });
  });
});
