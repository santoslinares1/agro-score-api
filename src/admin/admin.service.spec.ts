import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisTechnicalVerdict } from '../analysis-verdict/entities/analysis-technical-verdict.entity';
import { AuditActorContext, AuditLogService } from '../audit-log/audit-log.service';
import { AdminAuditLog } from '../audit-log/entities/admin-audit-log.entity';
import { EmailService } from '../email/email.service';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { UsersService } from '../users/users.service';
import { AdminService } from './admin.service';

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

function buildAccessRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
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
  } as AccessRequest;
}

const actor: AuditActorContext = { actorUserId: 'admin-1', ip: '127.0.0.1', userAgent: 'jest' };

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
  let analysisRepo: ReturnType<typeof noopRepo>;
  let analysisVerdictRepo: ReturnType<typeof noopRepo>;

  beforeEach(async () => {
    accessRequestRepo = noopRepo();
    invitationRepo = noopRepo();
    passwordResetRepo = noopRepo();
    fieldRepo = noopRepo();
    analysisRepo = noopRepo();
    analysisVerdictRepo = noopRepo();

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
            sendInvitationEmail: jest
              .fn()
              .mockResolvedValue({ sent: true, provider: 'resend', dryRun: true }),
            sendPasswordResetEmail: jest
              .fn()
              .mockResolvedValue({ sent: true, provider: 'resend', dryRun: true }),
          },
        },
        {
          provide: PythonWorkerService,
          useValue: { checkHealth: jest.fn().mockResolvedValue({ status: 'ok' }) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        { provide: getRepositoryToken(Field), useValue: fieldRepo },
        { provide: getRepositoryToken(FieldLot), useValue: noopRepo() },
        { provide: getRepositoryToken(Analysis), useValue: analysisRepo },
        {
          provide: getRepositoryToken(AnalysisTechnicalVerdict),
          useValue: analysisVerdictRepo,
        },
        { provide: getRepositoryToken(AccessRequest), useValue: accessRequestRepo },
        { provide: getRepositoryToken(AdminAuditLog), useValue: noopRepo() },
        { provide: getRepositoryToken(UserInvitation), useValue: invitationRepo },
        { provide: getRepositoryToken(PasswordResetToken), useValue: passwordResetRepo },
      ],
    }).compile();

    service = module.get(AdminService);
    usersService = module.get(UsersService);
    auditLogService = module.get(AuditLogService);
    emailService = module.get(EmailService);
    pythonWorkerService = module.get(PythonWorkerService);
    configService = module.get(ConfigService);
  });

  describe('createUser', () => {
    it('hashea la password, nunca devuelve passwordHash y audita admin.user.created', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(buildUser({ role: UserRole.ADMIN }));

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
  });

  describe('updateUser — auditoría', () => {
    it('audita admin.user.role_changed cuando cambia el rol', async () => {
      usersService.findById.mockResolvedValue(buildUser({ role: UserRole.USER }));
      usersService.countActiveByRole.mockResolvedValue(1);
      usersService.update.mockResolvedValue(buildUser({ role: UserRole.ADMIN }));

      await service.updateUser('user-1', { role: UserRole.ADMIN }, actor);

      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.role_changed' }),
      );
    });

    it('audita admin.user.updated cuando cambian otros campos', async () => {
      usersService.findById.mockResolvedValue(buildUser());
      usersService.update.mockResolvedValue(buildUser({ fullName: 'Nuevo nombre' }));

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
      usersService.update.mockResolvedValue(buildUser({ role: UserRole.ADMIN }));

      await service.updateUser('user-1', { role: UserRole.ADMIN }, actor);

      expect(usersService.update).toHaveBeenCalled();
    });

    it('bloquea desactivar al último owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(0);

      await expect(service.deactivateUser('user-1', actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );

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
      expect(usersService.update).toHaveBeenCalledWith('user-1', { isActive: false });
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.user.deactivated' }),
      );
    });
  });

  describe('updateAccessRequest', () => {
    it('setea contactedAt la primera vez que status pasa a contacted', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      accessRequestRepo.save.mockImplementation((v: AccessRequest) => Promise.resolve(v));

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
      accessRequestRepo.save.mockImplementation((v: AccessRequest) => Promise.resolve(v));

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
      accessRequestRepo.save.mockImplementation((v: AccessRequest) => Promise.resolve(v));

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
      accessRequestRepo.save.mockImplementation((v: AccessRequest) => Promise.resolve(v));
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

      const actions = auditLogService.record.mock.calls.map((call) => call[0].action);
      expect(actions).toContain('admin.invitation.created');
      expect(actions).toContain('admin.invitation.email_sent');
      expect(actions).toContain('admin.access_request.converted');
    });

    it('rechaza si ya existe un usuario con ese email', async () => {
      const accessRequest = buildAccessRequest();
      accessRequestRepo.findOne.mockResolvedValue(accessRequest);
      usersService.findByEmail.mockResolvedValue(buildUser({ email: accessRequest.email }));

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

      await service.createInvitation({ email: 'nuevo@example.com', role: UserRole.USER }, actor);

      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        'nuevo@example.com',
        expect.objectContaining({ invitationUrl: expect.any(String), expiresAt: expect.any(Date) }),
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
        service.createInvitation({ email: 'user@agroscorelatam.com', role: UserRole.USER }, actor),
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

      const actions = auditLogService.record.mock.calls.map((call) => call[0].action);
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
        expect.objectContaining({ resetUrl: expect.any(String), expiresAt: expect.any(Date) }),
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

      await expect(service.createPasswordResetToken('missing', actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('mark-reviewed / retry de diagnósticos', () => {
    it('markAnalysisReviewed rechaza analysis que no está en Error', async () => {
      analysisRepo.findOne.mockResolvedValue({ id: 'a1', status: 'Finalizado' });

      await expect(service.markAnalysisReviewed('a1', actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
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
      field: { id: 'field-1', name: 'Campo A', userId: 'user-1', user: { id: 'user-1', email: 'a@x.com', fullName: 'A' } },
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
      for (const key of ['leftJoinAndMapOne', 'orderBy', 'skip', 'take', 'andWhere']) {
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
      analysisRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder([rowA, rowB], 2));
      analysisVerdictRepo.find.mockResolvedValue([buildVerdictRow({ analysisId: 'a1' })]);

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
      analysisRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder([row], 1));
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
      analysisRepo.createQueryBuilder.mockReturnValue(buildQueryBuilder([row], 1));
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

  describe('getSystemHealth', () => {
    it('devuelve la estructura esperada', async () => {
      const fieldRepoManager = fieldRepo.manager as { query: jest.Mock };
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
      const fieldRepoManager = fieldRepo.manager as { query: jest.Mock };
      fieldRepoManager.query.mockRejectedValue(new Error('connection refused'));
      analysisRepo.findOne.mockResolvedValue(null);

      const health = await service.getSystemHealth();

      expect(health.db.status).toBe('error');
    });
  });
});
