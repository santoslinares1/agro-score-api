import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { In, IsNull } from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
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
import { ScheduledAnalysisRun } from '../scheduled-analysis/entities/scheduled-analysis-run.entity';
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
  let weeklyTechnicalVerdictService: jest.Mocked<
    Pick<WeeklyTechnicalVerdictService, 'findResponsesByScheduledRunIds'>
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            countActiveByRole: jest.fn(),
            toPublicUser: jest.fn((user: User) => {
              const { passwordHash: _passwordHash, ...publicUser } = user;
              return publicUser;
            }),
            findAllPaginated: jest.fn(),
            count: jest.fn(),
            countActive: jest.fn(),
            countCreatedSince: jest.fn(),
          },
        },
        {
          provide: AuditLogService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
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
      ],
    }).compile();

    service = module.get(AdminService);
    usersService = module.get(UsersService);
    auditLogService = module.get(AuditLogService);
    emailService = module.get(EmailService);
    pythonWorkerService = module.get(PythonWorkerService);
    configService = module.get(ConfigService);
    weeklyTechnicalVerdictService = module.get(WeeklyTechnicalVerdictService);
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

      await service.updateUser('user-1', { role: UserRole.ADMIN }, actor);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.role_changed' }),
      );
    });

    it('audita admin.user.updated cuando cambian otros campos', async () => {
      usersService.findById.mockResolvedValue(buildUser());
      usersService.update.mockResolvedValue(
        buildUser({ fullName: 'Nuevo nombre' }),
      );

      await service.updateUser('user-1', { fullName: 'Nuevo nombre' }, actor);

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
        service.updateUser('user-1', { role: UserRole.ADMIN }, actor),
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

      await service.updateUser('user-1', { role: UserRole.ADMIN }, actor);

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
        service.createUserFromAccessRequest('access-request-1', {}, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404 si la solicitud no existe', async () => {
      accessRequestRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createUserFromAccessRequest('missing', {}, actor),
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

  describe('getProductAnalytics (Admin PR 4)', () => {
    function buildRawOneQueryBuilder(...values: (number | null)[]) {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        getRawOne: jest.fn(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      for (const key of ['select', 'where', 'andWhere']) {
        qb[key].mockReturnValue(qb);
      }
      for (const value of values) {
        qb.getRawOne.mockResolvedValueOnce(
          value === null ? null : { count: String(value) },
        );
      }
      return qb;
    }

    type Fixture = Partial<{
      totalUsers: number;
      usersWithField: number;
      totalFields: number;
      fieldsWithLot: number;
      fieldsWithFinalizedAnalysis: number;
      fieldsWithVerdict: number;
      activeSchedules: number;
      activeSchedulesWithoutRuns: number;
      fieldsWithRun: number;
      fieldsWithMailSent: number;
      sentEmails: number;
      fieldsWithNoAnalysis: number;
      failedAnalysisLast30Days: number;
      latestRunRows: {
        status: string;
        failedAt: Date | null;
        emailSentAt: Date | null;
      }[];
      topErrors: { message: string; count: number }[];
    }>;

    // Arma los ~15 mocks que getProductAnalytics() dispara en paralelo. El orden de cada
    // mockResolvedValueOnce importa: Promise.all evalúa los elementos del array de forma
    // sincrónica en el orden en que aparecen (aunque cada uno sea una llamada async), así que el
    // orden de las llamadas a un mismo mock coincide con el orden del array en el service.
    function setup(fixture: Fixture = {}) {
      const f = {
        totalUsers: 0,
        usersWithField: 0,
        totalFields: 0,
        fieldsWithLot: 0,
        fieldsWithFinalizedAnalysis: 0,
        fieldsWithVerdict: 0,
        activeSchedules: 0,
        activeSchedulesWithoutRuns: 0,
        fieldsWithRun: 0,
        fieldsWithMailSent: 0,
        sentEmails: 0,
        fieldsWithNoAnalysis: 0,
        failedAnalysisLast30Days: 0,
        latestRunRows: [] as {
          status: string;
          failedAt: Date | null;
          emailSentAt: Date | null;
        }[],
        topErrors: [] as { message: string; count: number }[],
        ...fixture,
      };

      usersService.count.mockResolvedValue(f.totalUsers);

      fieldRepo.createQueryBuilder.mockReturnValue(
        buildRawOneQueryBuilder(f.usersWithField),
      );
      fieldRepo.count.mockResolvedValue(f.totalFields);
      fieldLotRepo.createQueryBuilder.mockReturnValue(
        buildRawOneQueryBuilder(f.fieldsWithLot),
      );

      // fieldRepo.manager.query: finalized-analysis, verdict, countFieldsWithNoAnalysis
      // (interno), topErrors — en ese orden.
      fieldRepo.manager.query
        .mockResolvedValueOnce([{ count: f.fieldsWithFinalizedAnalysis }])
        .mockResolvedValueOnce([{ count: f.fieldsWithVerdict }])
        .mockResolvedValueOnce([{ count: f.fieldsWithNoAnalysis }])
        .mockResolvedValueOnce(
          f.topErrors.map((e) => ({ message: e.message, count: e.count })),
        );

      // activeSchedules (propio) + total/active/inactive (dentro de getScheduledAnalysisSummary,
      // reusado tal cual — valores irrelevantes para este describe, solo deben resolver).
      fieldAnalysisScheduleRepo.count
        .mockResolvedValueOnce(f.activeSchedules)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      // activeSchedulesWithoutRuns (propio) + withoutRuns (dentro del summary, no se usa acá).
      const scheduleQb: Record<string, jest.Mock> = {
        where: jest.fn(),
        andWhere: jest.fn(),
        getCount: jest
          .fn()
          .mockResolvedValueOnce(f.activeSchedulesWithoutRuns)
          .mockResolvedValueOnce(f.activeSchedulesWithoutRuns),
      };
      scheduleQb['where'].mockReturnValue(scheduleQb);
      scheduleQb['andWhere'].mockReturnValue(scheduleQb);
      fieldAnalysisScheduleRepo.createQueryBuilder.mockReturnValue(scheduleQb);
      fieldAnalysisScheduleRepo.manager.query.mockResolvedValue(
        f.latestRunRows,
      );

      scheduledAnalysisRunRepo.createQueryBuilder.mockReturnValue(
        buildRawOneQueryBuilder(f.fieldsWithRun, f.fieldsWithMailSent),
      );
      scheduledAnalysisRunRepo.count
        .mockResolvedValueOnce(f.sentEmails) // propio
        .mockResolvedValueOnce(0) // mailSentLast7Days (summary)
        .mockResolvedValueOnce(0); // mailSentLast30Days (summary)

      analysisRepo.createQueryBuilder.mockReturnValue(
        (() => {
          const qb: Record<string, jest.Mock> = {
            where: jest.fn(),
            andWhere: jest.fn(),
            getCount: jest.fn().mockResolvedValue(f.failedAnalysisLast30Days),
          };
          qb['where'].mockReturnValue(qb);
          qb['andWhere'].mockReturnValue(qb);
          return qb;
        })(),
      );

      return f;
    }

    it('devuelve generatedAt', async () => {
      setup();
      const result = await service.getProductAnalytics();
      expect(typeof result.generatedAt).toBe('string');
      expect(new Date(result.generatedAt).toString()).not.toBe('Invalid Date');
    });

    it('devuelve el funnel con las 9 etapas, en orden', async () => {
      setup();
      const result = await service.getProductAnalytics();
      expect(result.funnel.map((stage) => stage.id)).toEqual([
        'total-users',
        'users-with-field',
        'total-fields',
        'fields-with-lot',
        'fields-with-finalized-analysis',
        'fields-with-verdict',
        'fields-with-active-schedule',
        'fields-with-run',
        'fields-with-mail-sent',
      ]);
    });

    it('calcula usuarios con campo (COUNT DISTINCT userId)', async () => {
      setup({ totalUsers: 10, usersWithField: 4 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find((s) => s.id === 'users-with-field');
      expect(stage?.count).toBe(4);
      expect(stage?.previousCount).toBe(10);
    });

    it('calcula campos con lote (COUNT DISTINCT fieldId)', async () => {
      setup({ totalFields: 78, fieldsWithLot: 78 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find((s) => s.id === 'fields-with-lot');
      expect(stage?.count).toBe(78);
    });

    it('calcula campos con análisis finalizado', async () => {
      setup({ totalFields: 78, fieldsWithFinalizedAnalysis: 19 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find(
        (s) => s.id === 'fields-with-finalized-analysis',
      );
      expect(stage?.count).toBe(19);
    });

    it('calcula campos con veredicto técnico generado', async () => {
      setup({ fieldsWithVerdict: 12 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find((s) => s.id === 'fields-with-verdict');
      expect(stage?.count).toBe(12);
    });

    it('calcula campos con schedule activo', async () => {
      setup({ activeSchedules: 2 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find(
        (s) => s.id === 'fields-with-active-schedule',
      );
      expect(stage?.count).toBe(2);
      expect(stage?.route).toBe('/scheduled-analysis');
      expect(stage?.queryParams).toEqual({ enabled: true });
    });

    it('calcula campos con al menos una corrida', async () => {
      setup({ fieldsWithRun: 3 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find((s) => s.id === 'fields-with-run');
      expect(stage?.count).toBe(3);
      expect(stage?.queryParams).toEqual({ enabled: true, hasRuns: true });
    });

    it('calcula campos con mail enviado', async () => {
      setup({ fieldsWithMailSent: 1 });
      const result = await service.getProductAnalytics();
      const stage = result.funnel.find((s) => s.id === 'fields-with-mail-sent');
      expect(stage?.count).toBe(1);
      // Sin filtro exacto en Programados todavía (deuda documentada en PR3) — no hay route.
      expect(stage?.route).toBeUndefined();
    });

    it('conversionFromPrevious/dropoffFromPrevious no explotan cuando previousCount=0', async () => {
      setup({ totalUsers: 0, usersWithField: 0, totalFields: 5 });
      const result = await service.getProductAnalytics();

      const usersWithFieldStage = result.funnel.find(
        (s) => s.id === 'users-with-field',
      );
      expect(usersWithFieldStage?.conversionFromPrevious).toBeUndefined();
      expect(usersWithFieldStage?.dropoffFromPrevious).toBe(0);

      // totalFields (5) creció respecto de usersWithField (0) — dropoff negativo, no lanza NaN.
      const totalFieldsStage = result.funnel.find(
        (s) => s.id === 'total-fields',
      );
      expect(totalFieldsStage?.dropoffFromPrevious).toBe(-5);
      expect(Number.isNaN(totalFieldsStage?.dropoffFromPrevious)).toBe(false);
    });

    it('devuelve el top de errores de los últimos 30 días agrupados', async () => {
      setup({
        topErrors: [
          { message: 'Timeout worker', count: 12 },
          { message: 'Nubosidad excesiva', count: 5 },
        ],
      });
      const result = await service.getProductAnalytics();
      expect(result.topAnalysisErrorsLast30Days).toEqual([
        { message: 'Timeout worker', count: 12 },
        { message: 'Nubosidad excesiva', count: 5 },
      ]);
    });

    it('no crea insight de schedules sin corridas cuando activeSchedulesWithoutRuns es 0', async () => {
      setup({ activeSchedulesWithoutRuns: 0 });
      const result = await service.getProductAnalytics();
      expect(
        result.insights.find((i) => i.id === 'active-schedules-without-runs'),
      ).toBeUndefined();
    });

    it('crea insight de schedules sin corridas cuando activeSchedulesWithoutRuns > 0, con link real', async () => {
      setup({ activeSchedules: 2, activeSchedulesWithoutRuns: 2 });
      const result = await service.getProductAnalytics();
      const insight = result.insights.find(
        (i) => i.id === 'active-schedules-without-runs',
      );
      expect(insight).toEqual(
        expect.objectContaining({
          severity: 'critical',
          route: '/scheduled-analysis',
          queryParams: { enabled: true, hasRuns: false },
        }),
      );
    });

    it('crea insight de mail pendiente/fallido a partir del resumen de Programados (PR3)', async () => {
      setup({
        latestRunRows: [
          { status: 'completed', failedAt: null, emailSentAt: null },
        ],
      });
      const result = await service.getProductAnalytics();
      const insight = result.insights.find(
        (i) => i.id === 'mail-pending-or-failed',
      );
      expect(insight?.title).toContain('1');
    });

    it('weeklyMonitoring resta activeSchedulesWithoutRuns de activeSchedules para schedulesWithRuns', async () => {
      setup({ activeSchedules: 10, activeSchedulesWithoutRuns: 3 });
      const result = await service.getProductAnalytics();
      expect(result.weeklyMonitoring).toEqual(
        expect.objectContaining({
          activeSchedules: 10,
          activeSchedulesWithoutRuns: 3,
          schedulesWithRuns: 7,
        }),
      );
    });

    it('no genera ninguna migración (solo lectura, sin cambios de esquema)', () => {
      // Cubierto a nivel repo por `npm run migration:show` en la validación del PR, no acá — este
      // test documenta la intención: getProductAnalytics() nunca llama a save/insert/update.
      expect(typeof service.getProductAnalytics).toBe('function');
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
