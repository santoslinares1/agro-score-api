import { execSync } from 'child_process';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { LessThan, Repository } from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { AuditActorContext, AuditLogService } from '../audit-log/audit-log.service';
import { AdminAuditLog } from '../audit-log/entities/admin-audit-log.entity';
import { generateToken, hashToken } from '../auth/token.util';
import { EmailSendResult, EmailService } from '../email/email.service';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { PublicUser, UsersService } from '../users/users.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserFromAccessRequestDto } from './dto/create-user-from-access-request.dto';
import { ListAccessRequestsQueryDto } from './dto/list-access-requests-query.dto';
import { ListAnalysisQueryDto } from './dto/list-analysis-query.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateAccessRequestDto } from './dto/update-access-request.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

// Mismo costo que AuthService — ver src/auth/auth.service.ts. No se
// comparte la constante entre módulos para no acoplar AdminModule a
// AuthModule por un valor tan chico; si cambia, cambia en los dos lugares.
const SALT_ROUNDS = 10;

const INVITATION_EXPIRES_IN_DAYS = 7;
const PASSWORD_RESET_EXPIRES_IN_HOURS = 2;

type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
};

// Analysis.fieldId es un campo de texto libre histórico, sin FK real hacia
// Field (ver comentarios en analysis.service.ts) — por eso el join acá es
// manual (leftJoinAndMapOne) en vez de una relation declarada en la entidad.
type AnalysisWithField = Analysis & {
  field?: (Pick<Field, 'id' | 'name' | 'userId'> & {
    user?: Pick<User, 'id' | 'email' | 'fullName'>;
  }) | null;
};

type IssuedToken = {
  token: string;
  url?: string;
};

@Injectable()
export class AdminService {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly pythonWorkerService: PythonWorkerService,
    private readonly config: ConfigService,
    @InjectRepository(Field)
    private readonly fieldRepository: Repository<Field>,
    @InjectRepository(FieldLot)
    private readonly fieldLotRepository: Repository<FieldLot>,
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
    @InjectRepository(UserInvitation)
    private readonly invitationRepository: Repository<UserInvitation>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetRepository: Repository<PasswordResetToken>,
  ) {}

  // ── Métricas ────────────────────────────────────────────────────────

  async getMetrics() {
    const now = new Date();
    const cutoff7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      activeUsers,
      totalFields,
      totalLots,
      totalAnalysis,
      completedAnalysis,
      failedAnalysis,
      averageAnalysisDurationMs,
      latestAnalysis,
      latestAccessRequests,
      usersCreatedLast7Days,
      usersCreatedLast30Days,
      fieldsCreatedLast7Days,
      fieldsCreatedLast30Days,
      analysisCreatedLast7Days,
      analysisCreatedLast30Days,
      failedAnalysisLast7Days,
      failedAnalysisLast30Days,
      usersWithNoAnalysis,
      fieldsWithNoAnalysis,
      accessRequestsByStatus,
      averageAnalysisDurationMsLast7Days,
    ] = await Promise.all([
      this.usersService.count(),
      this.usersService.countActive(),
      this.fieldRepository.count(),
      this.fieldLotRepository.count(),
      this.analysisRepository.count(),
      this.analysisRepository.count({ where: { status: 'Finalizado' } }),
      this.analysisRepository.count({ where: { status: 'Error' } }),
      this.getAverageAnalysisDurationMs(),
      this.analysisRepository.find({
        order: { createdAt: 'DESC' },
        take: 5,
        select: {
          id: true,
          fieldId: true,
          lotName: true,
          status: true,
          durationMs: true,
          createdAt: true,
        },
      }),
      this.accessRequestRepository.find({
        order: { createdAt: 'DESC' },
        take: 5,
      }),
      this.usersService.countCreatedSince(cutoff7),
      this.usersService.countCreatedSince(cutoff30),
      this.countSince(this.fieldRepository, cutoff7),
      this.countSince(this.fieldRepository, cutoff30),
      this.countSince(this.analysisRepository, cutoff7),
      this.countSince(this.analysisRepository, cutoff30),
      this.countSince(this.analysisRepository, cutoff7, { status: 'Error' }),
      this.countSince(this.analysisRepository, cutoff30, { status: 'Error' }),
      this.countUsersWithNoAnalysis(),
      this.countFieldsWithNoAnalysis(),
      this.getAccessRequestsByStatus(),
      this.getAverageAnalysisDurationMs(cutoff7),
    ]);

    const analysisFailureRateLast7Days =
      analysisCreatedLast7Days > 0
        ? Math.round((failedAnalysisLast7Days / analysisCreatedLast7Days) * 10000) / 10000
        : 0;

    return {
      totalUsers,
      activeUsers,
      totalFields,
      totalLots,
      totalAnalysis,
      completedAnalysis,
      failedAnalysis,
      averageAnalysisDurationMs,
      latestAnalysis,
      latestAccessRequests,
      usersCreatedLast7Days,
      usersCreatedLast30Days,
      fieldsCreatedLast7Days,
      fieldsCreatedLast30Days,
      analysisCreatedLast7Days,
      analysisCreatedLast30Days,
      failedAnalysisLast7Days,
      failedAnalysisLast30Days,
      usersWithNoAnalysis,
      fieldsWithNoAnalysis,
      accessRequestsByStatus,
      analysisFailureRateLast7Days,
      averageAnalysisDurationMsLast7Days,
    };
  }

  private async getAverageAnalysisDurationMs(since?: Date): Promise<number | null> {
    const qb = this.analysisRepository
      .createQueryBuilder('analysis')
      .select('AVG(analysis."durationMs")', 'avg')
      .where('analysis."durationMs" IS NOT NULL');

    if (since) {
      qb.andWhere('analysis."createdAt" >= :since', { since });
    }

    const raw = await qb.getRawOne<{ avg: string | null }>();

    return raw?.avg ? Math.round(Number(raw.avg)) : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async countSince(
    repository: Repository<any>,
    since: Date,
    extraWhere: Record<string, unknown> = {},
  ): Promise<number> {
    return repository
      .createQueryBuilder('entity')
      .where('entity."createdAt" >= :since', { since })
      .andWhere(
        Object.keys(extraWhere)
          .map((key) => `entity."${key}" = :${key}`)
          .join(' AND ') || '1=1',
        extraWhere,
      )
      .getCount();
  }

  /**
   * ADMIN-2: usuarios que no tienen ningún Analysis asociado (vía sus
   * fields). Mismo join manual que AnalysisService.findAll() —
   * Analysis.fieldId es texto libre sin FK, así que no hay forma de
   * expresar esto con relations de TypeORM.
   */
  private async countUsersWithNoAnalysis(): Promise<number> {
    const rows = await this.fieldRepository.manager.query(`
      SELECT COUNT(*)::int AS count FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM analysis a
        INNER JOIN fields f ON (
          (a.scope = 'field' AND f.id::text = a."fieldId") OR
          (a.scope IS NULL AND f.id::text = a."lotId")
        )
        WHERE f."userId" = u.id
      )
    `);

    return Number(rows?.[0]?.count ?? 0);
  }

  private async countFieldsWithNoAnalysis(): Promise<number> {
    const rows = await this.fieldRepository.manager.query(`
      SELECT COUNT(*)::int AS count FROM fields f
      WHERE NOT EXISTS (
        SELECT 1 FROM analysis a
        WHERE (a.scope = 'field' AND a."fieldId" = f.id::text) OR
              (a.scope IS NULL AND a."lotId" = f.id::text)
      )
    `);

    return Number(rows?.[0]?.count ?? 0);
  }

  private async getAccessRequestsByStatus(): Promise<Record<string, number>> {
    const rows = await this.accessRequestRepository
      .createQueryBuilder('accessRequest')
      .select('accessRequest.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('accessRequest.status')
      .getRawMany<{ status: string; count: string }>();

    const base: Record<string, number> = {
      new: 0,
      contacted: 0,
      interested: 0,
      discarded: 0,
      converted: 0,
    };

    for (const row of rows) {
      base[row.status] = Number(row.count);
    }

    return base;
  }

  // ── Usuarios ────────────────────────────────────────────────────────

  async listUsers(query: PaginationQueryDto): Promise<Paginated<PublicUser>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const { items, total } = await this.usersService.findAllPaginated({
      page,
      limit,
      search: query.search,
    });

    return {
      items: items.map((user) => this.usersService.toPublicUser(user)),
      total,
      page,
      limit,
    };
  }

  async createUser(dto: CreateAdminUserDto, actor: AuditActorContext): Promise<PublicUser> {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese email.');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const user = await this.usersService.create({
      email,
      passwordHash,
      fullName: dto.fullName.trim(),
      role: dto.role,
      isActive: dto.isActive ?? true,
    });

    const publicUser = this.usersService.toPublicUser(user);

    await this.auditLogService.record({
      actor,
      action: 'admin.user.created',
      targetType: 'user',
      targetId: user.id,
      after: publicUser,
    });

    return publicUser;
  }

  async updateUser(
    id: string,
    dto: UpdateAdminUserDto,
    actor: AuditActorContext,
  ): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const removesOwner =
      target.role === UserRole.OWNER &&
      target.isActive &&
      ((dto.role !== undefined && dto.role !== UserRole.OWNER) ||
        dto.isActive === false);

    if (removesOwner) {
      await this.assertNotLastActiveOwner(id);
    }

    if (dto.email) {
      const normalizedEmail = dto.email.trim().toLowerCase();
      const existing = await this.usersService.findByEmail(normalizedEmail);

      if (existing && existing.id !== id) {
        throw new ConflictException('Ya existe una cuenta con ese email.');
      }
    }

    const roleChanged = dto.role !== undefined && dto.role !== target.role;
    const before = this.usersService.toPublicUser(target);

    const updated = await this.usersService.update(id, {
      ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
      ...(dto.email !== undefined && {
        email: dto.email.trim().toLowerCase(),
      }),
      ...(dto.role !== undefined && { role: dto.role }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    });

    const after = this.usersService.toPublicUser(updated);

    if (roleChanged) {
      await this.auditLogService.record({
        actor,
        action: 'admin.user.role_changed',
        targetType: 'user',
        targetId: id,
        before: { role: before.role },
        after: { role: after.role },
      });
    }

    const otherFieldsChanged =
      dto.fullName !== undefined || dto.email !== undefined || dto.isActive !== undefined;

    if (otherFieldsChanged) {
      await this.auditLogService.record({
        actor,
        action: 'admin.user.updated',
        targetType: 'user',
        targetId: id,
        before,
        after,
      });
    }

    return after;
  }

  async deactivateUser(id: string, actor: AuditActorContext): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    if (target.role === UserRole.OWNER && target.isActive) {
      await this.assertNotLastActiveOwner(id);
    }

    const updated = await this.usersService.update(id, { isActive: false });
    const publicUser = this.usersService.toPublicUser(updated);

    await this.auditLogService.record({
      actor,
      action: 'admin.user.deactivated',
      targetType: 'user',
      targetId: id,
      before: { isActive: target.isActive },
      after: { isActive: false },
    });

    return publicUser;
  }

  /**
   * Bloquea la operación si `id` es el último owner activo del sistema (ver
   * consigna: nunca dejar el sistema sin ningún owner). Cuenta owners
   * activos *distintos* de `id`, así que da igual si quien pide el cambio
   * es el propio owner u otro admin actuando sobre él.
   */
  private async assertNotLastActiveOwner(id: string): Promise<void> {
    const otherActiveOwners = await this.usersService.countActiveByRole(
      UserRole.OWNER,
      id,
    );

    if (otherActiveOwners === 0) {
      throw new BadRequestException(
        'No se puede completar la operación: dejaría el sistema sin ningún owner activo.',
      );
    }
  }

  // ── Invitaciones / password reset ──────────────────────────────────

  /**
   * ADMIN-2: genera y persiste (solo el hash) una invitación de alta. El
   * token crudo se devuelve al caller (createInvitation/
   * createUserFromAccessRequest deciden si lo exponen en la respuesta HTTP
   * según el entorno) — nunca se guarda en DB.
   */
  private async issueInvitation(
    email: string,
    role: UserRole,
    invitedByUserId: string,
  ): Promise<{ invitation: UserInvitation; rawToken: string }> {
    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await this.usersService.findByEmail(normalizedEmail);
    if (existingUser) {
      throw new ConflictException('Ya existe una cuenta con ese email.');
    }

    const rawToken = generateToken();
    const expiresAt = new Date(
      Date.now() + INVITATION_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000,
    );

    const invitation = await this.invitationRepository.save(
      this.invitationRepository.create({
        email: normalizedEmail,
        role,
        invitedByUserId,
        tokenHash: hashToken(rawToken),
        expiresAt,
      }),
    );

    return { invitation, rawToken };
  }

  /**
   * ADMIN-3: base para armar los links que van tanto en el email real como
   * en la respuesta HTTP de dev/QA. `APP_PUBLIC_URL` es la variable nueva
   * (pensada para agro-score-web, donde viven las páginas públicas de
   * accept-invitation/reset-password — ver docs/admin-backend.md); si no
   * está seteada cae a `FRONTEND_URL` (que en producción ya vale
   * `https://agroscorelatam.com`). `ADMIN_APP_URL` (ADMIN-2) queda
   * deprecada para este propósito — las páginas ya no viven en
   * agro-score-admin.
   */
  private buildAppUrl(path: string, rawToken: string): string {
    const base = (
      this.config.get<string>('APP_PUBLIC_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      ''
    ).replace(/\/$/, '');

    return `${base}${path}?token=${rawToken}`;
  }

  /**
   * ADMIN-2/ADMIN-3: en producción (NODE_ENV=production) el token crudo
   * NUNCA viaja en la respuesta HTTP — es un secreto de un solo uso
   * equivalente a una password; ahora que el envío de email es real, el
   * único canal de entrega en producción es el email mismo. Fuera de
   * producción, se sigue devolviendo el token + URL completa — pensado para
   * desarrollo/QA manual, no para uso productivo.
   */
  private buildIssuedTokenResponse(rawToken: string, path: string): IssuedToken | null {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      return null;
    }

    return {
      token: rawToken,
      url: this.buildAppUrl(path, rawToken),
    };
  }

  /**
   * ADMIN-3: envío best-effort del email de invitación + auditoría del
   * resultado. Best-effort porque la invitación ya se persistió antes de
   * llegar acá (ver issueInvitation) — un fallo de Resend nunca revierte la
   * creación, solo se refleja en `emailSent: false` en la respuesta y queda
   * registrado en el audit log (éxito o fallo, ambos se auditan).
   */
  private async sendInvitationEmailAndAudit(
    invitation: UserInvitation,
    rawToken: string,
    actor: AuditActorContext,
  ): Promise<EmailSendResult> {
    const invitationUrl = this.buildAppUrl('/accept-invitation', rawToken);

    const result = await this.emailService.sendInvitationEmail(invitation.email, {
      invitationUrl,
      expiresAt: invitation.expiresAt,
    });

    await this.auditLogService.record({
      actor,
      action: 'admin.invitation.email_sent',
      targetType: 'invitation',
      targetId: invitation.id,
      after: {
        email: invitation.email,
        emailSent: result.sent,
        dryRun: result.dryRun,
        provider: result.provider,
      },
    });

    return result;
  }

  async createInvitation(dto: CreateInvitationDto, actor: AuditActorContext) {
    const { invitation, rawToken } = await this.issueInvitation(
      dto.email,
      dto.role,
      actor.actorUserId,
    );

    await this.auditLogService.record({
      actor,
      action: 'admin.invitation.created',
      targetType: 'invitation',
      targetId: invitation.id,
      after: { email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    });

    const emailResult = await this.sendInvitationEmailAndAudit(invitation, rawToken, actor);
    const issued = this.buildIssuedTokenResponse(rawToken, '/accept-invitation');

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      emailSent: emailResult.sent,
      dryRun: emailResult.dryRun,
      provider: emailResult.provider,
      ...(issued ? { invitationToken: issued.token, invitationUrl: issued.url } : {}),
    };
  }

  async createPasswordResetToken(userId: string, actor: AuditActorContext) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const rawToken = generateToken();
    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_EXPIRES_IN_HOURS * 60 * 60 * 1000,
    );

    await this.passwordResetRepository.save(
      this.passwordResetRepository.create({
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt,
      }),
    );

    await this.auditLogService.record({
      actor,
      action: 'admin.password_reset.created',
      targetType: 'user',
      targetId: user.id,
    });

    const resetUrl = this.buildAppUrl('/reset-password', rawToken);
    const emailResult = await this.emailService.sendPasswordResetEmail(user.email, {
      resetUrl,
      expiresAt,
    });

    await this.auditLogService.record({
      actor,
      action: 'admin.password_reset.email_sent',
      targetType: 'user',
      targetId: user.id,
      after: {
        email: user.email,
        emailSent: emailResult.sent,
        dryRun: emailResult.dryRun,
        provider: emailResult.provider,
      },
    });

    const issued = this.buildIssuedTokenResponse(rawToken, '/reset-password');

    return {
      userId: user.id,
      email: user.email,
      expiresAt,
      emailSent: emailResult.sent,
      dryRun: emailResult.dryRun,
      provider: emailResult.provider,
      ...(issued ? { resetToken: issued.token, resetUrl: issued.url } : {}),
    };
  }

  // ── Solicitudes de acceso ───────────────────────────────────────────

  async updateAccessRequest(
    id: string,
    dto: UpdateAccessRequestDto,
    actor: AuditActorContext,
  ): Promise<AccessRequest> {
    const accessRequest = await this.accessRequestRepository.findOne({ where: { id } });

    if (!accessRequest) {
      throw new NotFoundException('Solicitud de acceso no encontrada.');
    }

    const before = { ...accessRequest };

    if (dto.internalNotes !== undefined) {
      accessRequest.internalNotes = dto.internalNotes;
    }

    if (dto.assignedToUserId !== undefined) {
      accessRequest.assignedToUserId = dto.assignedToUserId;
    }

    if (dto.status !== undefined) {
      accessRequest.status = dto.status;

      // Solo setea el timestamp si todavía está vacío — un segundo PATCH a
      // 'contacted' no debe pisar la fecha real del primer contacto.
      if (dto.status === 'contacted' && !accessRequest.contactedAt) {
        accessRequest.contactedAt = new Date();
      }

      if (dto.status === 'converted' && !accessRequest.convertedAt) {
        accessRequest.convertedAt = new Date();
      }

      if (dto.status === 'discarded' && !accessRequest.discardedAt) {
        accessRequest.discardedAt = new Date();
      }
    }

    const saved = await this.accessRequestRepository.save(accessRequest);

    await this.auditLogService.record({
      actor,
      action: 'admin.access_request.updated',
      targetType: 'access_request',
      targetId: id,
      before,
      after: saved,
    });

    return saved;
  }

  async createUserFromAccessRequest(
    id: string,
    dto: CreateUserFromAccessRequestDto,
    actor: AuditActorContext,
  ) {
    const accessRequest = await this.accessRequestRepository.findOne({ where: { id } });

    if (!accessRequest) {
      throw new NotFoundException('Solicitud de acceso no encontrada.');
    }

    const role = dto.role ?? UserRole.USER;

    const { invitation, rawToken } = await this.issueInvitation(
      accessRequest.email,
      role,
      actor.actorUserId,
    );

    await this.auditLogService.record({
      actor,
      action: 'admin.invitation.created',
      targetType: 'invitation',
      targetId: invitation.id,
      after: { email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
    });

    const before = { ...accessRequest };
    accessRequest.status = 'converted';
    accessRequest.convertedAt = accessRequest.convertedAt ?? new Date();
    const savedAccessRequest = await this.accessRequestRepository.save(accessRequest);

    await this.auditLogService.record({
      actor,
      action: 'admin.access_request.converted',
      targetType: 'access_request',
      targetId: id,
      before,
      after: savedAccessRequest,
    });

    const emailResult = await this.sendInvitationEmailAndAudit(invitation, rawToken, actor);
    const issued = this.buildIssuedTokenResponse(rawToken, '/accept-invitation');

    return {
      accessRequest: savedAccessRequest,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        emailSent: emailResult.sent,
        dryRun: emailResult.dryRun,
        provider: emailResult.provider,
        ...(issued ? { invitationToken: issued.token, invitationUrl: issued.url } : {}),
      },
    };
  }

  // ── Campos / lotes ──────────────────────────────────────────────────

  async listFields(query: PaginationQueryDto): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.fieldRepository
      .createQueryBuilder('field')
      .leftJoinAndSelect('field.user', 'user')
      .orderBy('field.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      qb.andWhere('field.name ILIKE :search', { search: `%${query.search}%` });
    }

    const [items, total] = await qb.getManyAndCount();
    const lotsCountByFieldId = await this.countLotsByFieldId(
      items.map((field) => field.id),
    );

    return {
      items: items.map((field) => ({
        id: field.id,
        name: field.name,
        ownerId: field.userId,
        ownerEmail: field.user?.email ?? null,
        ownerFullName: field.user?.fullName ?? null,
        lotsCount: lotsCountByFieldId.get(field.id) ?? 0,
        createdAt: field.createdAt,
        updatedAt: field.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Esta versión de TypeORM no expone `loadRelationCountAndMap` en
   * SelectQueryBuilder, así que el conteo de lotes por campo se resuelve en
   * un segundo query acotado a los ids de la página actual (nunca más de
   * `limit` fields), en vez de un join que multiplicaría filas y complicaría
   * la paginación.
   */
  private async countLotsByFieldId(
    fieldIds: string[],
  ): Promise<Map<string, number>> {
    if (!fieldIds.length) {
      return new Map();
    }

    const rows = await this.fieldLotRepository
      .createQueryBuilder('lot')
      .select('lot."fieldId"', 'fieldId')
      .addSelect('COUNT(*)', 'count')
      .where('lot."fieldId" IN (:...fieldIds)', { fieldIds })
      .groupBy('lot."fieldId"')
      .getRawMany<{ fieldId: string; count: string }>();

    return new Map(rows.map((row) => [row.fieldId, Number(row.count)]));
  }

  async listLots(query: PaginationQueryDto): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.fieldLotRepository
      .createQueryBuilder('lot')
      .leftJoinAndSelect('lot.field', 'field')
      .leftJoinAndSelect('field.user', 'user')
      .orderBy('lot.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      qb.andWhere('lot.name ILIKE :search', { search: `%${query.search}%` });
    }

    const [items, total] = await qb.getManyAndCount();

    return {
      items: items.map((lot) => ({
        id: lot.id,
        name: lot.name,
        fieldId: lot.fieldId,
        fieldName: lot.field?.name ?? null,
        ownerId: lot.field?.userId ?? null,
        ownerEmail: lot.field?.user?.email ?? null,
        ownerFullName: lot.field?.user?.fullName ?? null,
        createdAt: lot.createdAt,
        updatedAt: lot.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  // ── Diagnósticos ────────────────────────────────────────────────────

  async listAnalysis(
    query: ListAnalysisQueryDto,
  ): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.analysisRepository
      .createQueryBuilder('analysis')
      .leftJoinAndMapOne(
        'analysis.field',
        Field,
        'field',
        'field.id::text = analysis."fieldId"',
      )
      .leftJoinAndMapOne('field.user', User, 'user', 'user.id = field."userId"')
      .orderBy('analysis.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('analysis.status = :status', { status: query.status });
    }

    if (query.onlyFailed) {
      qb.andWhere('analysis.status = :failedStatus', { failedStatus: 'Error' });
    }

    if (query.onlyUnreviewed) {
      qb.andWhere('analysis."reviewedAt" IS NULL');
    }

    if (query.fieldId) {
      qb.andWhere('analysis."fieldId" = :fieldId', { fieldId: query.fieldId });
    }

    if (query.userId) {
      qb.andWhere('field."userId" = :userId', { userId: query.userId });
    }

    if (query.from) {
      qb.andWhere('analysis."createdAt" >= :from', { from: query.from });
    }

    if (query.to) {
      qb.andWhere('analysis."createdAt" <= :to', { to: query.to });
    }

    const [items, total] = (await qb.getManyAndCount()) as [
      AnalysisWithField[],
      number,
    ];

    return {
      items: items.map((analysis) => ({
        id: analysis.id,
        fieldId: analysis.fieldId,
        fieldName: analysis.field?.name ?? analysis.lotName,
        ownerId: analysis.field?.userId ?? null,
        ownerEmail: analysis.field?.user?.email ?? null,
        ownerFullName: analysis.field?.user?.fullName ?? null,
        status: analysis.status,
        startedAt: analysis.startedAt,
        completedAt: analysis.completedAt,
        failedAt: analysis.failedAt,
        durationMs: analysis.durationMs,
        errorMessage: analysis.errorMessage,
        reviewedAt: analysis.reviewedAt,
        reviewedByUserId: analysis.reviewedByUserId,
        retryCount: analysis.retryCount,
        lastRetriedAt: analysis.lastRetriedAt,
        createdAt: analysis.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  async markAnalysisReviewed(id: string, actor: AuditActorContext): Promise<Analysis> {
    const analysis = await this.analysisRepository.findOne({ where: { id } });

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    if (analysis.status !== 'Error') {
      throw new BadRequestException(
        'Solo se pueden marcar como revisados los diagnósticos con status Error.',
      );
    }

    const before = { reviewedAt: analysis.reviewedAt, reviewedByUserId: analysis.reviewedByUserId };

    analysis.reviewedAt = new Date();
    analysis.reviewedByUserId = actor.actorUserId;

    const saved = await this.analysisRepository.save(analysis);

    await this.auditLogService.record({
      actor,
      action: 'admin.analysis.marked_reviewed',
      targetType: 'analysis',
      targetId: id,
      before,
      after: { reviewedAt: saved.reviewedAt, reviewedByUserId: saved.reviewedByUserId },
    });

    return saved;
  }

  /**
   * ADMIN-2: "retry requested", no reintento real. Reconstruir de forma
   * segura el input original (índices, fechas, lotes incluidos) y volver a
   * llamar al worker desde acá implica más superficie de riesgo (llamadas
   * duplicadas a Earth Engine, costos, falta de idempotencia) de la que esta
   * ficha puede validar con confianza. Este endpoint deja constancia
   * operativa (cuántas veces se pidió, cuándo) para que el equipo lo haga a
   * mano o para que una ficha futura lo automatice con las guardas
   * correspondientes — ver docs/admin-backend.md, sección "Deuda pendiente".
   */
  async retryAnalysis(id: string, actor: AuditActorContext): Promise<Analysis> {
    const analysis = await this.analysisRepository.findOne({ where: { id } });

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    if (analysis.status !== 'Error') {
      throw new BadRequestException(
        'Solo se puede pedir reintento de diagnósticos con status Error.',
      );
    }

    const before = { retryCount: analysis.retryCount, lastRetriedAt: analysis.lastRetriedAt };

    analysis.retryCount += 1;
    analysis.lastRetriedAt = new Date();

    const saved = await this.analysisRepository.save(analysis);

    await this.auditLogService.record({
      actor,
      action: 'admin.analysis.retry_requested',
      targetType: 'analysis',
      targetId: id,
      before,
      after: { retryCount: saved.retryCount, lastRetriedAt: saved.lastRetriedAt },
    });

    return saved;
  }

  // ── Solicitudes de acceso (lectura) ─────────────────────────────────

  async listAccessRequests(
    query: ListAccessRequestsQueryDto,
  ): Promise<Paginated<AccessRequest>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.accessRequestRepository
      .createQueryBuilder('accessRequest')
      .orderBy('accessRequest.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('accessRequest.status = :status', { status: query.status });
    }

    if (query.search) {
      qb.andWhere(
        '(accessRequest.name ILIKE :search OR accessRequest.email ILIKE :search OR accessRequest.organization ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total, page, limit };
  }

  // ── Auditoría ───────────────────────────────────────────────────────

  // Fix post-ADMIN-3: la lectura de audit logs vive en AuditLogService
  // (dueño del repositorio); AdminService solo pasa los filtros del query
  // DTO — ver AuditLogService.list().
  async listAuditLogs(query: ListAuditLogsQueryDto): Promise<Paginated<AdminAuditLog>> {
    return this.auditLogService.list(query);
  }

  // ── Sistema / health ────────────────────────────────────────────────

  async getSystemHealth() {
    const [dbStatus, workerStatus, lastSuccessfulAnalysis, lastFailedAnalysis] =
      await Promise.all([
        this.checkDbHealth(),
        this.pythonWorkerService.checkHealth(),
        this.analysisRepository.findOne({
          where: { status: 'Finalizado' },
          order: { completedAt: 'DESC' },
          select: { id: true, fieldId: true, lotName: true, completedAt: true, createdAt: true },
        }),
        this.analysisRepository.findOne({
          where: { status: 'Error' },
          order: { failedAt: 'DESC' },
          select: {
            id: true,
            fieldId: true,
            lotName: true,
            failedAt: true,
            errorMessage: true,
            createdAt: true,
          },
        }),
      ]);

    return {
      api: { status: 'ok' as const },
      db: dbStatus,
      worker: workerStatus,
      // No se llama a Earth Engine desde el backend (solo el worker lo
      // hace) y el chequeo del worker no lo verifica para no sumar
      // costo/latencia a un endpoint de panel admin — ver PythonWorkerService.
      earthEngine: {
        status: 'not_checked' as const,
        note: 'El backend nunca llama a Earth Engine directamente; verificar el estado real de EE implicaría una llamada costosa desde el worker. No se ejecuta automáticamente en este health check.',
      },
      lastSuccessfulAnalysis,
      lastFailedAnalysis,
      currentBackendCommit: this.getCurrentCommit(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDbHealth(): Promise<{ status: 'ok' | 'error'; error?: string }> {
    try {
      await this.fieldRepository.manager.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getCurrentCommit(): string | null {
    const envCommit = this.config.get<string>('GIT_COMMIT') || this.config.get<string>('SOURCE_COMMIT');

    if (envCommit) {
      return envCommit;
    }

    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: __dirname,
        timeout: 2000,
      })
        .toString()
        .trim();
    } catch {
      // Esperable en el contenedor de producción: la imagen no incluye
      // .git (ver Dockerfile). No es un error, solo "no disponible".
      return null;
    }
  }
}
