import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { In, IsNull } from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
import { AnalysisTechnicalVerdict } from '../analysis-verdict/entities/analysis-technical-verdict.entity';
import {
  AuditActorContext,
  AuditLogService,
} from '../audit-log/audit-log.service';
import { AdminAuditLog } from '../audit-log/entities/admin-audit-log.entity';
import { EmailService } from '../email/email.service';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { FieldAnalysisSchedule } from '../scheduled-analysis/entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from '../scheduled-analysis/entities/field-analysis-schedule-status-transition.entity';
import { ScheduledAnalysisRun } from '../scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { UsersService } from '../users/users.service';
import { WeeklyTechnicalVerdictService } from '../weekly-technical-verdict/weekly-technical-verdict.service';
import { WeeklyTechnicalVerdictResponse } from '../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
import { AdminService } from './admin.service';
import {
  FIELD_DETAIL_ANALYSES_LIMIT,
  FIELD_DETAIL_RUNS_LIMIT,
} from './dto/admin-field-detail.dto';
import { USER_DETAIL_ANALYSES_LIMIT } from './dto/admin-user-detail.dto';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@agroscorelatam.com',
    passwordHash: 'hashed',
    fullName: 'Usuario de prueba',
    companyName: undefined,
    role: UserRole.USER,
    isActive: true,
    activationAssistanceStartedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildAccessRequest(
  overrides: Partial<AccessRequest> = {},
): AccessRequest {
  return {
    id: 'access-request-1',
    name: 'Lead de prueba',
    email: 'lead@example.com',
    organization: 'Campo QA',
    profile: 'producer' as AccessRequest['profile'],
    estimatedSurface: undefined,
    message: undefined,
    status: 'new',
    internalNotes: null,
    assignedToUserId: null,
    contactedAt: null,
    convertedAt: null,
    discardedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const actor: AuditActorContext = {
  actorUserId: 'admin-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

// Repos que AdminService no ejercita en la mayoría de estos tests — solo
// necesitan existir como providers para que Nest arme el módulo.
const noopRepo = () => ({
  count: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  create: jest.fn((v: unknown) => v),
  createQueryBuilder: jest.fn(),
  manager: { query: jest.fn().mockResolvedValue([{ count: 0 }]) },
});

describe('AdminService', () => {
  let service: AdminService;
  let usersService: jest.Mocked<UsersService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let emailService: jest.Mocked<EmailService>;
  let pythonWorkerService: jest.Mocked<PythonWorkerService>;
  let configService: jest.Mocked<ConfigService>;
  let accessRequestRepo: ReturnType<typeof noopRepo>;
  let invitationRepo: ReturnType<typeof noopRepo>;
  let passwordResetRepo: ReturnType<typeof noopRepo>;
  let fieldRepo: ReturnType<typeof noopRepo>;
  let fieldLotRepo: ReturnType<typeof noopRepo>;
  let analysisRepo: ReturnType<typeof noopRepo>;
  let analysisVerdictRepo: ReturnType<typeof noopRepo>;
  let fieldAnalysisScheduleRepo: ReturnType<typeof noopRepo>;
  let scheduledAnalysisRunRepo: ReturnType<typeof noopRepo>;
  let weeklyAnalysisSnapshotRepo: ReturnType<typeof noopRepo>;
  let fieldAnalysisScheduleTransitionRepo: ReturnType<typeof noopRepo>;
  let weeklyTechnicalVerdictService: jest.Mocked<
    Pick<WeeklyTechnicalVerdictService, 'findResponsesByScheduledRunIds'>
  >;
  let analysisVerdictService: jest.Mocked<
    Pick<AnalysisVerdictService, 'generateAndPersist'>
  >;

  beforeEach(async () => {
    accessRequestRepo = noopRepo();
    invitationRepo = noopRepo();
    passwordResetRepo = noopRepo();
    fieldRepo = noopRepo();
    fieldLotRepo = noopRepo();
    analysisRepo = noopRepo();
    analysisVerdictRepo = noopRepo();
    fieldAnalysisScheduleRepo = noopRepo();
    scheduledAnalysisRunRepo = noopRepo();
    weeklyAnalysisSnapshotRepo = noopRepo();
    fieldAnalysisScheduleTransitionRepo = noopRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            findByIds: jest.fn().mockResolvedValue([]),
            create: jest.fn(),
            update: jest.fn(),
            markActivationAssistanceStarted: jest.fn(),
            countActiveByRole: jest.fn(),
            toPublicUser: jest.fn((user: User) => {
              const { passwordHash: _passwordHash, ...publicUser } = user;
              return publicUser;
            }),
            findAllPaginated: jest.fn(),
            count: jest.fn(),
            countActive: jest.fn(),
            countCreatedSince: jest.fn(),
            listEligibleProducers: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            list: jest
              .fn()
              .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvitationEmail: jest.fn().mockResolvedValue({
              sent: true,
              provider: 'resend',
              dryRun: true,
            }),
            sendPasswordResetEmail: jest.fn().mockResolvedValue({
              sent: true,
              provider: 'resend',
              dryRun: true,
            }),
          },
        },
        {
          provide: PythonWorkerService,
          useValue: {
            checkHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        { provide: getRepositoryToken(Field), useValue: fieldRepo },
        { provide: getRepositoryToken(FieldLot), useValue: fieldLotRepo },
        { provide: getRepositoryToken(Analysis), useValue: analysisRepo },
        {
          provide: getRepositoryToken(AnalysisTechnicalVerdict),
          useValue: analysisVerdictRepo,
        },
        {
          provide: getRepositoryToken(FieldAnalysisSchedule),
          useValue: fieldAnalysisScheduleRepo,
        },
        {
          provide: getRepositoryToken(ScheduledAnalysisRun),
          useValue: scheduledAnalysisRunRepo,
        },
        {
          provide: getRepositoryToken(WeeklyAnalysisSnapshot),
          useValue: weeklyAnalysisSnapshotRepo,
        },
        {
          provide: getRepositoryToken(FieldAnalysisScheduleStatusTransition),
          useValue: fieldAnalysisScheduleTransitionRepo,
        },
        {
          provide: getRepositoryToken(AccessRequest),
          useValue: accessRequestRepo,
        },
        { provide: getRepositoryToken(AdminAuditLog), useValue: noopRepo() },
        {
          provide: getRepositoryToken(UserInvitation),
          useValue: invitationRepo,
        },
        {
          provide: getRepositoryToken(PasswordResetToken),
          useValue: passwordResetRepo,
        },
        {
          provide: WeeklyTechnicalVerdictService,
          useValue: {
            findResponsesByScheduledRunIds: jest
              .fn()
              .mockResolvedValue(new Map()),
          },
        },
        {
          provide: AnalysisVerdictService,
          useValue: {
            generateAndPersist: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(AdminService);
    usersService = module.get(UsersService);
    auditLogService = module.get(AuditLogService);
    emailService = module.get(EmailService);
    pythonWorkerService = module.get(PythonWorkerService);
    configService = module.get(ConfigService);
    weeklyTechnicalVerdictService = module.get(WeeklyTechnicalVerdictService);
    analysisVerdictService = module.get(AnalysisVerdictService);
  });

  describe('createUser', () => {
    it('hashea la password, nunca devuelve passwordHash y audita admin.user.created', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN }),
      );

      const result = await service.createUser(
        {
          fullName: 'Nuevo Admin',
          email: 'nuevo@agroscorelatam.com',
          password: 'temporal123',
          role: UserRole.ADMIN,
        },
        actor,
        UserRole.ADMIN,
      );

      expect(result).not.toHaveProperty('passwordHash');
      const createArgs = usersService.create.mock.calls[0][0];
      expect(createArgs.passwordHash).not.toBe('temporal123');

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ actor, action: 'admin.user.created' }),
      );
      const auditCall = auditLogService.record.mock.calls[0][0];
      expect(auditCall.after).not.toHaveProperty('passwordHash');
    });

    it('rechaza un email duplicado', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.createUser(
          {
            fullName: 'Dup',
            email: 'user@agroscorelatam.com',
            password: 'temporal123',
            role: UserRole.USER,
          },
          actor,
          UserRole.ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listUsers', () => {
    it('nunca devuelve passwordHash en los items', async () => {
      usersService.findAllPaginated.mockResolvedValue({
        items: [buildUser(), buildUser({ id: 'user-2' })],
        total: 2,
      });

      const result = await service.listUsers({ page: 1, limit: 20 });

      expect(result.items).toHaveLength(2);
      result.items.forEach((item) => {
        expect(item).not.toHaveProperty('passwordHash');
      });
    });

    it('Admin PR 2: reenvía userId a UsersService.findAllPaginated para trazabilidad', async () => {
      usersService.findAllPaginated.mockResolvedValue({ items: [], total: 0 });

      await service.listUsers({ page: 1, limit: 20, userId: 'user-1' });

      expect(usersService.findAllPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('Admin PR 2: no rompe si userId no viene (comportamiento normal)', async () => {
      usersService.findAllPaginated.mockResolvedValue({ items: [], total: 0 });

      await service.listUsers({ page: 1, limit: 20 });

      expect(usersService.findAllPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: undefined }),
      );
    });
  });

  describe('updateUser — auditoría', () => {
    it('audita admin.user.role_changed cuando cambia el rol', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.USER }),
      );
      usersService.countActiveByRole.mockResolvedValue(1);
      usersService.update.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN }),
      );

      await service.updateUser(
        'user-1',
        { role: UserRole.ADMIN },
        actor,
        UserRole.ADMIN,
      );

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.role_changed' }),
      );
    });

    it('audita admin.user.updated cuando cambian otros campos', async () => {
      usersService.findById.mockResolvedValue(buildUser());
      usersService.update.mockResolvedValue(
        buildUser({ fullName: 'Nuevo nombre' }),
      );

      await service.updateUser(
        'user-1',
        { fullName: 'Nuevo nombre' },
        actor,
        UserRole.ADMIN,
      );

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.updated' }),
      );
    });
  });

  describe('protección de último owner', () => {
    it('bloquea degradar de rol al último owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(0);

      await expect(
        service.updateUser(
          'user-1',
          { role: UserRole.ADMIN },
          actor,
          UserRole.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('permite degradar a un owner si hay otro owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(1);
      usersService.update.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN }),
      );

      await service.updateUser(
        'user-1',
        { role: UserRole.ADMIN },
        actor,
        UserRole.ADMIN,
      );

      expect(usersService.update).toHaveBeenCalled();
    });

    it('bloquea desactivar al último owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(0);

      await expect(
        service.deactivateUser('user-1', actor),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('permite desactivar a un usuario que no es owner y audita admin.user.deactivated', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN, isActive: true }),
      );
      usersService.update.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN, isActive: false }),
      );

      await service.deactivateUser('user-1', actor);

      expect(usersService.countActiveByRole).not.toHaveBeenCalled();
      expect(usersService.update).toHaveBeenCalledWith('user-1', {
        isActive: false,
      });
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.deactivated' }),
      );
    });
  });

  // MEASUREMENT GAP P1-06 ("Self-service frente a asistencia"): esta capa decide SI auditar (solo
  // en la transición efectiva) — la atomicidad del UPDATE set-once en sí ya está cubierta en
  // users.service.spec.ts y en el e2e contra Postgres real; acá se verifica delegación, el 404,
  // y que repetir la llamada nunca fabrique una segunda entrada de auditoría.
  describe('markActivationAssistanceStarted (MEASUREMENT GAP P1-06)', () => {
    it('404 si el usuario no existe — nunca llega a intentar el UPDATE', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        service.markActivationAssistanceStarted('id-inexistente', actor),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(usersService.markActivationAssistanceStarted).not.toHaveBeenCalled();
      expect(auditLogService.record).not.toHaveBeenCalled();
    });

    it('primera marca (transición real): audita admin.user.activation_assistance_started con actor y target correctos, y devuelve el usuario sin passwordHash/tokenVersion', async () => {
      const markedAt = new Date('2026-09-11T12:00:00.000Z');
      usersService.findById.mockResolvedValue(buildUser());
      usersService.markActivationAssistanceStarted.mockResolvedValue({
        user: buildUser({ activationAssistanceStartedAt: markedAt }),
        wasNewlySet: true,
      });

      const result = await service.markActivationAssistanceStarted(
        'user-1',
        actor,
      );

      expect(usersService.markActivationAssistanceStarted).toHaveBeenCalledWith(
        'user-1',
      );
      expect(auditLogService.record).toHaveBeenCalledTimes(1);
      expect(auditLogService.record).toHaveBeenCalledWith({
        actor,
        action: 'admin.user.activation_assistance_started',
        targetType: 'user',
        targetId: 'user-1',
        after: { activationAssistanceStartedAt: markedAt },
      });
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('tokenVersion');
      expect(result.activationAssistanceStartedAt).toEqual(markedAt);
    });

    it('usuario ya marcado (reutilización): responde éxito con el mismo timestamp pero NUNCA fabrica una segunda auditoría', async () => {
      const originalMark = new Date('2026-01-01T00:00:00.000Z');
      usersService.findById.mockResolvedValue(buildUser());
      usersService.markActivationAssistanceStarted.mockResolvedValue({
        user: buildUser({ activationAssistanceStartedAt: originalMark }),
        wasNewlySet: false,
      });

      const result = await service.markActivationAssistanceStarted(
        'user-1',
        actor,
      );

      expect(auditLogService.record).not.toHaveBeenCalled();
      expect(result.activationAssistanceStartedAt).toEqual(originalMark);
    });

    it('la firma no acepta timestamp/actor/mode del caller — solo (id, actor de auditoría)', () => {
      expect(service.markActivationAssistanceStarted.length).toBe(2);
    });

    it('nunca toca otros campos del usuario (no llama a usersService.update)', async () => {
      usersService.findById.mockResolvedValue(buildUser());
      usersService.markActivationAssistanceStarted.mockResolvedValue({
        user: buildUser({ activationAssistanceStartedAt: new Date() }),
        wasNewlySet: true,
      });

      await service.markActivationAssistanceStarted('user-1', actor);

      expect(usersService.update).not.toHaveBeenCalled();
    });
  });

  // SEC-001: solo un actor con role owner puede OTORGAR el role owner — a otro usuario o a sí
  // mismo — desde cualquiera de los 4 endpoints que aceptan un `role` de destino. Cubre los
  // cuatro entry points (createUser, updateUser, createInvitation, createUserFromAccessRequest)
  // con: (a) negativo — actor admin pidiendo owner se rechaza SIN ningún efecto secundario
  // (nada se persiste, nada se audita, ningún email sale); (b) control positivo — actor owner
  // pidiendo owner sigue funcionando igual que antes de este fix. Los casos "admin↔user sin
  // tocar owner" ya están cubiertos por los tests preexistentes de arriba (createUser con
  // role=ADMIN, updateUser cambiando fullName/role=ADMIN, deactivateUser) — no se duplican acá.
  describe('SEC-001 — otorgar rol owner', () => {
    describe('createUser', () => {
      it('actor admin pidiendo role owner se rechaza sin crear el usuario', async () => {
        usersService.findByEmail.mockResolvedValue(null);

        await expect(
          service.createUser(
            {
              fullName: 'Intento de escalación',
              email: 'escalador@agroscorelatam.com',
              password: 'temporal123',
              role: UserRole.OWNER,
            },
            actor,
            UserRole.ADMIN,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(usersService.create).not.toHaveBeenCalled();
        expect(auditLogService.record).not.toHaveBeenCalled();
      });

      it('actor owner pidiendo role owner sigue funcionando (control positivo)', async () => {
        usersService.findByEmail.mockResolvedValue(null);
        usersService.create.mockResolvedValue(
          buildUser({ role: UserRole.OWNER }),
        );

        const result = await service.createUser(
          {
            fullName: 'Nuevo Owner',
            email: 'nuevo-owner@agroscorelatam.com',
            password: 'temporal123',
            role: UserRole.OWNER,
          },
          actor,
          UserRole.OWNER,
        );

        expect(result.role).toBe(UserRole.OWNER);
        expect(usersService.create).toHaveBeenCalled();
      });
    });

    describe('updateUser', () => {
      it('actor admin pidiendo role owner para otro usuario se rechaza sin escribir nada', async () => {
        usersService.findById.mockResolvedValue(
          buildUser({ role: UserRole.USER }),
        );

        await expect(
          service.updateUser(
            'user-1',
            { role: UserRole.OWNER },
            actor,
            UserRole.ADMIN,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(usersService.update).not.toHaveBeenCalled();
        expect(auditLogService.record).not.toHaveBeenCalled();
      });

      it('actor admin pidiendo role owner para SÍ MISMO se rechaza igual (autoescalación)', async () => {
        usersService.findById.mockResolvedValue(
          buildUser({ id: 'admin-1', role: UserRole.ADMIN }),
        );

        await expect(
          service.updateUser(
            'admin-1',
            { role: UserRole.OWNER },
            actor,
            UserRole.ADMIN,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(usersService.update).not.toHaveBeenCalled();
      });

      it('actor owner pidiendo role owner sigue funcionando (control positivo)', async () => {
        usersService.findById.mockResolvedValue(
          buildUser({ role: UserRole.ADMIN }),
        );
        usersService.update.mockResolvedValue(
          buildUser({ role: UserRole.OWNER }),
        );

        await service.updateUser(
          'user-1',
          { role: UserRole.OWNER },
          actor,
          UserRole.OWNER,
        );

        expect(usersService.update).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({ role: UserRole.OWNER }),
        );
      });

      it('actor admin modificando isActive sin tocar role sigue funcionando (sin regresión)', async () => {
        usersService.findById.mockResolvedValue(
          buildUser({ role: UserRole.USER, isActive: true }),
        );
        usersService.update.mockResolvedValue(
          buildUser({ role: UserRole.USER, isActive: false }),
        );

        await service.updateUser(
          'user-1',
          { isActive: false },
          actor,
          UserRole.ADMIN,
        );

        expect(usersService.update).toHaveBeenCalledWith(
          'user-1',
          expect.objectContaining({ isActive: false }),
        );
      });
    });

    describe('createInvitation', () => {
      it('actor admin invitando con role owner se rechaza sin persistir ni enviar email', async () => {
        usersService.findByEmail.mockResolvedValue(null);

        await expect(
          service.createInvitation(
            { email: 'escalador@example.com', role: UserRole.OWNER },
            actor,
            UserRole.ADMIN,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(invitationRepo.save).not.toHaveBeenCalled();
        expect(emailService.sendInvitationEmail).not.toHaveBeenCalled();
        expect(auditLogService.record).not.toHaveBeenCalled();
      });

      it('actor owner invitando con role owner sigue funcionando (control positivo)', async () => {
        usersService.findByEmail.mockResolvedValue(null);
        invitationRepo.save.mockImplementation((v: unknown) =>
          Promise.resolve({ id: 'invitation-owner', ...(v as object) }),
        );

        const result = await service.createInvitation(
          { email: 'nuevo-owner@example.com', role: UserRole.OWNER },
          actor,
          UserRole.OWNER,
        );

        expect(result.role).toBe(UserRole.OWNER);
        expect(invitationRepo.save).toHaveBeenCalled();
      });
    });

    describe('createUserFromAccessRequest', () => {
      it('actor admin pidiendo role owner se rechaza sin convertir la solicitud ni invitar', async () => {
        const accessRequest = buildAccessRequest();
        accessRequestRepo.findOne.mockResolvedValue(accessRequest);
        usersService.findByEmail.mockResolvedValue(null);

        await expect(
          service.createUserFromAccessRequest(
            'access-request-1',
            { role: UserRole.OWNER },
            actor,
            UserRole.ADMIN,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(invitationRepo.save).not.toHaveBeenCalled();
        expect(accessRequestRepo.save).not.toHaveBeenCalled();
      });

      it('actor owner pidiendo role owner sigue funcionando (control positivo)', async () => {
        const accessRequest = buildAccessRequest();
        accessRequestRepo.findOne.mockResolvedValue(accessRequest);
        accessRequestRepo.save.mockImplementation((v: AccessRequest) =>
          Promise.resolve(v),
        );
        usersService.findByEmail.mockResolvedValue(null);
        invitationRepo.save.mockImplementation((v: unknown) =>
          Promise.resolve({ id: 'invitation-owner', ...(v as object) }),
        );

        const result = await service.createUserFromAccessRequest(
          'access-request-1',
          { role: UserRole.OWNER },
          actor,
          UserRole.OWNER,
        );

        expect(result.invitation.role).toBe(UserRole.OWNER);
        expect(accessRequestRepo.save).toHaveBeenCalled();
      });
    });
  });

  describe('updateAccessRequest', () => {
    it('setea contactedAt la primera vez que status pasa a contacted', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      accessRequestRepo.save.mockImplementation((v: AccessRequest) =>
        Promise.resolve(v),
      );

      const result = await service.updateAccessRequest(
        'access-request-1',
        { status: 'contacted' },
        actor,
      );

      expect(result.status).toBe('contacted');
      expect(result.contactedAt).toBeInstanceOf(Date);
    });

    it('no pisa contactedAt si ya estaba seteado', async () => {
      const alreadyContactedAt = new Date('2026-01-01T00:00:00.000Z');
      const accessRequest = buildAccessRequest({
        status: 'contacted',
        contactedAt: alreadyContactedAt,
      });
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      accessRequestRepo.save.mockImplementation((v: AccessRequest) =>
        Promise.resolve(v),
      );

      const result = await service.updateAccessRequest(
        'access-request-1',
        { status: 'contacted' },
        actor,
      );

      expect(result.contactedAt).toEqual(alreadyContactedAt);
    });

    it('setea discardedAt al pasar a discarded y audita admin.access_request.updated', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      accessRequestRepo.save.mockImplementation((v: AccessRequest) =>
        Promise.resolve(v),
      );

      const result = await service.updateAccessRequest(
        'access-request-1',
        { status: 'discarded' },
        actor,
      );

      expect(result.discardedAt).toBeInstanceOf(Date);
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.access_request.updated' }),
      );
    });

    it('404 si la solicitud no existe', async () => {
      accessRequestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateAccessRequest('missing', { status: 'contacted' }, actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createUserFromAccessRequest', () => {
    it('crea invitación, marca la solicitud como converted y audita ambas acciones', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      accessRequestRepo.save.mockImplementation((v: AccessRequest) =>
        Promise.resolve(v),
      );
      usersService.findByEmail.mockResolvedValue(null);
      invitationRepo.save.mockImplementation((v: unknown) =>
        Promise.resolve({ id: 'invitation-1', ...(v as object) }),
      );

      const result = await service.createUserFromAccessRequest(
        'access-request-1',
        {},
        actor,
        UserRole.ADMIN,
      );

      expect(result.accessRequest.status).toBe('converted');
      expect(result.invitation.email).toBe(accessRequest.email);
      expect(result.invitation.role).toBe(UserRole.USER);
      expect(result.invitation.emailSent).toBe(true);
      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        accessRequest.email,
        expect.objectContaining({ invitationUrl: expect.any(String) }),
      );

      const actions = auditLogService.record.mock.calls.map(
        (call) => call[0].action,
      );
      expect(actions).toContain('admin.invitation.created');
      expect(actions).toContain('admin.invitation.email_sent');
      expect(actions).toContain('admin.access_request.converted');
    });

    it('rechaza si ya existe un usuario con ese email', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      usersService.findByEmail.mockResolvedValue(
        buildUser({ email: accessRequest.email }),
      );

      await expect(
        service.createUserFromAccessRequest(
          'access-request-1',
          {},
          actor,
          UserRole.ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 si la solicitud no existe', async () => {
      accessRequestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createUserFromAccessRequest(
          'missing',
          {},
          actor,
          UserRole.ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createInvitation — no exponer el token en producción', () => {
    it('en dev (NODE_ENV != production) devuelve el token crudo', async () => {
      configService.get.mockReturnValue(undefined); // NODE_ENV sin setear = no-prod
      usersService.findByEmail.mockResolvedValue(null);
      invitationRepo.save.mockImplementation((v: unknown) =>
        Promise.resolve({ id: 'invitation-1', ...(v as object) }),
      );

      const result = await service.createInvitation(
        { email: 'nuevo@example.com', role: UserRole.USER },
        actor,
        UserRole.ADMIN,
      );

      expect(result).toHaveProperty('invitationToken');
      expect(result).not.toHaveProperty('tokenHash');
      expect(result.emailSent).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.provider).toBe('resend');
    });

    it('en producción NO devuelve ningún token pero sí emailSent/dryRun/provider', async () => {
      configService.get.mockImplementation((key: string) =>
        key === 'NODE_ENV' ? 'production' : undefined,
      );
      usersService.findByEmail.mockResolvedValue(null);
      invitationRepo.save.mockImplementation((v: unknown) =>
        Promise.resolve({ id: 'invitation-1', ...(v as object) }),
      );

      const result = await service.createInvitation(
        { email: 'nuevo@example.com', role: UserRole.USER },
        actor,
        UserRole.ADMIN,
      );

      expect(result).not.toHaveProperty('invitationToken');
      expect(result).not.toHaveProperty('invitationUrl');
      expect(result).not.toHaveProperty('tokenHash');
      expect(result.emailSent).toBe(true);
      expect(result.dryRun).toBe(true);
    });

    it('envía el email de invitación y audita admin.invitation.email_sent', async () => {
      configService.get.mockReturnValue(undefined);
      usersService.findByEmail.mockResolvedValue(null);
      invitationRepo.save.mockImplementation((v: unknown) =>
        Promise.resolve({ id: 'invitation-1', ...(v as object) }),
      );

      await service.createInvitation(
        { email: 'nuevo@example.com', role: UserRole.USER },
        actor,
        UserRole.ADMIN,
      );

      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        'nuevo@example.com',
        expect.objectContaining({
          invitationUrl: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );

      const emailSentCall = auditLogService.record.mock.calls.find(
        (call) => call[0].action === 'admin.invitation.email_sent',
      );
      expect(emailSentCall).toBeDefined();
      expect(emailSentCall?.[0].targetType).toBe('invitation');
    });

    it('si el envío de email falla, la invitación igual se crea (emailSent: false)', async () => {
      configService.get.mockReturnValue(undefined);
      usersService.findByEmail.mockResolvedValue(null);
      invitationRepo.save.mockImplementation((v: unknown) =>
        Promise.resolve({ id: 'invitation-1', ...(v as object) }),
      );
      emailService.sendInvitationEmail.mockResolvedValueOnce({
        sent: false,
        provider: 'resend',
        dryRun: false,
      });

      const result = await service.createInvitation(
        { email: 'nuevo@example.com', role: UserRole.USER },
        actor,
        UserRole.ADMIN,
      );

      expect(result.id).toBe('invitation-1');
      expect(result.emailSent).toBe(false);
    });

    it('rechaza invitar a un email que ya tiene cuenta', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.createInvitation(
          { email: 'user@agroscorelatam.com', role: UserRole.USER },
          actor,
          UserRole.ADMIN,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('createPasswordResetToken', () => {
    it('en producción no devuelve el token pero sí emailSent/dryRun y audita ambas acciones', async () => {
      configService.get.mockImplementation((key: string) =>
        key === 'NODE_ENV' ? 'production' : undefined,
      );
      usersService.findById.mockResolvedValue(buildUser());
      passwordResetRepo.save.mockResolvedValue(undefined);

      const result = await service.createPasswordResetToken('user-1', actor);

      expect(result).not.toHaveProperty('resetToken');
      expect(result).not.toHaveProperty('resetUrl');
      expect(result.emailSent).toBe(true);
      expect(result.dryRun).toBe(true);

      const actions = auditLogService.record.mock.calls.map(
        (call) => call[0].action,
      );
      expect(actions).toContain('admin.password_reset.created');
      expect(actions).toContain('admin.password_reset.email_sent');
    });

    it('en dev devuelve resetToken/resetUrl y envía el email al usuario', async () => {
      configService.get.mockReturnValue(undefined);
      const user = buildUser();
      usersService.findById.mockResolvedValue(user);
      passwordResetRepo.save.mockResolvedValue(undefined);

      const result = await service.createPasswordResetToken('user-1', actor);

      expect(result).toHaveProperty('resetToken');
      expect(result).toHaveProperty('resetUrl');
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        user.email,
        expect.objectContaining({
          resetUrl: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );
    });

    it('si el envío de email falla, el token igual se genera (emailSent: false)', async () => {
      configService.get.mockReturnValue(undefined);
      usersService.findById.mockResolvedValue(buildUser());
      passwordResetRepo.save.mockResolvedValue(undefined);
      emailService.sendPasswordResetEmail.mockResolvedValueOnce({
        sent: false,
        provider: 'resend',
        dryRun: false,
      });

      const result = await service.createPasswordResetToken('user-1', actor);

      expect(result.emailSent).toBe(false);
      expect(result).toHaveProperty('resetToken');
    });

    it('404 si el usuario no existe', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        service.createPasswordResetToken('missing', actor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('mark-reviewed / retry de diagnósticos', () => {
    it('markAnalysisReviewed rechaza analysis que no está en Error', async () => {
      analysisRepo.findOne.mockResolvedValue({
        id: 'a1',
        status: 'Finalizado',
      });

      await expect(
        service.markAnalysisReviewed('a1', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('retryAnalysis incrementa retryCount y audita admin.analysis.retry_requested', async () => {
      analysisRepo.findOne.mockResolvedValue({
        id: 'a1',
        status: 'Error',
        retryCount: 0,
        lastRetriedAt: null,
      });
      analysisRepo.save.mockImplementation((v: unknown) => Promise.resolve(v));

      const result = await service.retryAnalysis('a1', actor);

      expect(result.retryCount).toBe(1);
      expect(result.lastRetriedAt).toBeInstanceOf(Date);
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.analysis.retry_requested' }),
      );
    });
  });

  describe('retryTechnicalVerdict (PR 17)', () => {
    it('Analysis inexistente → NotFoundException, nunca invoca generateAndPersist', async () => {
      analysisRepo.findOne.mockResolvedValue(null);

      await expect(
        service.retryTechnicalVerdict('missing-id', actor),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(analysisVerdictService.generateAndPersist).not.toHaveBeenCalled();
    });

    it('Analysis no Finalizado (p.ej. Procesando) → BadRequestException, nunca invoca generateAndPersist', async () => {
      analysisRepo.findOne.mockResolvedValue({
        id: 'a1',
        status: 'Procesando',
      });

      await expect(
        service.retryTechnicalVerdict('a1', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(analysisVerdictService.generateAndPersist).not.toHaveBeenCalled();
    });

    it('Analysis con status=Error (ni Finalizado) → BadRequestException', async () => {
      analysisRepo.findOne.mockResolvedValue({ id: 'a1', status: 'Error' });

      await expect(
        service.retryTechnicalVerdict('a1', actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(analysisVerdictService.generateAndPersist).not.toHaveBeenCalled();
    });

    it('Analysis Finalizado → reutiliza generateAndPersist, audita el retry y devuelve el veredicto mapeado', async () => {
      const analysis = { id: 'a1', status: 'Finalizado' };
      analysisRepo.findOne.mockResolvedValue(analysis);
      analysisVerdictRepo.findOne.mockResolvedValue({
        status: 'failed',
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage:
          'Claude usó lenguaje demasiado afirmativo sobre una causa agronómica (debe hablar en hipótesis, no en certezas).',
      });
      analysisVerdictService.generateAndPersist.mockResolvedValue({
        status: 'generated',
        verdict: 'attention',
        confidence: 'medium',
        summary: 'ok',
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage: null,
        generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      } as any);

      const result = await service.retryTechnicalVerdict('a1', actor);

      expect(analysisVerdictService.generateAndPersist).toHaveBeenCalledWith(
        analysis,
      );
      expect(result.status).toBe('generated');
      expect(result.verdict).toBe('attention');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.analysis.technical_verdict_retry_requested',
          targetType: 'analysis_technical_verdict',
          targetId: 'a1',
          before: expect.objectContaining({ status: 'failed' }),
          after: expect.objectContaining({ status: 'generated' }),
        }),
      );
    });

    it('smoke test failed→retry→generated (PR 17, caso de producción): antes failed, después generated', async () => {
      const analysis = { id: 'a1', status: 'Finalizado' };
      analysisRepo.findOne.mockResolvedValue(analysis);
      analysisVerdictRepo.findOne.mockResolvedValue({
        status: 'failed',
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage: 'Claude usó lenguaje demasiado afirmativo...',
      });
      analysisVerdictService.generateAndPersist.mockResolvedValue({
        status: 'generated',
        verdict: 'favorable',
        confidence: 'high',
        summary: 'ok',
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage: null,
        generatedAt: new Date(),
      } as any);

      const result = await service.retryTechnicalVerdict('a1', actor);

      expect(result.status).toBe('generated');
      expect(result.errorMessage).toBeNull();
    });

    it('si el reintento vuelve a fallar el guardrail, propaga status=failed tal cual — nunca fuerza un resultado', async () => {
      const analysis = { id: 'a1', status: 'Finalizado' };
      analysisRepo.findOne.mockResolvedValue(analysis);
      analysisVerdictRepo.findOne.mockResolvedValue({
        status: 'failed',
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage: 'rechazo previo',
      });
      analysisVerdictService.generateAndPersist.mockResolvedValue({
        status: 'failed',
        verdict: 'insufficient_data',
        confidence: 'low',
        summary: 'No se pudo generar el veredicto técnico automático.',
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage:
          'Claude usó lenguaje demasiado afirmativo sobre una causa agronómica (debe hablar en hipótesis, no en certezas).',
        generatedAt: null,
      } as any);

      const result = await service.retryTechnicalVerdict('a1', actor);

      expect(result.status).toBe('failed');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });

    it('nunca crea/guarda la fila directamente — toda la escritura queda delegada a generateAndPersist (idempotencia)', async () => {
      const analysis = { id: 'a1', status: 'Finalizado' };
      analysisRepo.findOne.mockResolvedValue(analysis);
      analysisVerdictRepo.findOne.mockResolvedValue(null);
      analysisVerdictService.generateAndPersist.mockResolvedValue({
        status: 'generated',
        generator: 'claude',
        promptVersion: 'technical-verdict-v1.2',
        errorMessage: null,
      } as any);

      await service.retryTechnicalVerdict('a1', actor);

      expect(analysisVerdictRepo.create).not.toHaveBeenCalled();
      expect(analysisVerdictRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('listAnalysis — technicalVerdict (PR 13A)', () => {
    const buildAnalysisRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'a1',
      fieldId: 'field-1',
      lotName: null,
      field: {
        id: 'field-1',
        name: 'Campo A',
        userId: 'user-1',
        user: { id: 'user-1', email: 'a@x.com', fullName: 'A' },
      },
      status: 'Finalizado',
      startedAt: new Date(),
      completedAt: new Date(),
      failedAt: null,
      durationMs: 1000,
      errorMessage: null,
      reviewedAt: null,
      reviewedByUserId: null,
      retryCount: 0,
      lastRetriedAt: null,
      createdAt: new Date(),
      ...overrides,
    });

    const buildQueryBuilder = (items: unknown[], total: number) => {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndMapOne',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    };

    const buildVerdictRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'verdict-1',
      analysisId: 'a1',
      status: 'generated',
      verdict: 'attention',
      confidence: 'medium',
      summary: 'El campo muestra variabilidad relevante entre zonas.',
      keyFindings: ['Zona Alta concentra la mayor superficie.'],
      possibleCauses: [],
      recommendations: ['Revisar riego diferencial.'],
      limitations: ['Cobertura satelital parcial.'],
      inputSnapshot: {},
      generator: 'claude',
      promptVersion: 'technical-verdict-v1',
      errorMessage: null,
      generatedAt: new Date('2026-08-26T01:40:38.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });

    it('incluye technicalVerdict por análisis con una única consulta en lote (IN analysisId)', async () => {
      const rowA = buildAnalysisRow({ id: 'a1' });
      const rowB = buildAnalysisRow({ id: 'a2' });
      analysisRepo.createQueryBuilder.mockReturnValue(
        buildQueryBuilder([rowA, rowB], 2),
      );
      analysisVerdictRepo.find.mockResolvedValue([
        buildVerdictRow({ analysisId: 'a1' }),
      ]);

      const result = await service.listAnalysis({ page: 1, limit: 20 });

      expect(analysisVerdictRepo.find).toHaveBeenCalledTimes(1);
      expect(analysisVerdictRepo.find).toHaveBeenCalledWith({
        where: { analysisId: In(['a1', 'a2']) },
      });
      expect(result.items[0].technicalVerdict).toEqual(
        expect.objectContaining({
          status: 'generated',
          verdict: 'attention',
          confidence: 'medium',
        }),
      );
      expect(result.items[1].technicalVerdict).toBeNull();
    });

    it('expone generator/promptVersion/generatedAt/errorMessage — a diferencia del contrato público', async () => {
      const row = buildAnalysisRow({ id: 'a1' });
      analysisRepo.createQueryBuilder.mockReturnValue(
        buildQueryBuilder([row], 1),
      );
      analysisVerdictRepo.find.mockResolvedValue([
        buildVerdictRow({
          analysisId: 'a1',
          status: 'failed',
          verdict: 'insufficient_data',
          confidence: 'low',
          errorMessage: 'Claude rechazó la API key configurada (401).',
          generatedAt: null,
        }),
      ]);

      const result = await service.listAnalysis({ page: 1, limit: 20 });

      expect(result.items[0].technicalVerdict).toEqual(
        expect.objectContaining({
          status: 'failed',
          generator: 'claude',
          promptVersion: 'technical-verdict-v1',
          errorMessage: 'Claude rechazó la API key configurada (401).',
        }),
      );
    });

    it('technicalVerdict es null cuando no existe fila para ese análisis', async () => {
      const row = buildAnalysisRow({ id: 'a1' });
      analysisRepo.createQueryBuilder.mockReturnValue(
        buildQueryBuilder([row], 1),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);

      const result = await service.listAnalysis({ page: 1, limit: 20 });

      expect(result.items[0].technicalVerdict).toBeNull();
    });

    it('con la página vacía, no consulta analysis_technical_verdicts (evita un IN vacío)', async () => {
      analysisRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder([], 0));

      const result = await service.listAnalysis({ page: 1, limit: 20 });

      expect(analysisVerdictRepo.find).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });
  });

  describe('listScheduledAnalysis (PR 13B)', () => {
    const buildScheduleRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'schedule-1',
      fieldId: 'field-1',
      userId: 'user-1',
      field: {
        id: 'field-1',
        name: 'Campo A',
        userId: 'user-1',
        user: { id: 'user-1', email: 'a@x.com', fullName: 'A' },
      },
      enabled: true,
      frequency: 'weekly',
      nextRunAt: new Date('2026-09-01T12:00:00Z'),
      lastRunAt: new Date('2026-08-25T12:00:00Z'),
      lastStatus: 'completed',
      lastErrorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });

    const buildScheduleQueryBuilder = (items: unknown[], total: number) => {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        // Admin PR 3: getScheduledAnalysisSummary() reusa este mismo repositorio (mockeado acá
        // arriba con un único objeto para todas las llamadas a createQueryBuilder) para el conteo
        // NOT EXISTS de `withoutRuns` — where/getCount con un default inocuo (0) para no romper
        // los tests de arriba, que no verifican el resumen.
        where: jest.fn(),
        getCount: jest.fn().mockResolvedValue(0),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndMapOne',
        'orderBy',
        'skip',
        'take',
        'andWhere',
        'where',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    };

    const buildRunRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'run-1',
      scheduleId: 'schedule-1',
      fieldId: 'field-1',
      userId: 'user-1',
      analysisId: 'a1',
      analysis: { id: 'a1', status: 'Finalizado' },
      status: 'completed',
      scheduledFor: '2026-08-24',
      startedAt: new Date(),
      completedAt: new Date(),
      failedAt: null,
      emailSentAt: new Date('2026-08-25T12:05:00.000Z'),
      errorMessage: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });

    const buildRunQueryBuilder = (items: unknown[]) => {
      const qb: Record<string, jest.Mock> = {
        distinctOn: jest.fn(),
        leftJoinAndSelect: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        getMany: jest.fn().mockResolvedValue(items),
      };
      for (const key of [
        'distinctOn',
        'leftJoinAndSelect',
        'where',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    };

    it('arma latestRun con analysisStatus resuelto en la misma query (sin consulta aparte)', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 1),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([buildRunRow()]),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(scheduledAnalysisRunRepo.createQueryBuilder).toHaveBeenCalledTimes(
        1,
      );
      expect(result.items[0].latestRun).toEqual(
        expect.objectContaining({
          analysisId: 'a1',
          analysisStatus: 'Finalizado',
        }),
      );
    });

    it('incluye technicalVerdict cuando existe para el analysisId de latestRun', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 1),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([buildRunRow()]),
      );
      analysisVerdictRepo.find.mockResolvedValue([
        {
          id: 'verdict-1',
          analysisId: 'a1',
          status: 'generated',
          verdict: 'favorable',
          confidence: 'high',
          summary: 'Resumen.',
          keyFindings: [],
          possibleCauses: [],
          recommendations: [],
          limitations: [],
          inputSnapshot: {},
          generator: 'claude',
          promptVersion: 'technical-verdict-v1',
          errorMessage: null,
          generatedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(analysisVerdictRepo.find).toHaveBeenCalledWith({
        where: { analysisId: In(['a1']) },
      });
      expect(result.items[0].technicalVerdict).toEqual(
        expect.objectContaining({ status: 'generated', generator: 'claude' }),
      );
    });

    it('technicalVerdict es null cuando no existe fila para el analysisId de latestRun', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 1),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([buildRunRow()]),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.items[0].technicalVerdict).toBeNull();
    });

    it('incluye emailSentAt del latestRun', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 1),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([
          buildRunRow({ emailSentAt: new Date('2026-08-25T12:05:00.000Z') }),
        ]),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.items[0].latestRun?.emailSentAt).toBe(
        '2026-08-25T12:05:00.000Z',
      );
    });

    it('resuelve fieldName/userEmail/userFullName desde el join de Field/User', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder(
          [
            buildScheduleRow({
              field: {
                id: 'field-1',
                name: 'Campo San José',
                userId: 'user-1',
                user: {
                  id: 'user-1',
                  email: 'owner@x.com',
                  fullName: 'Owner Test',
                },
              },
            }),
          ],
          1,
        ),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([]),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          fieldName: 'Campo San José',
          userEmail: 'owner@x.com',
          userFullName: 'Owner Test',
        }),
      );
    });

    it('un schedule sin corridas tiene latestRun null y technicalVerdict null, sin consultar verdicts', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 1),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([]),
      );

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.items[0].latestRun).toBeNull();
      expect(result.items[0].technicalVerdict).toBeNull();
      expect(analysisVerdictRepo.find).not.toHaveBeenCalled();
    });

    it('con la página vacía, no consulta runs ni verdicts (evita un IN vacío)', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([], 0),
      );

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(
        scheduledAnalysisRunRepo.createQueryBuilder,
      ).not.toHaveBeenCalled();
      expect(analysisVerdictRepo.find).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('devuelve page/limit/total de la paginación', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildScheduleQueryBuilder([buildScheduleRow()], 37),
      );
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRunQueryBuilder([]),
      );

      const result = await service.listScheduledAnalysis({
        page: 2,
        limit: 10,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(37);
    });

    describe('weeklyTechnicalVerdict (PR 16D)', () => {
      const buildWeeklyVerdictResponse = (
        overrides: Partial<WeeklyTechnicalVerdictResponse> = {},
      ): WeeklyTechnicalVerdictResponse => ({
        status: 'generated',
        verdict: 'attention',
        trend: 'stable',
        confidence: 'medium',
        summary: 'Respecto del reporte anterior, el campo se mantiene estable.',
        keyChanges: [],
        areasToReview: [],
        recommendations: [],
        limitations: [],
        previousSnapshotId: null,
        generator: 'deterministic-v1',
        promptVersion: null,
        errorMessage: null,
        generatedAt: '2026-08-24T12:00:00.000Z',
        ...overrides,
      });

      it('devuelve weeklyTechnicalVerdict generated cuando existe para el scheduledRunId de latestRun', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([buildRunRow({ id: 'run-1' })]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);
        const weekly = buildWeeklyVerdictResponse();
        weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
          new Map([['run-1', weekly]]),
        );

        const result = await service.listScheduledAnalysis({
          page: 1,
          limit: 20,
        });

        expect(
          weeklyTechnicalVerdictService.findResponsesByScheduledRunIds,
        ).toHaveBeenCalledWith(['run-1']);
        expect(result.items[0].weeklyTechnicalVerdict).toEqual(weekly);
      });

      it('devuelve null cuando no hay diagnóstico semanal para ese scheduledRunId', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([buildRunRow({ id: 'run-1' })]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);
        weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
          new Map(),
        );

        const result = await service.listScheduledAnalysis({
          page: 1,
          limit: 20,
        });

        expect(result.items[0].weeklyTechnicalVerdict).toBeNull();
      });

      it('devuelve failed con errorMessage tal cual (admin sí lo ve)', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([buildRunRow({ id: 'run-1' })]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);
        const failed = buildWeeklyVerdictResponse({
          status: 'failed',
          verdict: 'insufficient_data',
          trend: 'insufficient_data',
          confidence: 'low',
          errorMessage: 'No se pudo generar el diagnóstico semanal automático.',
        });
        weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
          new Map([['run-1', failed]]),
        );

        const result = await service.listScheduledAnalysis({
          page: 1,
          limit: 20,
        });

        expect(result.items[0].weeklyTechnicalVerdict).toEqual(
          expect.objectContaining({
            status: 'failed',
            errorMessage:
              'No se pudo generar el diagnóstico semanal automático.',
          }),
        );
      });

      it('incluye generator/promptVersion/errorMessage en la respuesta admin', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([buildRunRow({ id: 'run-1' })]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);
        weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
          new Map([
            [
              'run-1',
              buildWeeklyVerdictResponse({
                generator: 'claude',
                promptVersion: 'weekly-technical-verdict-v1',
                errorMessage: null,
              }),
            ],
          ]),
        );

        const result = await service.listScheduledAnalysis({
          page: 1,
          limit: 20,
        });

        expect(result.items[0].weeklyTechnicalVerdict).toEqual(
          expect.objectContaining({
            generator: 'claude',
            promptVersion: 'weekly-technical-verdict-v1',
          }),
        );
      });

      it('no hace N+1 — findResponsesByScheduledRunIds se llama una sola vez sin importar cuántos schedules haya en la página', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder(
            [
              buildScheduleRow({ id: 'schedule-1' }),
              buildScheduleRow({ id: 'schedule-2' }),
              buildScheduleRow({ id: 'schedule-3' }),
            ],
            3,
          ),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([
            buildRunRow({ id: 'run-1', scheduleId: 'schedule-1' }),
            buildRunRow({ id: 'run-2', scheduleId: 'schedule-2' }),
            buildRunRow({ id: 'run-3', scheduleId: 'schedule-3' }),
          ]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);

        await service.listScheduledAnalysis({ page: 1, limit: 20 });

        expect(
          weeklyTechnicalVerdictService.findResponsesByScheduledRunIds,
        ).toHaveBeenCalledTimes(1);
        expect(
          weeklyTechnicalVerdictService.findResponsesByScheduledRunIds,
        ).toHaveBeenCalledWith(['run-1', 'run-2', 'run-3']);
      });

      it('no llama a generateAndPersist ni a Claude — el mock inyectado solo expone findResponsesByScheduledRunIds', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([buildRunRow({ id: 'run-1' })]),
        );
        analysisVerdictRepo.find.mockResolvedValue([]);

        await service.listScheduledAnalysis({ page: 1, limit: 20 });

        expect(
          (
            weeklyTechnicalVerdictService as unknown as {
              generateAndPersist?: unknown;
            }
          ).generateAndPersist,
        ).toBeUndefined();
      });

      it('no rompe el shape existente de technicalVerdict individual — ambos conviven en el mismo item', async () => {
        fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
          buildScheduleQueryBuilder([buildScheduleRow()], 1),
        );
        scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
          buildRunQueryBuilder([
            buildRunRow({ id: 'run-1', analysisId: 'a1' }),
          ]),
        );
        analysisVerdictRepo.find.mockResolvedValue([
          {
            id: 'verdict-1',
            analysisId: 'a1',
            status: 'generated',
            verdict: 'favorable',
            confidence: 'high',
            summary: 'Resumen individual.',
            keyFindings: [],
            possibleCauses: [],
            recommendations: [],
            limitations: [],
            inputSnapshot: {},
            generator: 'claude',
            promptVersion: 'technical-verdict-v1',
            errorMessage: null,
            generatedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
        weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
          new Map([['run-1', buildWeeklyVerdictResponse()]]),
        );

        const result = await service.listScheduledAnalysis({
          page: 1,
          limit: 20,
        });

        expect(result.items[0].technicalVerdict).toEqual(
          expect.objectContaining({ status: 'generated', generator: 'claude' }),
        );
        expect(result.items[0].weeklyTechnicalVerdict).toEqual(
          expect.objectContaining({ status: 'generated', trend: 'stable' }),
        );
      });
    });
  });

  describe('getMetrics — alertas operativas (Admin PR 1)', () => {
    // Builder combinado: getMetrics() usa createQueryBuilder sobre analysisRepo tanto para
    // getAverageAnalysisDurationMs (select/where/andWhere/getRawOne) como para countSince
    // (where/andWhere/getCount) — un solo mock encadenable cubre ambos usos.
    function buildAnalysisQueryBuilder() {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        getRawOne: jest.fn().mockResolvedValue({ avg: null }),
        getCount: jest.fn().mockResolvedValue(0),
      };
      for (const key of ['select', 'where', 'andWhere']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildAccessRequestStatusQueryBuilder() {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        addSelect: jest.fn(),
        groupBy: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      for (const key of ['select', 'addSelect', 'groupBy']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    beforeEach(() => {
      usersService.count.mockResolvedValue(10);
      usersService.countActive.mockResolvedValue(8);
      usersService.countCreatedSince.mockResolvedValue(0);
      fieldRepo.count.mockResolvedValue(78);
      fieldRepo.manager.query.mockResolvedValue([{ count: 0 }]);
      // countSince() también se llama con this.fieldRepository (fieldsCreatedLast7/30Days).
      fieldRepo.createQueryBuilder.mockImplementation(() =>
        buildAnalysisQueryBuilder(),
      );
      analysisRepo.count.mockResolvedValue(0);
      analysisRepo.find.mockResolvedValue([]);
      analysisRepo.createQueryBuilder.mockImplementation(() =>
        buildAnalysisQueryBuilder(),
      );
      accessRequestRepo.find.mockResolvedValue([]);
      accessRequestRepo.createQueryBuilder.mockReturnValue(
        buildAccessRequestStatusQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count.mockResolvedValue(0);
    });

    it('incluye activeSchedulesWithoutRuns contando schedules enabled=true con lastRunAt IS NULL', async () => {
      fieldAnalysisScheduleRepo.count.mockResolvedValue(2);

      const metrics = await service.getMetrics();

      expect(fieldAnalysisScheduleRepo.count).toHaveBeenCalledWith({
        where: { enabled: true, lastRunAt: IsNull() },
      });
      expect(metrics.activeSchedulesWithoutRuns).toBe(2);
    });

    it('incluye unreviewedFailedAnalysisOlderThan7Days contando solo status=Error sin reviewedAt', async () => {
      analysisRepo.count.mockResolvedValue(4);

      const metrics = await service.getMetrics();

      expect(analysisRepo.count).toHaveBeenCalledWith({
        where: {
          status: 'Error',
          reviewedAt: IsNull(),
          createdAt: expect.anything(),
        },
      });
      expect(metrics.unreviewedFailedAnalysisOlderThan7Days).toBe(4);
    });

    it('no rompe el shape existente del Dashboard (totalUsers/totalFields/etc. siguen presentes)', async () => {
      const metrics = await service.getMetrics();

      expect(metrics).toEqual(
        expect.objectContaining({
          totalUsers: 10,
          activeUsers: 8,
          totalFields: 78,
          fieldsWithNoAnalysis: expect.any(Number),
          activeSchedulesWithoutRuns: expect.any(Number),
          unreviewedFailedAnalysisOlderThan7Days: expect.any(Number),
        }),
      );
    });
  });

  describe('listFields — filtro hasAnalysis (Admin PR 1)', () => {
    function buildFieldsQueryBuilder(items: unknown[], total: number) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    it('agrega un NOT EXISTS cuando hasAnalysis=false, para "campos sin diagnóstico"', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listFields({ page: 1, limit: 20, hasAnalysis: false });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes('NOT EXISTS'))).toBe(true);
    });

    it('agrega un EXISTS (sin NOT) cuando hasAnalysis=true', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listFields({ page: 1, limit: 20, hasAnalysis: true });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(
        sqlCalls.some(
          (sql) => sql.includes('EXISTS') && !sql.includes('NOT EXISTS'),
        ),
      ).toBe(true);
    });

    it('no agrega ningún filtro de análisis cuando hasAnalysis no viene en el query', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listFields({ page: 1, limit: 20 });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('Admin PR 2: filtra por userId ("ver campos de este usuario")', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listFields({ page: 1, limit: 20, userId: 'user-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('field."userId" = :userId', {
        userId: 'user-1',
      });
    });

    it('Admin PR 2: filtra por fieldId ("saltar a este campo puntual")', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listFields({ page: 1, limit: 20, fieldId: 'field-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('field.id = :fieldId', {
        fieldId: 'field-1',
      });
    });
  });

  describe('listFields — estado real (Admin PR 5)', () => {
    function buildFieldsQueryBuilder(items: unknown[], total: number) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildFieldRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'field-1',
        userId: 'user-1',
        name: 'Campo Norte',
        user: {
          id: 'user-1',
          email: 'owner@example.com',
          fullName: 'Owner Test',
        },
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z'),
        ...overrides,
      };
    }

    function buildLotsCountQueryBuilder() {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        addSelect: jest.fn(),
        where: jest.fn(),
        groupBy: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      for (const key of ['select', 'addSelect', 'where', 'groupBy']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    // Fixture "vacía" para las 5 consultas batched (manager.query de latestAnalysis, find de
    // schedules, find de verdicts, manager.query de scheduleIdsWithRuns) — cada test override solo
    // lo que necesita.
    function setupEmptyBatches() {
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsCountQueryBuilder(),
      );
      fieldRepo.manager.query.mockResolvedValue([]);
      fieldAnalysisScheduleRepo.find.mockResolvedValue([]);
      analysisVerdictRepo.find.mockResolvedValue([]);
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([]);
    }

    it('devuelve latestAnalysis (con score) cuando el último análisis existe y está Finalizado', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Finalizado',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: new Date('2026-08-10T01:00:00.000Z'),
          durationMs: 5000,
          globalScore: 72,
        },
      ]);

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].latestAnalysis).toEqual(
        expect.objectContaining({
          id: 'analysis-1',
          status: 'Finalizado',
          score: 72,
        }),
      );
      expect(result.items[0].analysisStatus).toBe('completed');
    });

    it('devuelve analysisStatus=without_analysis y latestAnalysis=null cuando no hay análisis', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].latestAnalysis).toBeNull();
      expect(result.items[0].analysisStatus).toBe('without_analysis');
      expect(result.items[0].requiresAttention).toBe(false);
    });

    it('marca analysisStatus=error y requiresAttention=true si el último análisis está en Error', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Error',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: null,
          durationMs: null,
          globalScore: 0,
        },
      ]);

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].analysisStatus).toBe('error');
      expect(result.items[0].requiresAttention).toBe(true);
      // No score mientras no está Finalizado — 0 sería un score falso, no "ausente".
      expect(result.items[0].latestAnalysis?.score).toBeNull();
    });

    it('marca analysisStatus=attention y requiresAttention=true si el veredicto técnico requiere atención', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Finalizado',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: new Date('2026-08-10T01:00:00.000Z'),
          durationMs: 5000,
          globalScore: 35,
        },
      ]);
      analysisVerdictRepo.find.mockResolvedValue([
        {
          analysisId: 'analysis-1',
          status: 'generated',
          verdict: 'attention',
          confidence: 'medium',
          summary: 'Zona con variabilidad relevante.',
          keyFindings: [],
          possibleCauses: [],
          recommendations: [],
          limitations: [],
          generatedAt: new Date('2026-08-10T01:05:00.000Z'),
          generator: 'deterministic-v1',
          promptVersion: null,
          errorMessage: null,
        },
      ]);

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].analysisStatus).toBe('attention');
      expect(result.items[0].requiresAttention).toBe(true);
      expect(result.items[0].technicalVerdict?.verdict).toBe('attention');
    });

    it('weeklyMonitoring.active=true y requiresAttention=true si el schedule está activo pero sin corridas', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          nextRunAt: new Date('2026-09-01T09:00:00.000Z'),
          lastRunAt: null,
        },
      ]);
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([]); // sin corridas para schedule-1

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].weeklyMonitoring).toEqual(
        expect.objectContaining({
          active: true,
          scheduleId: 'schedule-1',
          hasRuns: false,
        }),
      );
      expect(result.items[0].requiresAttention).toBe(true);
    });

    it('weeklyMonitoring.hasRuns=true cuando existe una corrida real para el schedule (no lastRunAt)', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder([buildFieldRow()], 1),
      );
      setupEmptyBatches();
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
        },
      ]);
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([
        { scheduleId: 'schedule-1' },
      ]);

      const result = await service.listFields({ page: 1, limit: 20 });

      expect(result.items[0].weeklyMonitoring.hasRuns).toBe(true);
      expect(result.items[0].requiresAttention).toBe(false);
    });

    it('filtra status=without_analysis con el mismo NOT EXISTS que hasAnalysis=false', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);
      setupEmptyBatches();

      await service.listFields({
        page: 1,
        limit: 20,
        status: 'without_analysis',
      });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes('NOT EXISTS'))).toBe(true);
    });

    it('filtra status=attention combinando el status Finalizado y el veredicto del último análisis', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);
      setupEmptyBatches();

      await service.listFields({ page: 1, limit: 20, status: 'attention' });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes("= 'Finalizado'"))).toBe(true);
      expect(
        sqlCalls.some((sql) => sql.includes("IN ('attention', 'critical')")),
      ).toBe(true);
    });

    it('filtra monitoring=active con EXISTS contra field_analysis_schedules.enabled', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);
      setupEmptyBatches();

      await service.listFields({ page: 1, limit: 20, monitoring: 'active' });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(
        sqlCalls.some(
          (sql) =>
            sql.includes('field_analysis_schedules') &&
            sql.includes('enabled = true') &&
            !sql.includes('NOT EXISTS'),
        ),
      ).toBe(true);
    });

    it('sigue soportando hasAnalysis=false (PR1) junto a los filtros nuevos', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);
      setupEmptyBatches();

      await service.listFields({ page: 1, limit: 20, hasAnalysis: false });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes('NOT EXISTS'))).toBe(true);
    });

    it('sigue soportando userId/fieldId (PR2) junto a los filtros nuevos', async () => {
      const qb = buildFieldsQueryBuilder([], 0);
      fieldRepo.createQueryBuilder.mockReturnValue(qb);
      setupEmptyBatches();

      await service.listFields({
        page: 1,
        limit: 20,
        userId: 'user-1',
        fieldId: 'field-1',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('field."userId" = :userId', {
        userId: 'user-1',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('field.id = :fieldId', {
        fieldId: 'field-1',
      });
    });

    it('no hace N+1: una sola consulta batched por tipo de dato, sin importar cuántos campos traiga la página', async () => {
      fieldRepo.createQueryBuilder.mockReturnValue(
        buildFieldsQueryBuilder(
          [
            buildFieldRow({ id: 'field-1' }),
            buildFieldRow({ id: 'field-2' }),
            buildFieldRow({ id: 'field-3' }),
          ],
          3,
        ),
      );
      setupEmptyBatches();
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
        },
        {
          id: 'schedule-2',
          fieldId: 'field-2',
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
        },
      ]);

      fieldRepo.manager.query.mockClear();
      analysisVerdictRepo.find.mockClear();
      // Al menos un fieldId con análisis real, para que analysisIds no quede vacío y
      // getTechnicalVerdictsByAnalysisId (que corta temprano con ids=[]) sí golpee el repo.
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Finalizado',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: new Date('2026-08-10T01:00:00.000Z'),
          durationMs: 5000,
          globalScore: 50,
        },
      ]);

      await service.listFields({ page: 1, limit: 20 });

      // 1 llamada para latestAnalysis (batched por los 3 fieldIds), no 3.
      expect(fieldRepo.manager.query).toHaveBeenCalledTimes(1);
      // 1 llamada para verdicts (batched), aunque analysisIds venga vacío acá.
      expect(analysisVerdictRepo.find).toHaveBeenCalledTimes(1);
      // 1 llamada para schedules (batched por los 3 fieldIds), no 3.
      expect(fieldAnalysisScheduleRepo.find).toHaveBeenCalledTimes(1);
      // 1 llamada para hasRuns (batched por los 2 scheduleIds), no 2.
      expect(scheduledAnalysisRunRepo.manager.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('getFieldDetail (Admin PR 6)', () => {
    function buildFieldRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'field-1',
        userId: 'user-1',
        name: 'Campo Norte',
        user: {
          id: 'user-1',
          email: 'owner@example.com',
          fullName: 'Owner Test',
        },
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z'),
        ...overrides,
      };
    }

    function buildLotsCountQueryBuilder() {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        addSelect: jest.fn(),
        where: jest.fn(),
        groupBy: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      for (const key of ['select', 'addSelect', 'where', 'groupBy']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildAnalysesQueryBuilder(rows: unknown[] = []) {
      const qb: Record<string, jest.Mock> = {
        where: jest.fn(),
        orderBy: jest.fn(),
        take: jest.fn(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      for (const key of ['where', 'orderBy', 'take']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    // Fixture "vacía" para todas las consultas batched/limitadas — cada test override lo que
    // necesita.
    function setupEmptyDetail() {
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsCountQueryBuilder(),
      );
      fieldLotRepo.find.mockResolvedValue([]);
      fieldRepo.manager.query.mockResolvedValue([]);
      analysisRepo.createQueryBuilder.mockReturnValue(
        buildAnalysesQueryBuilder([]),
      );
      analysisVerdictRepo.find.mockResolvedValue([]);
      fieldAnalysisScheduleRepo.find.mockResolvedValue([]);
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.find.mockResolvedValue([]);
      weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
        new Map(),
      );
    }

    it('devuelve 404 (NotFoundException) si el campo no existe', async () => {
      fieldRepo.findOne.mockResolvedValue(null);

      await expect(service.getFieldDetail('field-inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('devuelve los datos básicos del campo, incluyendo ownerId/ownerEmail', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();

      const result = await service.getFieldDetail('field-1');

      expect(result.field).toEqual(
        expect.objectContaining({
          id: 'field-1',
          name: 'Campo Norte',
          ownerId: 'user-1',
          ownerEmail: 'owner@example.com',
          ownerFullName: 'Owner Test',
        }),
      );
    });

    it('incluye lots (limitados por fieldId, orden DESC)', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      fieldLotRepo.find.mockResolvedValue([
        {
          id: 'lot-1',
          name: 'Lote 1',
          createdAt: new Date('2026-08-05T00:00:00.000Z'),
          updatedAt: new Date('2026-08-05T00:00:00.000Z'),
        },
      ]);

      const result = await service.getFieldDetail('field-1');

      expect(result.lots).toEqual([
        expect.objectContaining({ id: 'lot-1', name: 'Lote 1' }),
      ]);
      expect(fieldLotRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { fieldId: 'field-1' },
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('incluye latestAnalysis y technicalVerdict del último análisis, si existen', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Finalizado',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: new Date('2026-08-10T01:00:00.000Z'),
          durationMs: 5000,
          globalScore: 72,
        },
      ]);
      analysisVerdictRepo.find.mockResolvedValue([
        {
          analysisId: 'analysis-1',
          status: 'generated',
          verdict: 'favorable',
          confidence: 'high',
          summary: 'Todo bien.',
          keyFindings: [],
          possibleCauses: [],
          recommendations: [],
          limitations: [],
          generatedAt: new Date('2026-08-10T01:05:00.000Z'),
          generator: 'deterministic-v1',
          promptVersion: null,
          errorMessage: null,
        },
      ]);

      const result = await service.getFieldDetail('field-1');

      expect(result.latestAnalysis).toEqual(
        expect.objectContaining({
          id: 'analysis-1',
          status: 'Finalizado',
          score: 72,
        }),
      );
      expect(result.technicalVerdict?.verdict).toBe('favorable');
    });

    it('incluye analyses (historial), últimos N ordenados DESC', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      const rows = [
        {
          id: 'analysis-2',
          status: 'Finalizado',
          createdAt: new Date('2026-08-12T00:00:00.000Z'),
          completedAt: new Date('2026-08-12T01:00:00.000Z'),
          durationMs: 4000,
          globalScore: 60,
          errorMessage: null,
          reviewedAt: null,
          reviewedByUserId: null,
        },
        {
          id: 'analysis-1',
          status: 'Error',
          createdAt: new Date('2026-08-05T00:00:00.000Z'),
          completedAt: null,
          durationMs: null,
          globalScore: 0,
          errorMessage: 'Nubosidad excesiva',
          reviewedAt: null,
          reviewedByUserId: null,
        },
      ];
      const qb = buildAnalysesQueryBuilder(rows);
      analysisRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getFieldDetail('field-1');

      expect(result.analyses.map((a) => a.id)).toEqual([
        'analysis-2',
        'analysis-1',
      ]);
      expect(result.analyses[1].score).toBeNull(); // Error, nunca score
      expect(result.analyses[1].errorMessage).toBe('Nubosidad excesiva');
      expect(qb.take).toHaveBeenCalledWith(FIELD_DETAIL_ANALYSES_LIMIT);
      expect(qb.orderBy).toHaveBeenCalledWith('analysis.createdAt', 'DESC');
    });

    it('incluye weeklyMonitoring con los datos del schedule cuando existe', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          frequency: 'weekly',
          nextRunAt: new Date('2026-09-01T09:00:00.000Z'),
          lastRunAt: new Date('2026-08-25T09:00:00.000Z'),
        },
      ]);

      const result = await service.getFieldDetail('field-1');

      expect(result.weeklyMonitoring).toEqual(
        expect.objectContaining({
          active: true,
          scheduleId: 'schedule-1',
          frequency: 'weekly',
        }),
      );
    });

    it('incluye scheduledRuns (últimos N del schedule, orden DESC) con su weeklyTechnicalVerdict', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          frequency: 'weekly',
          nextRunAt: null,
          lastRunAt: null,
        },
      ]);
      scheduledAnalysisRunRepo.find.mockResolvedValue([
        {
          id: 'run-1',
          scheduleId: 'schedule-1',
          status: 'completed',
          scheduledFor: '2026-08-24',
          analysisId: 'analysis-9',
          analysis: { status: 'Finalizado' },
          startedAt: new Date('2026-08-24T09:00:00.000Z'),
          completedAt: new Date('2026-08-24T09:05:00.000Z'),
          failedAt: null,
          emailSentAt: new Date('2026-08-24T09:10:00.000Z'),
          errorMessage: null,
          createdAt: new Date('2026-08-24T09:00:00.000Z'),
          updatedAt: new Date('2026-08-24T09:10:00.000Z'),
        },
      ]);
      weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
        new Map([
          [
            'run-1',
            {
              status: 'generated',
              verdict: 'stable',
              trend: 'stable',
              confidence: 'medium',
              summary: 'Sin cambios relevantes.',
              keyChanges: [],
              areasToReview: [],
              recommendations: [],
              limitations: [],
              previousSnapshotId: null,
              generatedAt: '2026-08-24T09:12:00.000Z',
              generator: 'deterministic-v1',
              promptVersion: null,
              errorMessage: null,
            },
          ],
        ]) as never,
      );

      const result = await service.getFieldDetail('field-1');

      expect(result.scheduledRuns).toHaveLength(1);
      expect(result.scheduledRuns[0]).toEqual(
        expect.objectContaining({
          id: 'run-1',
          analysisStatus: 'Finalizado',
          emailSentAt: '2026-08-24T09:10:00.000Z',
        }),
      );
      expect(result.scheduledRuns[0].weeklyTechnicalVerdict?.verdict).toBe(
        'stable',
      );
      expect(scheduledAnalysisRunRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scheduleId: 'schedule-1' },
          order: { createdAt: 'DESC' },
          take: FIELD_DETAIL_RUNS_LIMIT,
        }),
      );
    });

    it('mantiene las mismas reglas de analysisStatus/requiresAttention que listFields (PR5): Error => requiresAttention', async () => {
      fieldRepo.findOne.mockResolvedValue(buildFieldRow());
      setupEmptyDetail();
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Error',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: null,
          durationMs: null,
          globalScore: 0,
        },
      ]);

      const result = await service.getFieldDetail('field-1');

      expect(result.field.analysisStatus).toBe('error');
      expect(result.field.requiresAttention).toBe(true);
    });
  });

  describe('getUserDetail (Admin PR 7)', () => {
    function buildLotsCountQueryBuilder(
      rows: { fieldId: string; count: string }[] = [],
    ) {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        addSelect: jest.fn(),
        where: jest.fn(),
        groupBy: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      for (const key of ['select', 'addSelect', 'where', 'groupBy']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildAnalysesQueryBuilder(rows: unknown[] = []) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        take: jest.fn(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      for (const key of ['leftJoinAndMapOne', 'where', 'orderBy', 'take']) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildLatestRunsQueryBuilder(rows: unknown[] = []) {
      const qb: Record<string, jest.Mock> = {
        distinctOn: jest.fn(),
        leftJoinAndSelect: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      for (const key of [
        'distinctOn',
        'leftJoinAndSelect',
        'where',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    // Fixture "vacía" — usuario sin campos/schedules/análisis/auditoría. Cada test override lo
    // que necesita.
    function setupEmptyUserDetail() {
      usersService.findById.mockResolvedValue(buildUser());
      fieldRepo.find.mockResolvedValue([]);
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsCountQueryBuilder(),
      );
      fieldRepo.manager.query.mockResolvedValue([]);
      fieldAnalysisScheduleRepo.find.mockResolvedValue([]);
      analysisVerdictRepo.find.mockResolvedValue([]);
      analysisRepo.createQueryBuilder.mockReturnValue(
        buildAnalysesQueryBuilder([]),
      );
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildLatestRunsQueryBuilder([]),
      );
      auditLogService.list.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      });
      usersService.findByIds.mockResolvedValue([]);
    }

    it('devuelve 404 (NotFoundException) si el usuario no existe', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.getUserDetail('user-inexistente')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('devuelve datos básicos del usuario, nunca passwordHash', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ id: 'user-1', email: 'user@agroscorelatam.com' }),
      );
      setupEmptyUserDetail();

      const result = await service.getUserDetail('user-1');

      expect(result.user).toEqual(
        expect.objectContaining({
          id: 'user-1',
          email: 'user@agroscorelatam.com',
        }),
      );
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('incluye fields del usuario con analysisStatus/requiresAttention (mismas reglas que PR5)', async () => {
      setupEmptyUserDetail();
      fieldRepo.find.mockResolvedValue([
        {
          id: 'field-1',
          userId: 'user-1',
          name: 'Campo Norte',
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-1',
          id: 'analysis-1',
          status: 'Error',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: null,
          durationMs: null,
          globalScore: 0,
        },
      ]);

      const result = await service.getUserDetail('user-1');

      expect(result.fields).toHaveLength(1);
      expect(result.fields[0]).toEqual(
        expect.objectContaining({
          id: 'field-1',
          name: 'Campo Norte',
          analysisStatus: 'error',
          requiresAttention: true,
        }),
      );
    });

    it('calcula fieldsWithoutAnalysisCount y fieldsRequiringAttentionCount sobre TODOS los campos', async () => {
      setupEmptyUserDetail();
      fieldRepo.find.mockResolvedValue([
        {
          id: 'field-sin-analisis',
          userId: 'user-1',
          name: 'Sin análisis',
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        {
          id: 'field-con-error',
          userId: 'user-1',
          name: 'Con error',
          createdAt: new Date('2026-08-02T00:00:00.000Z'),
          updatedAt: new Date('2026-08-02T00:00:00.000Z'),
        },
      ]);
      // getLatestAnalysisByFieldId — solo field-con-error tiene análisis (Error).
      fieldRepo.manager.query.mockResolvedValueOnce([
        {
          targetFieldId: 'field-con-error',
          id: 'analysis-1',
          status: 'Error',
          createdAt: new Date('2026-08-10T00:00:00.000Z'),
          completedAt: null,
          durationMs: null,
          globalScore: 0,
        },
      ]);

      const result = await service.getUserDetail('user-1');

      expect(result.summary.fieldsCount).toBe(2);
      expect(result.summary.fieldsWithoutAnalysisCount).toBe(1);
      expect(result.summary.fieldsRequiringAttentionCount).toBe(1);
    });

    it('suma lotsCount de TODOS los campos del usuario, no solo los mostrados', async () => {
      setupEmptyUserDetail();
      fieldRepo.find.mockResolvedValue([
        {
          id: 'field-1',
          userId: 'user-1',
          name: 'Campo 1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'field-2',
          userId: 'user-1',
          name: 'Campo 2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsCountQueryBuilder([
          { fieldId: 'field-1', count: '3' },
          { fieldId: 'field-2', count: '2' },
        ]),
      );

      const result = await service.getUserDetail('user-1');

      expect(result.summary.lotsCount).toBe(5);
    });

    it('incluye analysesCount/completedAnalysesCount/failedAnalysesCount desde la query agregada', async () => {
      setupEmptyUserDetail();
      // Sin campos (fieldRepo.find → []), así que getLatestAnalysisByFieldId no llega a golpear
      // fieldRepo.manager.query (corta antes por fieldIds vacío) — la única llamada real es la
      // de getAnalysisCountsForUser, que consulta por userId directo.
      fieldRepo.manager.query.mockResolvedValueOnce([
        { total: '10', completed: '7', failed: '2' },
      ]);

      const result = await service.getUserDetail('user-1');

      expect(result.summary.analysesCount).toBe(10);
      expect(result.summary.completedAnalysesCount).toBe(7);
      expect(result.summary.failedAnalysesCount).toBe(2);
    });

    it('incluye recentAnalyses, ordenadas DESC y acotadas a USER_DETAIL_ANALYSES_LIMIT', async () => {
      setupEmptyUserDetail();
      const rows = [
        {
          id: 'analysis-2',
          fieldId: 'field-1',
          field: { id: 'field-1', name: 'Campo Norte' },
          lotName: 'Campo Norte',
          status: 'Finalizado',
          createdAt: new Date('2026-08-12T00:00:00.000Z'),
          completedAt: new Date('2026-08-12T01:00:00.000Z'),
          durationMs: 4000,
          globalScore: 65,
          errorMessage: null,
          reviewedAt: null,
        },
      ];
      const qb = buildAnalysesQueryBuilder(rows);
      analysisRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getUserDetail('user-1');

      expect(result.recentAnalyses).toEqual([
        expect.objectContaining({
          id: 'analysis-2',
          fieldName: 'Campo Norte',
          score: 65,
        }),
      ]);
      expect(qb.orderBy).toHaveBeenCalledWith('analysis.createdAt', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(USER_DETAIL_ANALYSES_LIMIT);
    });

    it('incluye scheduledAnalysis del usuario con latestRun/emailSentAt/weeklyTechnicalVerdict', async () => {
      setupEmptyUserDetail();
      fieldRepo.find.mockResolvedValue([
        {
          id: 'field-1',
          userId: 'user-1',
          name: 'Campo Norte',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          frequency: 'weekly',
          nextRunAt: null,
          lastRunAt: new Date('2026-08-24T09:00:00.000Z'),
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]);
      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildLatestRunsQueryBuilder([
          {
            id: 'run-1',
            scheduleId: 'schedule-1',
            status: 'completed',
            scheduledFor: '2026-08-24',
            analysisId: 'analysis-9',
            analysis: { status: 'Finalizado' },
            startedAt: new Date('2026-08-24T09:00:00.000Z'),
            completedAt: new Date('2026-08-24T09:05:00.000Z'),
            failedAt: null,
            emailSentAt: new Date('2026-08-24T09:10:00.000Z'),
            errorMessage: null,
            createdAt: new Date('2026-08-24T09:00:00.000Z'),
            updatedAt: new Date('2026-08-24T09:10:00.000Z'),
          },
        ]),
      );
      weeklyTechnicalVerdictService.findResponsesByScheduledRunIds.mockResolvedValue(
        new Map([
          [
            'run-1',
            {
              status: 'generated',
              verdict: 'favorable',
              trend: 'improving',
              confidence: 'high',
              summary: 'Mejora sostenida.',
              keyChanges: [],
              areasToReview: [],
              recommendations: [],
              limitations: [],
              previousSnapshotId: null,
              generatedAt: '2026-08-24T09:12:00.000Z',
              generator: 'deterministic-v1',
              promptVersion: null,
              errorMessage: null,
            },
          ],
        ]) as never,
      );

      const result = await service.getUserDetail('user-1');

      expect(result.scheduledAnalysis).toHaveLength(1);
      expect(result.scheduledAnalysis[0]).toEqual(
        expect.objectContaining({
          scheduleId: 'schedule-1',
          fieldId: 'field-1',
          fieldName: 'Campo Norte',
        }),
      );
      expect(result.scheduledAnalysis[0].latestRun).toEqual(
        expect.objectContaining({
          id: 'run-1',
          emailSentAt: '2026-08-24T09:10:00.000Z',
        }),
      );
      expect(result.scheduledAnalysis[0].weeklyTechnicalVerdict?.trend).toBe(
        'improving',
      );
    });

    it('calcula schedulesWithoutRunsCount usando EXISTS real (no lastRunAt)', async () => {
      setupEmptyUserDetail();
      fieldRepo.find.mockResolvedValue([
        {
          id: 'field-1',
          userId: 'user-1',
          name: 'Campo 1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      fieldAnalysisScheduleRepo.find.mockResolvedValue([
        {
          id: 'schedule-1',
          fieldId: 'field-1',
          enabled: true,
          frequency: 'weekly',
          nextRunAt: null,
          // lastRunAt seteado a propósito: el criterio real es EXISTS sobre
          // scheduled_analysis_runs, nunca esta columna.
          lastRunAt: new Date('2026-08-01T00:00:00.000Z'),
          createdAt: new Date(),
        },
      ]);
      // getScheduleIdsWithRuns → sin filas → ningún schedule tiene corridas reales.
      scheduledAnalysisRunRepo.manager.query.mockResolvedValue([]);

      const result = await service.getUserDetail('user-1');

      expect(result.summary.activeSchedulesCount).toBe(1);
      expect(result.summary.schedulesWithoutRunsCount).toBe(1);
    });

    it('incluye recentAuditLogs (targetType=user, targetId=userId) con el email del actor resuelto', async () => {
      setupEmptyUserDetail();
      auditLogService.list.mockResolvedValue({
        items: [
          {
            id: 'log-1',
            actorUserId: 'admin-1',
            action: 'admin.user.role_changed',
            targetType: 'user',
            targetId: 'user-1',
            before: null,
            after: null,
            ip: null,
            userAgent: null,
            createdAt: new Date('2026-08-20T00:00:00.000Z'),
          },
        ] as never,
        total: 1,
        page: 1,
        limit: 20,
      });
      usersService.findByIds.mockResolvedValue([
        buildUser({ id: 'admin-1', email: 'admin@agroscorelatam.com' }),
      ]);

      const result = await service.getUserDetail('user-1');

      expect(auditLogService.list).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'user', targetId: 'user-1' }),
      );
      expect(result.recentAuditLogs).toEqual([
        expect.objectContaining({
          id: 'log-1',
          action: 'admin.user.role_changed',
          actorEmail: 'admin@agroscorelatam.com',
        }),
      ]);
    });

    it('calcula sentEmailsCount vía ScheduledAnalysisRun.count (userId, emailSentAt no nulo)', async () => {
      setupEmptyUserDetail();
      scheduledAnalysisRunRepo.count.mockResolvedValue(4);

      const result = await service.getUserDetail('user-1');

      expect(result.summary.sentEmailsCount).toBe(4);
      expect(scheduledAnalysisRunRepo.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
    });
  });

  describe('listLots — filtros de trazabilidad (Admin PR 2)', () => {
    function buildLotsQueryBuilder(items: unknown[], total: number) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    it('filtra por fieldId ("ver lotes de este campo")', async () => {
      const qb = buildLotsQueryBuilder([], 0);
      fieldLotRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listLots({ page: 1, limit: 20, fieldId: 'field-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('lot."fieldId" = :fieldId', {
        fieldId: 'field-1',
      });
    });

    it('filtra por userId ("ver lotes de este usuario", vía el join a field)', async () => {
      const qb = buildLotsQueryBuilder([], 0);
      fieldLotRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listLots({ page: 1, limit: 20, userId: 'user-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('field."userId" = :userId', {
        userId: 'user-1',
      });
    });

    it('no agrega ningún filtro cuando ni fieldId ni userId vienen en el query', async () => {
      const qb = buildLotsQueryBuilder([], 0);
      fieldLotRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listLots({ page: 1, limit: 20 });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('listLots — contexto mínimo del campo (Admin PR 5)', () => {
    function buildLotsQueryBuilderWithItems(items: unknown[], total: number) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    function buildLotRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'lot-1',
        name: 'Lote 1',
        fieldId: 'field-1',
        field: {
          id: 'field-1',
          name: 'Campo Norte',
          userId: 'user-1',
          user: {
            id: 'user-1',
            email: 'owner@example.com',
            fullName: 'Owner Test',
          },
        },
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
        updatedAt: new Date('2026-08-01T10:00:00.000Z'),
        ...overrides,
      };
    }

    it('devuelve fieldHasAnalysis/fieldHasActiveMonitoring por lote, en lote (no N+1)', async () => {
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsQueryBuilderWithItems([buildLotRow()], 1),
      );
      fieldRepo.manager.query.mockResolvedValueOnce([{ id: 'field-1' }]);
      fieldAnalysisScheduleRepo.find.mockResolvedValueOnce([
        { id: 'schedule-1', fieldId: 'field-1', enabled: true },
      ]);

      const result = await service.listLots({ page: 1, limit: 20 });

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          fieldHasAnalysis: true,
          fieldHasActiveMonitoring: true,
        }),
      );
      expect(fieldRepo.manager.query).toHaveBeenCalledTimes(1);
      expect(fieldAnalysisScheduleRepo.find).toHaveBeenCalledTimes(1);
    });

    it('devuelve false para ambos cuando el campo no tiene análisis ni monitoreo activo', async () => {
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildLotsQueryBuilderWithItems([buildLotRow()], 1),
      );
      fieldRepo.manager.query.mockResolvedValueOnce([]);
      fieldAnalysisScheduleRepo.find.mockResolvedValueOnce([]);

      const result = await service.listLots({ page: 1, limit: 20 });

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          fieldHasAnalysis: false,
          fieldHasActiveMonitoring: false,
        }),
      );
    });
  });

  describe('listAnalysis — filtro analysisId (Admin PR 2)', () => {
    function buildAnalysisQueryBuilderForFilters(
      items: unknown[],
      total: number,
    ) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndMapOne',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    it('filtra por analysisId ("foco directo en un análisis puntual" desde Programados)', async () => {
      const qb = buildAnalysisQueryBuilderForFilters([], 0);
      analysisRepo.createQueryBuilder.mockReturnValue(qb);
      analysisVerdictRepo.find.mockResolvedValue([]);

      await service.listAnalysis({
        page: 1,
        limit: 20,
        analysisId: 'analysis-1',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('analysis.id = :analysisId', {
        analysisId: 'analysis-1',
      });
    });

    it('no agrega filtro de analysisId cuando no viene en el query', async () => {
      const qb = buildAnalysisQueryBuilderForFilters([], 0);
      analysisRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listAnalysis({ page: 1, limit: 20 });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes('analysis.id ='))).toBe(false);
    });
  });

  describe('listScheduledAnalysis — filtros de trazabilidad (Admin PR 2)', () => {
    function buildScheduleQueryBuilderForFilters(
      items: unknown[],
      total: number,
    ) {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        // Admin PR 3: getScheduledAnalysisSummary() reusa el mismo mock de createQueryBuilder
        // para el conteo NOT EXISTS de `withoutRuns` — default inocuo, estos tests no lo verifican.
        where: jest.fn(),
        getCount: jest.fn().mockResolvedValue(0),
        getManyAndCount: jest.fn().mockResolvedValue([items, total]),
      };
      for (const key of [
        'leftJoinAndMapOne',
        'orderBy',
        'skip',
        'take',
        'andWhere',
        'where',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    it('filtra por fieldId ("ver programados de este campo")', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        fieldId: 'field-1',
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'schedule."fieldId" = :fieldId',
        {
          fieldId: 'field-1',
        },
      );
    });

    it('filtra por userId ("ver programados de este usuario")', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        userId: 'user-1',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('schedule."userId" = :userId', {
        userId: 'user-1',
      });
    });

    it('filtra por enabled=true', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        enabled: true,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('schedule.enabled = :enabled', {
        enabled: true,
      });
    });

    it('filtra por enabled=false (no se confunde con "no vino en el query")', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        enabled: false,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('schedule.enabled = :enabled', {
        enabled: false,
      });
    });

    it('no agrega ningún filtro cuando ninguno viene en el query', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({ page: 1, limit: 20 });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('Admin PR 3: filtra por hasRuns=true con EXISTS real contra scheduled_analysis_runs', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        hasRuns: true,
      });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(
        sqlCalls.some(
          (sql) => sql.includes('EXISTS') && !sql.includes('NOT EXISTS'),
        ),
      ).toBe(true);
    });

    it('Admin PR 3: filtra por hasRuns=false con NOT EXISTS real, no lastRunAt', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        hasRuns: false,
      });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(sqlCalls.some((sql) => sql.includes('NOT EXISTS'))).toBe(true);
      expect(sqlCalls.some((sql) => sql.includes('lastRunAt'))).toBe(false);
    });

    it('Admin PR 3: no agrega filtro de hasRuns cuando no viene en el query', async () => {
      const qb = buildScheduleQueryBuilderForFilters([], 0);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listScheduledAnalysis({ page: 1, limit: 20 });

      const sqlCalls = qb.andWhere.mock.calls.map(([sql]: [string]) => sql);
      expect(
        sqlCalls.some((sql) => sql.includes('scheduled_analysis_runs')),
      ).toBe(false);
    });
  });

  describe('listScheduledAnalysis — resumen agregado (Admin PR 3)', () => {
    function buildMinimalScheduleQueryBuilder() {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndMapOne: jest.fn(),
        orderBy: jest.fn(),
        skip: jest.fn(),
        take: jest.fn(),
        andWhere: jest.fn(),
        where: jest.fn(),
        getCount: jest.fn().mockResolvedValue(5),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      for (const key of [
        'leftJoinAndMapOne',
        'orderBy',
        'skip',
        'take',
        'andWhere',
        'where',
      ]) {
        qb[key].mockReturnValue(qb);
      }
      return qb;
    }

    it('incluye un resumen global con total/active/inactive/withoutRuns', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildMinimalScheduleQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7) // active
        .mockResolvedValueOnce(3); // inactive
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.summary).toEqual(
        expect.objectContaining({
          total: 10,
          active: 7,
          inactive: 3,
          withoutRuns: 5,
        }),
      );
    });

    it('cuenta lastRunOk/lastRunFailed a partir de la corrida más reciente de cada schedule (DISTINCT ON)', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildMinimalScheduleQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count.mockResolvedValue(0);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([
        { status: 'completed', failedAt: null, emailSentAt: new Date() },
        { status: 'completed', failedAt: null, emailSentAt: null },
        { status: 'failed', failedAt: new Date(), emailSentAt: null },
      ]);
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.summary.lastRunOk).toBe(2);
      expect(result.summary.lastRunFailed).toBe(1);
    });

    it('mailPendingOrFailed cuenta corridas completed sin emailSentAt Y corridas failed con failedAt NULL (mail omitido), nunca failed con failedAt seteado (falla de pipeline)', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildMinimalScheduleQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count.mockResolvedValue(0);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([
        { status: 'completed', failedAt: null, emailSentAt: null }, // pendiente de envío
        { status: 'failed', failedAt: null, emailSentAt: null }, // mail omitido (schedule desactivado)
        { status: 'failed', failedAt: new Date(), emailSentAt: null }, // falla de pipeline, nunca llegó a mail
        { status: 'completed', failedAt: null, emailSentAt: new Date() }, // ya enviado
      ]);
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.summary.mailPendingOrFailed).toBe(2);
    });

    it('mailSentLast7Days/mailSentLast30Days cuentan corridas por emailSentAt en la ventana, vía scheduledAnalysisRunRepository.count', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildMinimalScheduleQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count.mockResolvedValue(0);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.count
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(15);

      const result = await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
      });

      expect(result.summary.mailSentLast7Days).toBe(4);
      expect(result.summary.mailSentLast30Days).toBe(15);
    });

    it('el resumen es global: no cambia según los filtros fieldId/userId/enabled/hasRuns de la página actual', async () => {
      const qb = buildMinimalScheduleQueryBuilder();
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(qb);
      fieldAnalysisScheduleRepo.count.mockResolvedValue(10);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);

      await service.listScheduledAnalysis({
        page: 1,
        limit: 20,
        userId: 'user-1',
        enabled: true,
        hasRuns: false,
      });

      // getScheduledAnalysisSummary() usa fieldAnalysisScheduleRepository.count() sin where — no
      // hereda ninguno de los filtros aplicados a la lista paginada.
      expect(fieldAnalysisScheduleRepo.count).toHaveBeenCalledWith();
    });

    it('no rompe el shape existente: items/total/page/limit siguen presentes junto a summary', async () => {
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(
        buildMinimalScheduleQueryBuilder(),
      );
      fieldAnalysisScheduleRepo.count.mockResolvedValue(0);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([]);
      scheduledAnalysisRunRepo.count.mockResolvedValue(0);

      const result = await service.listScheduledAnalysis({
        page: 2,
        limit: 10,
      });

      expect(result).toEqual(
        expect.objectContaining({
          items: [],
          total: 0,
          page: 2,
          limit: 10,
          summary: expect.any(Object),
        }),
      );
    });
  });

  describe('getProductAnalytics (KPIs P0 — auditoría de KPIs + Decision 1/2)', () => {
    const WEEK = { weekStart: '2026-08-31', weekEnd: '2026-09-06' }; // lunes-domingo
    // Retención usa su PROPIO par: N = week - 1, N+1 = week (ver getProductAnalytics) — nunca
    // week/week+1 como el resto de las métricas semanales.
    const RETENTION_WEEK = { weekStart: '2026-08-24', weekEnd: '2026-08-30' };

    function buildSufficientResultJson(): Record<string, unknown> {
      return {
        timeseries: [
          {
            rows: [
              { values: { NDVI_mean: 0.55, NDMI_mean: 0.2, NDVI_count: 12 } },
            ],
          },
        ],
      };
    }

    function buildPartialResultJson(): Record<string, unknown> {
      return {
        totalsByZone: [{ name: 'Zona 1', hectares: 5, percent: 100 }],
        zones: [{ area_ha: 5 }],
      };
    }

    // Configura los tres repos con `manager.query` compartido entre varias llamadas concurrentes
    // (computeNorthStar/computeRetention/computeQualityBreakdown/getScheduleHistoryCoverage/
    // getNonCanonicalSchedulesCount corren todas dentro de un mismo Promise.all) — discrimina por
    // el TEXTO del SQL en vez de depender del orden de invocación, así el test no se rompe si se
    // reordena el Promise.all del service.
    function mockSnapshotAndScheduleQueries(
      fixture: {
        // Denominador de retención (sufficientInWeekCount) — ÚNICO consumidor hoy de este count
        // "plano" en weeklyAnalysisSnapshotRepo; North Star ya no lo comparte (ver
        // computeNorthStar: ahora resuelve numerador Y denominador en una sola query combinada
        // contra fieldAnalysisScheduleTransitionRepo).
        retentionSufficientCount?: number;
        retainedCount?: number;
        breakdownRows?: { status: string; count: number }[];
        scheduleHistoryMinEffectiveAt?: Date | null;
        northStarEligibleFieldsCount?: number;
        northStarUsableFieldsCount?: number;
        nonCanonicalSchedulesCount?: number;
      } = {},
    ) {
      weeklyAnalysisSnapshotRepo.manager.query.mockImplementation(
        (sql: string) => {
          if (sql.includes('INTERSECT')) {
            return Promise.resolve([{ count: fixture.retainedCount ?? 0 }]);
          }
          if (sql.includes('GROUP BY')) {
            return Promise.resolve(
              (fixture.breakdownRows ?? []).map((row) => ({
                status: row.status,
                count: row.count,
              })),
            );
          }
          // Única query restante en este repo: denominador de retención.
          return Promise.resolve([
            { count: fixture.retentionSufficientCount ?? 0 },
          ]);
        },
      );

      fieldAnalysisScheduleTransitionRepo.manager.query.mockImplementation(
        (sql: string) => {
          if (sql.includes('MIN(')) {
            return Promise.resolve([
              { min: fixture.scheduleHistoryMinEffectiveAt ?? null },
            ]);
          }
          // Query combinada de North Star: numerador y denominador en una sola fila.
          return Promise.resolve([
            {
              eligibleFieldsCount: fixture.northStarEligibleFieldsCount ?? 0,
              usableFieldsCount: fixture.northStarUsableFieldsCount ?? 0,
            },
          ]);
        },
      );

      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue([
        { count: fixture.nonCanonicalSchedulesCount ?? 0 },
      ]);
    }

    // Simula el scan paginado de Analysis: `batches` es una lista de páginas, cada una un array de
    // filas {resultJson, completedAt, userId} — mockImplementation consume una página por llamada,
    // devolviendo [] (fin del scan) una vez agotadas.
    function mockActivationScan(
      batches: Array<
        Array<{ resultJson: unknown; completedAt: Date; userId: string }>
      >,
    ) {
      let call = 0;
      analysisRepo.manager.query.mockImplementation(() => {
        const page = batches[call] ?? [];
        call += 1;
        return Promise.resolve(page);
      });
    }

    beforeEach(() => {
      mockSnapshotAndScheduleQueries();
      mockActivationScan([]);
      usersService.listEligibleProducers.mockResolvedValue([]);
    });

    it('devuelve generatedAt, period.week y coverage', async () => {
      const result = await service.getProductAnalytics({ week: '2026-09-02' });

      expect(typeof result.generatedAt).toBe('string');
      expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
      expect(result.period).toEqual({
        week: WEEK,
        timezone: 'America/Argentina/Cordoba',
      });
      expect(result.coverage.scheduleHistory).toBeDefined();
      expect(result.coverage.analysisClassificationScan).toBeDefined();
    });

    describe('North Star (KPI #1 — campos con monitoreo utilizable semanal)', () => {
      it('POSITIVO: un snapshot sufficient entra en el numerador', async () => {
        mockSnapshotAndScheduleQueries({
          northStarUsableFieldsCount: 3,
          northStarEligibleFieldsCount: 5,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.northStar).toEqual({
          week: WEEK,
          usableFieldsCount: 3,
          eligibleFieldsCount: 5,
          rate: 3 / 5,
        });
      });

      it('NEGATIVO: denominador 0 → rate null, nunca 0 ni una división por cero visible', async () => {
        mockSnapshotAndScheduleQueries({
          northStarUsableFieldsCount: 0,
          northStarEligibleFieldsCount: 0,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.northStar.rate).toBeNull();
      });

      // North Star (query combinada eligibleFieldsCount+usableFieldsCount) corre sobre
      // fieldAnalysisScheduleTransitionRepo.manager.query, en la MISMA llamada que
      // getScheduleHistoryCoverage (que filtra por 'MIN(') — se distingue por exclusión.
      function findNorthStarQueryCall(): [string, unknown[]] {
        const call =
          fieldAnalysisScheduleTransitionRepo.manager.query.mock.calls.find(
            ([sql]: [string]) => !sql.includes('MIN('),
          );
        if (!call) {
          throw new Error(
            'No se encontró la query combinada de North Star en los mocks.',
          );
        }
        return call as [string, unknown[]];
      }

      describe('cutoff canónico (decisión de producto: lunes 09:00 America/Argentina/Cordoba)', () => {
        it('el cutoff es lunes 09:00 de la semana consultada — NUNCA el cierre del domingo', async () => {
          mockSnapshotAndScheduleQueries();

          await service.getProductAnalytics({ week: '2026-09-02' }); // semana 2026-08-31..09-06

          const [, params] = findNorthStarQueryCall();
          const cutoffParam = params[5] as Date; // $6 en la query — ver computeNorthStar.
          // Lunes 2026-08-31, 09:00 America/Argentina/Cordoba (UTC-3) = 12:00 UTC. Si esto fallara
          // con 2026-09-07T02:59:59.999Z, el cutoff volvió a ser el cierre del domingo (el bug).
          expect(cutoffParam.toISOString()).toBe('2026-08-31T12:00:00.000Z');
        });

        it('activación exactamente en el cutoff: el filtro usa <= (inclusive), nunca < estricto', async () => {
          mockSnapshotAndScheduleQueries();

          await service.getProductAnalytics({ week: '2026-09-02' });

          const [sql] = findNorthStarQueryCall();
          expect(sql).toContain('t."effectiveAt" <= $6');
        });

        it('recalcula el cutoff correctamente para una semana explícita distinta', async () => {
          mockSnapshotAndScheduleQueries();

          await service.getProductAnalytics({ week: '2026-09-10' }); // semana 2026-09-07..09-13

          const [, params] = findNorthStarQueryCall();
          const cutoffParam = params[5] as Date;
          // Lunes 2026-09-07, 09:00 ART = 12:00 UTC.
          expect(cutoffParam.toISOString()).toBe('2026-09-07T12:00:00.000Z');
        });
      });

      it('filtra por la configuración CANÓNICA exacta (frequency/dayOfWeek/hour/minute/timezone) — cualquier otra queda fuera', async () => {
        mockSnapshotAndScheduleQueries();

        await service.getProductAnalytics({ week: '2026-09-02' });

        const [sql, params] = findNorthStarQueryCall();
        expect(sql).toContain('frequency = $1');
        expect(sql).toContain('"dayOfWeek" = $2');
        expect(sql).toContain('hour = $3');
        expect(sql).toContain('minute = $4');
        expect(sql).toContain('timezone = $5');
        expect(params.slice(0, 5)).toEqual([
          'weekly',
          1, // lunes
          9,
          0,
          'America/Argentina/Cordoba',
        ]);
      });

      it('el numerador queda estructuralmente subordinado al denominador — INNER JOIN contra el mismo universo elegible, nunca una query independiente', async () => {
        mockSnapshotAndScheduleQueries();

        await service.getProductAnalytics({ week: '2026-09-02' });

        const [sql] = findNorthStarQueryCall();
        expect(sql).toContain('INNER JOIN eligible_fields');
        // La misma CTE de elegibles alimenta ambos SELECT del resultado — nunca dos fuentes que
        // puedan divergir.
        expect(sql.match(/eligible_fields/g)?.length).toBeGreaterThanOrEqual(2);
      });

      it('la cuenta de schedules no canónicos NUNCA entra al denominador ni al numerador de North Star — se expone aparte en coverage', async () => {
        mockSnapshotAndScheduleQueries({
          northStarUsableFieldsCount: 3,
          northStarEligibleFieldsCount: 5,
          nonCanonicalSchedulesCount: 2,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.northStar).toEqual({
          week: WEEK,
          usableFieldsCount: 3,
          eligibleFieldsCount: 5,
          rate: 3 / 5,
        });
        expect(result.coverage.nonCanonicalSchedules).toEqual({ count: 2 });
      });

      it('la consulta de schedules no canónicos es sobre la configuración VIGENTE (field_analysis_schedules), no reconstruida por semana', async () => {
        mockSnapshotAndScheduleQueries({ nonCanonicalSchedulesCount: 4 });

        await service.getProductAnalytics({ week: '2026-09-02' });

        expect(fieldAnalysisScheduleRepo.manager.query).toHaveBeenCalledWith(
          expect.stringContaining('field_analysis_schedules'),
          expect.arrayContaining([
            'weekly',
            1,
            9,
            0,
            'America/Argentina/Cordoba',
          ]),
        );
      });

      it('sin schedules no canónicos: coverage.nonCanonicalSchedules.count es 0, no se omite el campo', async () => {
        mockSnapshotAndScheduleQueries();

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.nonCanonicalSchedules).toEqual({ count: 0 });
      });
    });

    describe('Retención (KPI #4)', () => {
      it('POSITIVO: field sufficient en N y N+1 cuenta como retenido — N/N+1 son week-1/week, nunca week/week+1', async () => {
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 4,
          retainedCount: 2,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.retention).toEqual({
          week: RETENTION_WEEK,
          nextWeek: WEEK,
          periodComplete: true,
          sufficientInWeekCount: 4,
          retainedInNextWeekCount: 2,
          rate: 2 / 4,
        });
      });

      it('NEGATIVO: partial (o insufficient) en N+1 nunca cuenta como retenido — el INTERSECT ya filtra por dataQualityStatus=sufficient en ambos lados', async () => {
        // El propio SQL (ver computeRetention) exige 'sufficient' en AMBAS mitades del INTERSECT —
        // este test fija retainedCount en 0 para representar exactamente ese caso (el field tenía
        // snapshot en N+1, pero no sufficient, así que el INTERSECT real no lo habría devuelto).
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 1,
          retainedCount: 0,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.retention.retainedInNextWeekCount).toBe(0);
        expect(result.retention.rate).toBe(0);
      });

      it('denominador 0 (con período completo) → rate null', async () => {
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 0,
          retainedCount: 0,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.retention.periodComplete).toBe(true);
        expect(result.retention.rate).toBeNull();
      });

      it('DEFAULT (sin `week`): N = penúltima semana completa, N+1 = última semana completa — N+1 nunca es la semana en curso', async () => {
        const fixedNow = new Date('2026-09-08T15:00:00Z'); // martes, mitad de semana
        jest.useFakeTimers().setSystemTime(fixedNow);

        try {
          mockSnapshotAndScheduleQueries({
            retentionSufficientCount: 4,
            retainedCount: 2,
          });

          const result = await service.getProductAnalytics({});

          // period.week (última semana completa) = 2026-08-31..09-06 (ver test de "Semanas y
          // timezone" más abajo). Retención: N = semana anterior a esa, N+1 = esa misma.
          expect(result.retention.week).toEqual(RETENTION_WEEK);
          expect(result.retention.nextWeek).toEqual(WEEK);
          expect(result.retention.periodComplete).toBe(true);
          expect(result.retention.rate).not.toBeNull();
        } finally {
          jest.useRealTimers();
        }
      });

      it('QUERY HISTÓRICA con N+1 completa: calcula un rate definitivo', async () => {
        // 2026-09-02 (WEEK) ya terminó hace mucho respecto de la fecha real de ejecución del test.
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 4,
          retainedCount: 2,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.retention.periodComplete).toBe(true);
        expect(result.retention.rate).toBe(0.5);
      });

      it('QUERY cuya N+1 está EN CURSO: no devuelve un rate definitivo, ni siquiera con snapshots parciales reales', async () => {
        const fixedNow = new Date('2026-09-10T12:00:00Z'); // jueves, dentro de la semana pedida
        jest.useFakeTimers().setSystemTime(fixedNow);

        try {
          // Semana pedida = 2026-09-07..09-13, la MISMA semana en la que "ahora" cae — todavía no
          // terminó. Snapshots parciales reales (no cero) para demostrar que el conteo no se
          // fabrica en cero, pero el rate igual se anula.
          mockSnapshotAndScheduleQueries({
            retentionSufficientCount: 3,
            retainedCount: 1,
          });

          const result = await service.getProductAnalytics({
            week: '2026-09-10',
          });

          expect(result.retention.nextWeek).toEqual({
            weekStart: '2026-09-07',
            weekEnd: '2026-09-13',
          });
          expect(result.retention.periodComplete).toBe(false);
          expect(result.retention.rate).toBeNull();
          // Los conteos NO se anulan ni se ponen en 0 artificialmente — son el dato real hasta ahora.
          expect(result.retention.sufficientInWeekCount).toBe(3);
          expect(result.retention.retainedInNextWeekCount).toBe(1);
        } finally {
          jest.useRealTimers();
        }
      });

      it('QUERY de una semana FUTURA: tampoco produce una retención válida', async () => {
        const fixedNow = new Date('2026-09-08T12:00:00Z'); // martes
        jest.useFakeTimers().setSystemTime(fixedNow);

        try {
          mockSnapshotAndScheduleQueries({
            retentionSufficientCount: 0,
            retainedCount: 0,
          });

          // 2026-10-01 cae semanas después de "ahora" — completamente futura.
          const result = await service.getProductAnalytics({
            week: '2026-10-01',
          });

          expect(result.retention.periodComplete).toBe(false);
          expect(result.retention.rate).toBeNull();
        } finally {
          jest.useRealTimers();
        }
      });

      it('BOUNDARY exacto: un milisegundo antes del cierre de N+1 todavía no está completa; en el instante exacto de cierre, sí', async () => {
        // N+1 = 2026-09-07..09-13 (domingo). Cierre real (America/Argentina/Cordoba, UTC-3):
        // 2026-09-14T02:59:59.999Z.
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 1,
          retainedCount: 1,
        });

        jest
          .useFakeTimers()
          .setSystemTime(new Date('2026-09-14T02:59:59.998Z'));
        try {
          const before = await service.getProductAnalytics({
            week: '2026-09-10',
          });
          expect(before.retention.periodComplete).toBe(false);
          expect(before.retention.rate).toBeNull();
        } finally {
          jest.useRealTimers();
        }

        jest
          .useFakeTimers()
          .setSystemTime(new Date('2026-09-14T02:59:59.999Z'));
        try {
          const atClose = await service.getProductAnalytics({
            week: '2026-09-10',
          });
          expect(atClose.retention.periodComplete).toBe(true);
          expect(atClose.retention.rate).not.toBeNull();
        } finally {
          jest.useRealTimers();
        }
      });

      it('el INTERSECT sigue comparando identidad de fieldId (no se toca la lógica de comparación)', async () => {
        mockSnapshotAndScheduleQueries({
          retentionSufficientCount: 5,
          retainedCount: 3,
        });

        await service.getProductAnalytics({ week: '2026-09-02' });

        const intersectCall =
          weeklyAnalysisSnapshotRepo.manager.query.mock.calls.find(
            ([sql]: [string]) => sql.includes('INTERSECT'),
          );
        expect(intersectCall).toBeDefined();
        const [sql] = intersectCall as [string];
        expect(sql).toContain('INTERSECT');
        expect(sql).toContain('"fieldId"');
      });
    });

    describe('Breakdown de calidad (KPI #5)', () => {
      it('POSITIVO: conserva las tres categorías aunque falten en el resultado de la query', async () => {
        mockSnapshotAndScheduleQueries({
          breakdownRows: [{ status: 'sufficient', count: 5 }],
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.qualityBreakdown.breakdown).toEqual([
          { status: 'sufficient', count: 5, proportion: 1 },
          { status: 'partial', count: 0, proportion: 0 },
          { status: 'insufficient', count: 0, proportion: 0 },
        ]);
        expect(result.qualityBreakdown.totalSnapshots).toBe(5);
      });

      it('nunca llama "error" a partial/insufficient — el shape solo usa `status`, sin severidad', async () => {
        mockSnapshotAndScheduleQueries({
          breakdownRows: [
            { status: 'sufficient', count: 1 },
            { status: 'partial', count: 2 },
            { status: 'insufficient', count: 3 },
          ],
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(Object.keys(result.qualityBreakdown.breakdown[0])).toEqual([
          'status',
          'count',
          'proportion',
        ]);
      });

      it('cero snapshots en la semana: counts en 0 y proportion null (no 0/0)', async () => {
        mockSnapshotAndScheduleQueries({ breakdownRows: [] });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.qualityBreakdown.totalSnapshots).toBe(0);
        result.qualityBreakdown.breakdown.forEach((entry) => {
          expect(entry.count).toBe(0);
          expect(entry.proportion).toBeNull();
        });
      });
    });

    describe('Cobertura del historial de schedules (ticket anterior)', () => {
      it('sin ninguna transición todavía: availableFrom null y complete false', async () => {
        mockSnapshotAndScheduleQueries({ scheduleHistoryMinEffectiveAt: null });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.scheduleHistory).toEqual({
          availableFrom: null,
          complete: false,
        });
      });

      it('semana consultada anterior a la baseline: complete false', async () => {
        // La baseline es POSTERIOR al lunes de la semana consultada (2026-08-31).
        mockSnapshotAndScheduleQueries({
          scheduleHistoryMinEffectiveAt: new Date('2026-09-05T00:00:00Z'),
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.scheduleHistory.complete).toBe(false);
      });

      it('semana consultada posterior a la baseline: complete true', async () => {
        mockSnapshotAndScheduleQueries({
          scheduleHistoryMinEffectiveAt: new Date('2026-01-01T00:00:00Z'),
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.scheduleHistory.complete).toBe(true);
      });

      it('la cobertura se evalúa contra el CUTOFF real (lunes 09:00), no contra el cierre de semana ni la medianoche del lunes — ajuste de este ticket', async () => {
        // Lunes 2026-08-31: medianoche local = 03:00 UTC, cutoff canónico (09:00 local) = 12:00 UTC.
        // Una baseline entre esos dos instantes es EXACTAMENTE el caso que este ticket corrige: con
        // el criterio viejo (medianoche) habría dado complete=false; con el cutoff real (09:00),
        // la baseline ya estaba establecida ANTES de que la elegibilidad se evaluara → complete=true.
        mockSnapshotAndScheduleQueries({
          scheduleHistoryMinEffectiveAt: new Date('2026-08-31T08:00:00Z'),
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.scheduleHistory.complete).toBe(true);
      });

      it('baseline establecida DESPUÉS del cutoff (pero el mismo día lunes): complete false', async () => {
        // 2026-08-31T13:00:00Z es posterior al cutoff (12:00 UTC) del mismo lunes.
        mockSnapshotAndScheduleQueries({
          scheduleHistoryMinEffectiveAt: new Date('2026-08-31T13:00:00Z'),
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.scheduleHistory.complete).toBe(false);
      });
    });

    describe('Activation (KPI #2) y Time to First Technical Value (KPI #3)', () => {
      it('Cero usuarios elegibles: todo en 0, rates null, scan nunca se dispara', async () => {
        usersService.listEligibleProducers.mockResolvedValue([]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.activation).toEqual({
          eligibleUsersCount: 0,
          activatedUsersCount: 0,
          rate: null,
        });
        expect(result.timeToFirstTechnicalValue).toEqual({
          cohortUsersCount: 0,
          activatedUsersCount: 0,
          notActivatedUsersCount: 0,
          p50Hours: null,
          p75Hours: null,
          p95Hours: null,
        });
        expect(analysisRepo.manager.query).not.toHaveBeenCalled();
      });

      it('POSITIVO: un Analysis sufficient activa al usuario en su completedAt', async () => {
        const createdAt = new Date('2026-08-01T00:00:00Z');
        const completedAt = new Date('2026-08-03T12:00:00Z');
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt },
        ]);
        mockActivationScan([
          [
            {
              resultJson: buildSufficientResultJson(),
              completedAt,
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.activation).toEqual({
          eligibleUsersCount: 1,
          activatedUsersCount: 1,
          rate: 1,
        });
        expect(result.timeToFirstTechnicalValue.activatedUsersCount).toBe(1);
        expect(result.timeToFirstTechnicalValue.notActivatedUsersCount).toBe(0);
        expect(result.timeToFirstTechnicalValue.p50Hours).toBe(60); // 2.5 días = 60hs
      });

      it('POSITIVO: varios Analysis sufficient del mismo usuario conservan el PRIMER completedAt', async () => {
        const createdAt = new Date('2026-08-01T00:00:00Z');
        const first = new Date('2026-08-02T00:00:00Z');
        const second = new Date('2026-08-10T00:00:00Z');
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt },
        ]);
        // ORDER BY completedAt ASC real — el mock ya devuelve las filas en ese orden, como haría Postgres.
        mockActivationScan([
          [
            {
              resultJson: buildSufficientResultJson(),
              completedAt: first,
              userId: 'user-1',
            },
            {
              resultJson: buildSufficientResultJson(),
              completedAt: second,
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        // 1 día entre createdAt y el PRIMER completedAt (first), no el segundo (9 días).
        expect(result.timeToFirstTechnicalValue.p50Hours).toBe(24);
      });

      it('NEGATIVO: partial no activa', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([
          [
            {
              resultJson: buildPartialResultJson(),
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.activation.activatedUsersCount).toBe(0);
      });

      it('NEGATIVO: insufficient no activa', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([
          [
            {
              resultJson: {},
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.activation.activatedUsersCount).toBe(0);
      });

      it('NEGATIVO: Analysis Finalizado con resultJson=null no activa (extractSnapshotMetrics/classifyDataQuality ya degradan a insufficient, nunca lanzan)', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([
          [
            {
              resultJson: null,
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        await expect(
          service.getProductAnalytics({ week: '2026-09-02' }),
        ).resolves.toBeDefined();
        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });
        expect(result.activation.activatedUsersCount).toBe(0);
      });

      it('NEGATIVO: dos fields sufficient del mismo usuario no inflan activatedUsersCount', async () => {
        const createdAt = new Date('2026-08-01T00:00:00Z');
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt },
        ]);
        mockActivationScan([
          [
            {
              resultJson: buildSufficientResultJson(),
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
            {
              resultJson: buildSufficientResultJson(),
              completedAt: new Date('2026-08-03T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.activation.activatedUsersCount).toBe(1);
      });

      it('NEGATIVO: no hay ninguna métrica que mezcle unidades users/fields (activation y northStar son independientes)', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
          { id: 'user-2', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([]);
        mockSnapshotAndScheduleQueries({
          northStarUsableFieldsCount: 7,
          northStarEligibleFieldsCount: 9,
        });

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        // activation cuenta USERS (2 elegibles, 0 activados) — northStar cuenta FIELDS (7/9) — sin
        // ningún campo que combine ambos denominadores/numeradores entre sí.
        expect(result.activation.eligibleUsersCount).toBe(2);
        expect(result.northStar.eligibleFieldsCount).toBe(9);
        expect(Object.keys(result)).not.toContain('funnel');
        expect(Object.keys(result)).not.toContain('conversionFromPrevious');
      });

      it('coverage.analysisClassificationScan refleja cuántas filas se inspeccionaron, sin truncar cuando el scan se agota solo', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([
          [
            {
              resultJson: {},
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });

        expect(result.coverage.analysisClassificationScan).toEqual({
          scanned: 1,
          limit: 5000,
          truncated: false,
        });
      });

      it('CURSOR DE PAGINACIÓN: usa (completedAt, id) como clave compuesta — nunca solo completedAt, que podría saltear para siempre una fila empatada que cae del otro lado de un corte de lote (no "incompleto", directamente incorrecto)', async () => {
        usersService.listEligibleProducers.mockResolvedValue([
          { id: 'user-1', createdAt: new Date('2026-08-01T00:00:00Z') },
        ]);
        mockActivationScan([
          [
            {
              resultJson: {},
              completedAt: new Date('2026-08-02T00:00:00Z'),
              userId: 'user-1',
            },
          ],
        ]);

        await service.getProductAnalytics({ week: '2026-09-02' });

        const [sql] = analysisRepo.manager.query.mock.calls[0] as [string];
        // ORDER BY con desempate por id — sin esto, dos Analysis con el mismo completedAt exacto
        // pueden caer en lados opuestos de un LIMIT, y un cursor de una sola columna con ">"
        // estricto nunca vuelve a pedir la fila que quedó del lado equivocado.
        expect(sql).toContain('ORDER BY a."completedAt" ASC, a.id ASC');
        // Filtro del cursor: además de completedAt > $1, compara por id cuando hay empate exacto.
        expect(sql).toMatch(
          /a\."completedAt"\s*=\s*\$1\s+AND\s+a\.id\s*>\s*\$4/,
        );
      });
    });

    describe('Semanas y timezone', () => {
      it('sin `week`: usa la última semana calendario completa antes de ahora (nunca la semana en curso)', async () => {
        const fixedNow = new Date('2026-09-08T15:00:00Z'); // martes
        jest.useFakeTimers().setSystemTime(fixedNow);

        try {
          const result = await service.getProductAnalytics({});
          expect(result.period.week).toEqual({
            weekStart: '2026-08-31',
            weekEnd: '2026-09-06',
          });
        } finally {
          jest.useRealTimers();
        }
      });

      it('con `week` explícito: resuelve la semana calendario que contiene esa fecha', async () => {
        const result = await service.getProductAnalytics({
          week: '2026-09-10',
        }); // jueves
        expect(result.period.week).toEqual({
          weekStart: '2026-09-07',
          weekEnd: '2026-09-13',
        });
      });

      it('expone siempre el timezone explícito usado', async () => {
        const result = await service.getProductAnalytics({
          week: '2026-09-02',
        });
        expect(result.period.timezone).toBe('America/Argentina/Cordoba');
      });
    });
  });

  describe('getSystemHealth', () => {
    it('devuelve la estructura esperada', async () => {
      const fieldRepoManager = fieldRepo.manager;
      fieldRepoManager.query.mockResolvedValue([{ '?column?': 1 }]);
      analysisRepo.findOne.mockResolvedValue(null);
      pythonWorkerService.checkHealth.mockResolvedValue({ status: 'ok' });

      const health = await service.getSystemHealth();

      expect(health).toEqual(
        expect.objectContaining({
          api: { status: 'ok' },
          db: expect.objectContaining({ status: 'ok' }),
          worker: expect.objectContaining({ status: 'ok' }),
          earthEngine: expect.objectContaining({ status: 'not_checked' }),
          lastSuccessfulAnalysis: null,
          lastFailedAnalysis: null,
          uptimeSeconds: expect.any(Number),
          timestamp: expect.any(String),
        }),
      );
      expect(health).toHaveProperty('currentBackendCommit');
    });

    it('reporta db.status=error si la query falla, sin tirar la request abajo', async () => {
      const fieldRepoManager = fieldRepo.manager;
      fieldRepoManager.query.mockRejectedValue(new Error('connection refused'));
      analysisRepo.findOne.mockResolvedValue(null);

      const health = await service.getSystemHealth();

      expect(health.db.status).toBe('error');
    });
  });
});
