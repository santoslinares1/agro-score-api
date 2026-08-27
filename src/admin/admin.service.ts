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
import {
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis, AnalysisStatus } from '../analysis/entities/analysis.entity';
import { AnalysisTechnicalVerdict } from '../analysis-verdict/entities/analysis-technical-verdict.entity';
import {
  AuditActorContext,
  AuditLogService,
} from '../audit-log/audit-log.service';
import { AdminAuditLog } from '../audit-log/entities/admin-audit-log.entity';
import { generateToken, hashToken } from '../auth/token.util';
import { EmailSendResult, EmailService } from '../email/email.service';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { FieldAnalysisSchedule } from '../scheduled-analysis/entities/field-analysis-schedule.entity';
import {
  ScheduledAnalysisRun,
  ScheduledRunStatus,
} from '../scheduled-analysis/entities/scheduled-analysis-run.entity';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { PublicUser, UsersService } from '../users/users.service';
import { WeeklyTechnicalVerdictService } from '../weekly-technical-verdict/weekly-technical-verdict.service';
import {
  AdminAnalysisTechnicalVerdict,
  toAdminAnalysisTechnicalVerdict,
} from './dto/admin-analysis-technical-verdict.dto';
import {
  AdminFieldAnalysisStatus,
  AdminFieldItem,
  AdminFieldLatestAnalysis,
  AdminFieldWeeklyMonitoring,
} from './dto/admin-field.dto';
import { AdminLotItem } from './dto/admin-lot.dto';
import {
  AdminAnalysisErrorBucket,
  AdminProductAnalyticsDto,
  AdminProductAnalyticsFunnelStage,
  AdminProductAnalyticsInsight,
} from './dto/admin-product-analytics.dto';
import {
  AdminScheduledAnalysisItem,
  AdminScheduledAnalysisRun,
  AdminScheduledAnalysisSummary,
} from './dto/admin-scheduled-analysis.dto';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserFromAccessRequestDto } from './dto/create-user-from-access-request.dto';
import { ListAccessRequestsQueryDto } from './dto/list-access-requests-query.dto';
import { ListAnalysisQueryDto } from './dto/list-analysis-query.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ListFieldsQueryDto } from './dto/list-fields-query.dto';
import { ListLotsQueryDto } from './dto/list-lots-query.dto';
import { ListScheduledAnalysisQueryDto } from './dto/list-scheduled-analysis-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
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
  field?:
    | (Pick<Field, 'id' | 'name' | 'userId'> & {
        user?: Pick<User, 'id' | 'email' | 'fullName'>;
      })
    | null;
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
    @InjectRepository(AnalysisTechnicalVerdict)
    private readonly analysisVerdictRepository: Repository<AnalysisTechnicalVerdict>,
    @InjectRepository(FieldAnalysisSchedule)
    private readonly fieldAnalysisScheduleRepository: Repository<FieldAnalysisSchedule>,
    @InjectRepository(ScheduledAnalysisRun)
    private readonly scheduledAnalysisRunRepository: Repository<ScheduledAnalysisRun>,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
    @InjectRepository(UserInvitation)
    private readonly invitationRepository: Repository<UserInvitation>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetRepository: Repository<PasswordResetToken>,
    private readonly weeklyTechnicalVerdictService: WeeklyTechnicalVerdictService,
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
      activeSchedulesWithoutRuns,
      unreviewedFailedAnalysisOlderThan7Days,
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
      this.countActiveSchedulesWithoutRuns(),
      this.countUnreviewedFailedAnalysisOlderThan(cutoff7),
    ]);

    const analysisFailureRateLast7Days =
      analysisCreatedLast7Days > 0
        ? Math.round(
            (failedAnalysisLast7Days / analysisCreatedLast7Days) * 10000,
          ) / 10000
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
      // Admin PR 1: stats crudas para las alertas operativas del Dashboard — el frontend arma el
      // texto/severidad/link (ver operational-alerts.util.ts en agro-score-admin), acá solo se
      // agregan los dos números que no existían todavía.
      activeSchedulesWithoutRuns,
      unreviewedFailedAnalysisOlderThan7Days,
    };
  }

  private async getAverageAnalysisDurationMs(
    since?: Date,
  ): Promise<number | null> {
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

  /**
   * Admin PR 1: schedules semanales activos que todavía no registraron ninguna corrida
   * (enabled=true AND lastRunAt IS NULL) — la auditoría del admin lo marcó P0: sin esto no hay
   * forma de confirmar que el pipeline semanal (Fase 4A/5/12A) funcione end-to-end. lastRunAt solo
   * lo escribe ScheduledAnalysisRunnerService al completar una corrida real, así que este conteo
   * nunca dispara ni simula una ejecución, solo lee el estado ya persistido.
   */
  private async countActiveSchedulesWithoutRuns(): Promise<number> {
    return this.fieldAnalysisScheduleRepository.count({
      where: { enabled: true, lastRunAt: IsNull() },
    });
  }

  /**
   * Admin PR 1: diagnósticos con status Error que nadie marcó como revisado (reviewedAt IS NULL —
   * ver AdminService.markAnalysisReviewed, el único setter de esa columna) y con más de `cutoff` de
   * antigüedad. Solo los análisis en Error son "revisables" (markAnalysisReviewed rechaza cualquier
   * otro status), así que a propósito no se filtra por status='Finalizado'/'Procesando' — esos
   * nunca tienen reviewedAt seteado y no deberían contar como "pendientes de revisión".
   */
  private async countUnreviewedFailedAnalysisOlderThan(
    cutoff: Date,
  ): Promise<number> {
    return this.analysisRepository.count({
      where: {
        status: 'Error',
        reviewedAt: IsNull(),
        createdAt: LessThan(cutoff),
      },
    });
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

  /**
   * Admin PR 4: Product Analytics básico — GET /admin/product-analytics. Funnel de 9 etapas sobre
   * entidades ACTUALES, no cohortes por fecha de alta (por eso nunca se llama "conversión real" en
   * el copy). Todas las queries son COUNT/EXISTS agregados sobre columnas indexadas, ninguna es
   * por fila ni N+1 — 12 consultas en paralelo, ninguna pesada.
   */
  async getProductAnalytics(): Promise<AdminProductAnalyticsDto> {
    const now = new Date();
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      usersWithFieldRow,
      totalFields,
      fieldsWithLotRow,
      fieldsWithFinalizedAnalysisRows,
      fieldsWithVerdictRows,
      activeSchedules,
      activeSchedulesWithoutRuns,
      fieldsWithRunRow,
      fieldsWithMailSentRow,
      sentEmails,
      fieldsWithNoAnalysis,
      failedAnalysisLast30Days,
      scheduleSummary,
      topErrorsRows,
    ] = await Promise.all([
      this.usersService.count(),
      this.fieldRepository
        .createQueryBuilder('field')
        .select('COUNT(DISTINCT field."userId")', 'count')
        .getRawOne<{ count: string }>(),
      this.fieldRepository.count(),
      this.fieldLotRepository
        .createQueryBuilder('lot')
        .select('COUNT(DISTINCT lot."fieldId")', 'count')
        .getRawOne<{ count: string }>(),
      // Mismo join manual scope-based que countFieldsWithNoAnalysis (Analysis.fieldId/lotId son
      // texto libre histórico, sin FK real hacia Field).
      this.fieldRepository.manager.query<{ count: string }[]>(`
        SELECT COUNT(DISTINCT f.id)::int AS count
        FROM fields f
        INNER JOIN analysis a ON (
          (a.scope = 'field' AND a."fieldId" = f.id::text) OR
          (a.scope IS NULL AND a."lotId" = f.id::text)
        )
        WHERE a.status = 'Finalizado'
      `),
      this.fieldRepository.manager.query<{ count: string }[]>(`
        SELECT COUNT(DISTINCT f.id)::int AS count
        FROM fields f
        INNER JOIN analysis a ON (
          (a.scope = 'field' AND a."fieldId" = f.id::text) OR
          (a.scope IS NULL AND a."lotId" = f.id::text)
        )
        INNER JOIN analysis_technical_verdicts v ON v."analysisId" = a.id
        WHERE v.status = 'generated'
      `),
      this.fieldAnalysisScheduleRepository.count({ where: { enabled: true } }),
      // A propósito NO reusa countActiveSchedulesWithoutRuns() (lastRunAt IS NULL, PR1) — este
      // bloque usa el criterio real de PR3 (EXISTS/NOT EXISTS), ver comentario en el DTO.
      this.fieldAnalysisScheduleRepository
        .createQueryBuilder('schedule')
        .where('schedule.enabled = true')
        .andWhere(
          `NOT EXISTS (SELECT 1 FROM scheduled_analysis_runs r WHERE r."scheduleId" = schedule.id)`,
        )
        .getCount(),
      // ScheduledAnalysisRun.fieldId es columna directa (no hace falta pasar por schedule).
      this.scheduledAnalysisRunRepository
        .createQueryBuilder('run')
        .select('COUNT(DISTINCT run."fieldId")', 'count')
        .getRawOne<{ count: string }>(),
      this.scheduledAnalysisRunRepository
        .createQueryBuilder('run')
        .select('COUNT(DISTINCT run."fieldId")', 'count')
        .where('run."emailSentAt" IS NOT NULL')
        .getRawOne<{ count: string }>(),
      this.scheduledAnalysisRunRepository.count({
        where: { emailSentAt: Not(IsNull()) },
      }),
      this.countFieldsWithNoAnalysis(),
      this.countSince(this.analysisRepository, cutoff30, { status: 'Error' }),
      this.getScheduledAnalysisSummary(),
      this.fieldRepository.manager.query<{ message: string; count: string }[]>(
        `
        SELECT "errorMessage" AS message, COUNT(*)::int AS count
        FROM analysis
        WHERE status = 'Error'
          AND "createdAt" >= $1
          AND "errorMessage" IS NOT NULL
        GROUP BY "errorMessage"
        ORDER BY COUNT(*) DESC
        LIMIT 3
      `,
        [cutoff30],
      ),
    ]);

    const usersWithField = Number(usersWithFieldRow?.count ?? 0);
    const fieldsWithLot = Number(fieldsWithLotRow?.count ?? 0);
    const fieldsWithFinalizedAnalysis = Number(
      fieldsWithFinalizedAnalysisRows?.[0]?.count ?? 0,
    );
    const fieldsWithVerdict = Number(fieldsWithVerdictRows?.[0]?.count ?? 0);
    const fieldsWithRun = Number(fieldsWithRunRow?.count ?? 0);
    const fieldsWithMailSent = Number(fieldsWithMailSentRow?.count ?? 0);
    const schedulesWithRuns = activeSchedules - activeSchedulesWithoutRuns;

    const funnel: AdminProductAnalyticsFunnelStage[] = [];
    const pushStage = (
      stage: Omit<
        AdminProductAnalyticsFunnelStage,
        'previousCount' | 'conversionFromPrevious' | 'dropoffFromPrevious'
      >,
    ) => {
      funnel.push(this.buildFunnelStage(stage, funnel.at(-1)?.count));
    };

    pushStage({
      id: 'total-users',
      label: 'Usuarios totales',
      count: totalUsers,
      description: 'Todos los usuarios registrados en la plataforma.',
      route: '/users',
    });
    pushStage({
      id: 'users-with-field',
      label: 'Usuarios con al menos un campo',
      count: usersWithField,
      description:
        'No existe todavía un filtro dedicado en Usuarios para esta pregunta.',
    });
    pushStage({
      id: 'total-fields',
      label: 'Campos totales',
      count: totalFields,
      description: 'Todos los campos creados, de cualquier usuario.',
      route: '/fields',
    });
    pushStage({
      id: 'fields-with-lot',
      label: 'Campos con al menos un lote',
      count: fieldsWithLot,
      description:
        'No existe todavía un filtro dedicado en Campos para esta pregunta.',
    });
    pushStage({
      id: 'fields-with-finalized-analysis',
      label: 'Campos con al menos un análisis finalizado',
      count: fieldsWithFinalizedAnalysis,
      description:
        '/fields?hasAnalysis=true existe pero incluye cualquier estado (también Procesando/Error), así que no se linkea acá para no insinuar más precisión de la que tiene.',
    });
    pushStage({
      id: 'fields-with-verdict',
      label: 'Campos con veredicto técnico generado',
      count: fieldsWithVerdict,
      description: 'No existe todavía un filtro dedicado para esta pregunta.',
    });
    pushStage({
      id: 'fields-with-active-schedule',
      label: 'Campos con monitoreo semanal activo',
      count: activeSchedules,
      description:
        'FieldAnalysisSchedule.fieldId es único por campo, así que este número ya es "campos", no "schedules".',
      route: '/scheduled-analysis',
      queryParams: { enabled: true },
    });
    pushStage({
      id: 'fields-with-run',
      label: 'Campos con al menos una corrida semanal',
      count: fieldsWithRun,
      description:
        'Existencia real de ScheduledAnalysisRun (mismo criterio que el filtro hasRuns de Programados, PR3).',
      route: '/scheduled-analysis',
      queryParams: { enabled: true, hasRuns: true },
    });
    pushStage({
      id: 'fields-with-mail-sent',
      label: 'Campos con mail semanal enviado',
      count: fieldsWithMailSent,
      description:
        'No existe todavía un filtro por mailStatus en el listado de Programados (deuda documentada en PR3).',
    });

    const insights: AdminProductAnalyticsInsight[] = [];

    if (fieldsWithNoAnalysis > 0) {
      insights.push({
        id: 'fields-without-analysis',
        severity: 'warning',
        title: `${fieldsWithNoAnalysis} de ${totalFields} ${this.pluralize(totalFields, 'campo todavía no tiene', 'campos todavía no tienen')} ningún diagnóstico`,
        description:
          'Principal punto de pérdida: activación del primer análisis.',
        route: '/fields',
        queryParams: { hasAnalysis: false },
      });
    }

    if (totalFields > 0 && activeSchedules / totalFields < 0.5) {
      insights.push({
        id: 'weekly-monitoring-adoption',
        severity: 'opportunity',
        title: `${activeSchedules} de ${totalFields} campos tienen monitoreo semanal activo`,
        description: 'La adopción del monitoreo semanal todavía es baja.',
        route: '/scheduled-analysis',
        queryParams: { enabled: true },
      });
    }

    if (activeSchedulesWithoutRuns > 0) {
      insights.push({
        id: 'active-schedules-without-runs',
        severity: 'critical',
        title: `${activeSchedulesWithoutRuns} de ${activeSchedules} monitoreos semanales activos todavía no registran ninguna corrida`,
        description:
          'Revisar el pipeline semanal antes de seguir empujando adopción de monitoreo.',
        route: '/scheduled-analysis',
        queryParams: { enabled: true, hasRuns: false },
      });
    }

    if (failedAnalysisLast30Days > 0) {
      insights.push({
        id: 'failed-analysis-30d',
        severity: 'critical',
        title: `${failedAnalysisLast30Days} ${this.pluralize(failedAnalysisLast30Days, 'diagnóstico fallido', 'diagnósticos fallidos')} en los últimos 30 días`,
        description:
          'Revisar estabilidad del worker/API antes de escalar el volumen de análisis.',
        route: '/analysis',
        queryParams: { status: 'Error' },
      });
    }

    if (scheduleSummary.mailPendingOrFailed > 0) {
      insights.push({
        id: 'mail-pending-or-failed',
        severity: 'warning',
        title: `${scheduleSummary.mailPendingOrFailed} ${this.pluralize(scheduleSummary.mailPendingOrFailed, 'monitoreo semanal todavía no envió', 'monitoreos semanales todavía no enviaron')} el mail de su corrida más reciente`,
        description:
          'Puede ser un envío pendiente del próximo ciclo o un mail que se omitió — ver detalle en Programados.',
        route: '/scheduled-analysis',
        queryParams: { enabled: true },
      });
    }

    const topAnalysisErrorsLast30Days: AdminAnalysisErrorBucket[] =
      topErrorsRows.map((row) => ({
        message: row.message,
        count: Number(row.count),
      }));

    return {
      generatedAt: now.toISOString(),
      funnel,
      insights,
      weeklyMonitoring: {
        totalFields,
        activeSchedules,
        activeSchedulesWithoutRuns,
        schedulesWithRuns,
        sentEmails,
      },
      topAnalysisErrorsLast30Days,
    };
  }

  private buildFunnelStage(
    stage: Omit<
      AdminProductAnalyticsFunnelStage,
      'previousCount' | 'conversionFromPrevious' | 'dropoffFromPrevious'
    >,
    previousCount: number | undefined,
  ): AdminProductAnalyticsFunnelStage {
    if (previousCount === undefined) {
      return stage;
    }

    return {
      ...stage,
      previousCount,
      conversionFromPrevious:
        previousCount > 0 ? stage.count / previousCount : undefined,
      dropoffFromPrevious: previousCount - stage.count,
    };
  }

  private pluralize(count: number, singular: string, plural: string): string {
    return count === 1 ? singular : plural;
  }

  // ── Usuarios ────────────────────────────────────────────────────────

  async listUsers(query: ListUsersQueryDto): Promise<Paginated<PublicUser>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const { items, total } = await this.usersService.findAllPaginated({
      page,
      limit,
      search: query.search,
      userId: query.userId,
    });

    return {
      items: items.map((user) => this.usersService.toPublicUser(user)),
      total,
      page,
      limit,
    };
  }

  async createUser(
    dto: CreateAdminUserDto,
    actor: AuditActorContext,
  ): Promise<PublicUser> {
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
      dto.fullName !== undefined ||
      dto.email !== undefined ||
      dto.isActive !== undefined;

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

  async deactivateUser(
    id: string,
    actor: AuditActorContext,
  ): Promise<PublicUser> {
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
  private buildIssuedTokenResponse(
    rawToken: string,
    path: string,
  ): IssuedToken | null {
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

    const result = await this.emailService.sendInvitationEmail(
      invitation.email,
      {
        invitationUrl,
        expiresAt: invitation.expiresAt,
      },
    );

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
      after: {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    });

    const emailResult = await this.sendInvitationEmailAndAudit(
      invitation,
      rawToken,
      actor,
    );
    const issued = this.buildIssuedTokenResponse(
      rawToken,
      '/accept-invitation',
    );

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      emailSent: emailResult.sent,
      dryRun: emailResult.dryRun,
      provider: emailResult.provider,
      ...(issued
        ? { invitationToken: issued.token, invitationUrl: issued.url }
        : {}),
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
    const emailResult = await this.emailService.sendPasswordResetEmail(
      user.email,
      {
        resetUrl,
        expiresAt,
      },
    );

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
    const accessRequest = await this.accessRequestRepository.findOne({
      where: { id },
    });

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
    const accessRequest = await this.accessRequestRepository.findOne({
      where: { id },
    });

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
      after: {
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
    });

    const before = { ...accessRequest };
    accessRequest.status = 'converted';
    accessRequest.convertedAt = accessRequest.convertedAt ?? new Date();
    const savedAccessRequest =
      await this.accessRequestRepository.save(accessRequest);

    await this.auditLogService.record({
      actor,
      action: 'admin.access_request.converted',
      targetType: 'access_request',
      targetId: id,
      before,
      after: savedAccessRequest,
    });

    const emailResult = await this.sendInvitationEmailAndAudit(
      invitation,
      rawToken,
      actor,
    );
    const issued = this.buildIssuedTokenResponse(
      rawToken,
      '/accept-invitation',
    );

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
        ...(issued
          ? { invitationToken: issued.token, invitationUrl: issued.url }
          : {}),
      },
    };
  }

  // ── Campos / lotes ──────────────────────────────────────────────────

  async listFields(
    query: ListFieldsQueryDto,
  ): Promise<Paginated<AdminFieldItem>> {
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

    // Admin PR 2: trazabilidad — "ver campos de este usuario" (Usuarios/Diagnósticos/Programados)
    // y "saltar a este campo puntual" (sin vista de detalle dedicada todavía).
    if (query.userId) {
      qb.andWhere('field."userId" = :userId', { userId: query.userId });
    }

    if (query.fieldId) {
      qb.andWhere('field.id = :fieldId', { fieldId: query.fieldId });
    }

    // Admin PR 1: mismo criterio (NOT) EXISTS que countFieldsWithNoAnalysis() más abajo — soporta
    // la alerta "Campos sin diagnóstico" del Dashboard, que necesita un link que filtre de verdad
    // en vez de mandar a la lista completa de campos.
    if (query.hasAnalysis === false) {
      qb.andWhere(`NOT EXISTS (${this.fieldAnalysisExistsSubquery('field')})`);
    } else if (query.hasAnalysis === true) {
      qb.andWhere(`EXISTS (${this.fieldAnalysisExistsSubquery('field')})`);
    }

    // Admin PR 5: "status" usa el análisis MÁS RECIENTE del campo — subquery correlacionada
    // (nunca un join, que multiplicaría filas y complicaría la paginación). without_analysis
    // reusa el mismo NOT EXISTS que hasAnalysis=false (misma pregunta, dos nombres de filtro por
    // compatibilidad con PR1).
    if (query.status === 'without_analysis') {
      qb.andWhere(`NOT EXISTS (${this.fieldAnalysisExistsSubquery('field')})`);
    } else if (query.status === 'processing') {
      qb.andWhere(
        `${this.latestAnalysisStatusSubquery('field')} = 'Procesando'`,
      );
    } else if (query.status === 'error') {
      qb.andWhere(`${this.latestAnalysisStatusSubquery('field')} = 'Error'`);
    } else if (query.status === 'attention') {
      qb.andWhere(
        `${this.latestAnalysisStatusSubquery('field')} = 'Finalizado'`,
      );
      qb.andWhere(
        `${this.latestAnalysisVerdictSubquery('field')} IN ('attention', 'critical')`,
      );
    } else if (query.status === 'completed') {
      qb.andWhere(
        `${this.latestAnalysisStatusSubquery('field')} = 'Finalizado'`,
      );
      qb.andWhere(
        `(${this.latestAnalysisVerdictSubquery('field')} IS NULL OR ${this.latestAnalysisVerdictSubquery('field')} NOT IN ('attention', 'critical'))`,
      );
    }

    // Admin PR 5: "monitoreo activo/inactivo" — fieldId es unique en field_analysis_schedules,
    // así que EXISTS enabled=true alcanza (nunca hay dos schedules activos para el mismo campo).
    if (query.monitoring === 'active') {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM field_analysis_schedules s WHERE s."fieldId" = field.id AND s.enabled = true)`,
      );
    } else if (query.monitoring === 'inactive') {
      qb.andWhere(
        `NOT EXISTS (SELECT 1 FROM field_analysis_schedules s WHERE s."fieldId" = field.id AND s.enabled = true)`,
      );
    }

    const [items, total] = await qb.getManyAndCount();
    const fieldIds = items.map((field) => field.id);

    // Admin PR 5: 3 consultas en lote acotadas a los <=limit campos de esta página (nunca una por
    // fila) + 2 más que dependen de sus resultados (verdicts por analysisId, runs por scheduleId)
    // — 5 consultas totales sin importar cuántos campos traiga la página.
    const [lotsCountByFieldId, latestAnalysisByFieldId, scheduleByFieldId] =
      await Promise.all([
        this.countLotsByFieldId(fieldIds),
        this.getLatestAnalysisByFieldId(fieldIds),
        this.getSchedulesByFieldId(fieldIds),
      ]);

    const analysisIds = Array.from(latestAnalysisByFieldId.values()).map(
      (row) => row.id,
    );
    const verdictsByAnalysisId =
      await this.getTechnicalVerdictsByAnalysisId(analysisIds);

    const scheduleIds = Array.from(scheduleByFieldId.values()).map(
      (schedule) => schedule.id,
    );
    const scheduleIdsWithRuns = await this.getScheduleIdsWithRuns(scheduleIds);

    return {
      items: items.map((field) => {
        const latestAnalysisRow = latestAnalysisByFieldId.get(field.id) ?? null;
        const latestAnalysis: AdminFieldLatestAnalysis | null =
          latestAnalysisRow
            ? {
                id: latestAnalysisRow.id,
                status: latestAnalysisRow.status,
                createdAt: latestAnalysisRow.createdAt.toISOString(),
                completedAt: latestAnalysisRow.completedAt
                  ? latestAnalysisRow.completedAt.toISOString()
                  : null,
                durationMs: latestAnalysisRow.durationMs,
                // Solo viaja cuando Finalizado — ver comentario en AdminFieldLatestAnalysis.
                score:
                  latestAnalysisRow.status === 'Finalizado'
                    ? latestAnalysisRow.globalScore
                    : null,
              }
            : null;

        const technicalVerdict = latestAnalysis
          ? (verdictsByAnalysisId.get(latestAnalysis.id) ?? null)
          : null;

        const schedule = scheduleByFieldId.get(field.id) ?? null;
        const weeklyMonitoring: AdminFieldWeeklyMonitoring = {
          active: schedule?.enabled ?? false,
          scheduleId: schedule?.id ?? null,
          nextRunAt: schedule?.nextRunAt
            ? schedule.nextRunAt.toISOString()
            : null,
          lastRunAt: schedule?.lastRunAt
            ? schedule.lastRunAt.toISOString()
            : null,
          hasRuns: schedule ? scheduleIdsWithRuns.has(schedule.id) : false,
        };

        return {
          id: field.id,
          name: field.name,
          ownerId: field.userId,
          ownerEmail: field.user?.email ?? null,
          ownerFullName: field.user?.fullName ?? null,
          lotsCount: lotsCountByFieldId.get(field.id) ?? 0,
          createdAt: field.createdAt.toISOString(),
          updatedAt: field.updatedAt.toISOString(),
          analysisStatus: this.deriveFieldAnalysisStatus(
            latestAnalysis,
            technicalVerdict,
          ),
          requiresAttention: this.fieldRequiresAttention(
            latestAnalysis,
            technicalVerdict,
            weeklyMonitoring,
          ),
          latestAnalysis,
          technicalVerdict,
          weeklyMonitoring,
        };
      }),
      total,
      page,
      limit,
    };
  }

  // Admin PR 5: fragmento reusado por hasAnalysis (PR1), status=without_analysis y
  // countFieldsWithNoAnalysis (más abajo) — mismo criterio scope/lotId de siempre
  // (Analysis.fieldId/lotId son texto libre histórico, sin FK real hacia Field).
  private fieldAnalysisExistsSubquery(fieldAlias: string): string {
    return `SELECT 1 FROM analysis a WHERE (a.scope = 'field' AND a."fieldId" = ${fieldAlias}.id::text) OR (a.scope IS NULL AND a."lotId" = ${fieldAlias}.id::text)`;
  }

  private latestAnalysisIdSubquery(fieldAlias: string): string {
    return `(SELECT a.id FROM analysis a WHERE (a.scope = 'field' AND a."fieldId" = ${fieldAlias}.id::text) OR (a.scope IS NULL AND a."lotId" = ${fieldAlias}.id::text) ORDER BY a."createdAt" DESC LIMIT 1)`;
  }

  private latestAnalysisStatusSubquery(fieldAlias: string): string {
    return `(SELECT a.status FROM analysis a WHERE (a.scope = 'field' AND a."fieldId" = ${fieldAlias}.id::text) OR (a.scope IS NULL AND a."lotId" = ${fieldAlias}.id::text) ORDER BY a."createdAt" DESC LIMIT 1)`;
  }

  private latestAnalysisVerdictSubquery(fieldAlias: string): string {
    return `(SELECT v.verdict FROM analysis_technical_verdicts v WHERE v."analysisId" = ${this.latestAnalysisIdSubquery(fieldAlias)})`;
  }

  /**
   * Admin PR 5: última fila de Analysis por campo en UNA consulta (DISTINCT ON, mismo patrón que
   * getLatestRunsByScheduleId de PR13B) — nunca una consulta por campo.
   */
  private async getLatestAnalysisByFieldId(fieldIds: string[]): Promise<
    Map<
      string,
      {
        id: string;
        status: AnalysisStatus;
        createdAt: Date;
        completedAt: Date | null;
        durationMs: number | null;
        globalScore: number;
      }
    >
  > {
    if (!fieldIds.length) {
      return new Map();
    }

    const rows = await this.fieldRepository.manager.query<
      {
        targetFieldId: string;
        id: string;
        status: AnalysisStatus;
        createdAt: Date;
        completedAt: Date | null;
        durationMs: number | null;
        globalScore: number;
      }[]
    >(
      `
      SELECT DISTINCT ON (f.id)
        f.id AS "targetFieldId", a.id, a.status, a."createdAt", a."completedAt", a."durationMs", a."globalScore"
      FROM fields f
      INNER JOIN analysis a ON (
        (a.scope = 'field' AND a."fieldId" = f.id::text) OR
        (a.scope IS NULL AND a."lotId" = f.id::text)
      )
      WHERE f.id = ANY($1::uuid[])
      ORDER BY f.id, a."createdAt" DESC
      `,
      [fieldIds],
    );

    return new Map(rows.map((row) => [row.targetFieldId, row]));
  }

  // Admin PR 5: FieldAnalysisSchedule.fieldId es unique — a lo sumo un schedule por campo.
  private async getSchedulesByFieldId(
    fieldIds: string[],
  ): Promise<Map<string, FieldAnalysisSchedule>> {
    if (!fieldIds.length) {
      return new Map();
    }

    const schedules = await this.fieldAnalysisScheduleRepository.find({
      where: { fieldId: In(fieldIds) },
    });

    return new Map(schedules.map((schedule) => [schedule.fieldId, schedule]));
  }

  // Admin PR 5: existencia REAL de corridas por scheduleId (mismo criterio EXISTS que hasRuns,
  // PR3) — nunca lastRunAt.
  private async getScheduleIdsWithRuns(
    scheduleIds: string[],
  ): Promise<Set<string>> {
    if (!scheduleIds.length) {
      return new Set();
    }

    const rows = await this.scheduledAnalysisRunRepository.manager.query<
      { scheduleId: string }[]
    >(
      `SELECT DISTINCT "scheduleId" FROM scheduled_analysis_runs WHERE "scheduleId" = ANY($1::uuid[])`,
      [scheduleIds],
    );

    return new Set(rows.map((row) => row.scheduleId));
  }

  // Admin PR 5: estado administrativo/producto — ver AdminFieldAnalysisStatus (admin-field.dto.ts)
  // para la definición completa de cada transición. Nunca un diagnóstico agronómico nuevo, solo
  // una lectura de Analysis.status + AnalysisTechnicalVerdict.verdict, que ya existen.
  private deriveFieldAnalysisStatus(
    latestAnalysis: AdminFieldLatestAnalysis | null,
    technicalVerdict: AdminAnalysisTechnicalVerdict | null,
  ): AdminFieldAnalysisStatus {
    if (!latestAnalysis) {
      return 'without_analysis';
    }

    if (latestAnalysis.status === 'Procesando') {
      return 'processing';
    }

    if (latestAnalysis.status === 'Error') {
      return 'error';
    }

    if (
      technicalVerdict?.verdict === 'attention' ||
      technicalVerdict?.verdict === 'critical'
    ) {
      return 'attention';
    }

    return 'completed';
  }

  /**
   * Admin PR 5: señal operativa independiente de analysisStatus (puede ser true incluso con
   * analysisStatus='completed', ej. schedule activo sin corridas). Solo 3 criterios ya existentes
   * — a propósito NO usa umbrales de score: el admin no tiene bandas de score propias (a
   * diferencia de agro-score-web/shared/utils/score-band.ts), así que este PR no inventa una acá.
   */
  private fieldRequiresAttention(
    latestAnalysis: AdminFieldLatestAnalysis | null,
    technicalVerdict: AdminAnalysisTechnicalVerdict | null,
    weeklyMonitoring: AdminFieldWeeklyMonitoring,
  ): boolean {
    if (latestAnalysis?.status === 'Error') {
      return true;
    }

    if (
      technicalVerdict?.verdict === 'attention' ||
      technicalVerdict?.verdict === 'critical'
    ) {
      return true;
    }

    if (weeklyMonitoring.active && !weeklyMonitoring.hasRuns) {
      return true;
    }

    return false;
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

  async listLots(query: ListLotsQueryDto): Promise<Paginated<AdminLotItem>> {
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

    // Admin PR 2: trazabilidad — "ver lotes de este campo/usuario" desde Campos/Usuarios.
    if (query.fieldId) {
      qb.andWhere('lot."fieldId" = :fieldId', { fieldId: query.fieldId });
    }

    if (query.userId) {
      qb.andWhere('field."userId" = :userId', { userId: query.userId });
    }

    const [items, total] = await qb.getManyAndCount();

    // Admin PR 5: contexto mínimo del campo — 2 consultas en lote acotadas a los fieldId
    // distintos de esta página, nunca una por lote.
    const fieldIds = Array.from(new Set(items.map((lot) => lot.fieldId)));
    const [fieldIdsWithAnalysis, fieldIdsWithActiveMonitoring] =
      await Promise.all([
        this.getFieldIdsWithAnalysis(fieldIds),
        this.getFieldIdsWithActiveMonitoring(fieldIds),
      ]);

    return {
      items: items.map((lot) => ({
        id: lot.id,
        name: lot.name,
        fieldId: lot.fieldId,
        fieldName: lot.field?.name ?? null,
        ownerId: lot.field?.userId ?? null,
        ownerEmail: lot.field?.user?.email ?? null,
        ownerFullName: lot.field?.user?.fullName ?? null,
        fieldHasAnalysis: fieldIdsWithAnalysis.has(lot.fieldId),
        fieldHasActiveMonitoring: fieldIdsWithActiveMonitoring.has(lot.fieldId),
        createdAt: lot.createdAt.toISOString(),
        updatedAt: lot.updatedAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  private async getFieldIdsWithAnalysis(
    fieldIds: string[],
  ): Promise<Set<string>> {
    if (!fieldIds.length) {
      return new Set();
    }

    const rows = await this.fieldRepository.manager.query<{ id: string }[]>(
      `
      SELECT DISTINCT f.id
      FROM fields f
      INNER JOIN analysis a ON (
        (a.scope = 'field' AND a."fieldId" = f.id::text) OR
        (a.scope IS NULL AND a."lotId" = f.id::text)
      )
      WHERE f.id = ANY($1::uuid[])
      `,
      [fieldIds],
    );

    return new Set(rows.map((row) => row.id));
  }

  private async getFieldIdsWithActiveMonitoring(
    fieldIds: string[],
  ): Promise<Set<string>> {
    if (!fieldIds.length) {
      return new Set();
    }

    const schedules = await this.fieldAnalysisScheduleRepository.find({
      where: { fieldId: In(fieldIds), enabled: true },
    });

    return new Set(schedules.map((schedule) => schedule.fieldId));
  }

  // ── Diagnósticos ────────────────────────────────────────────────────

  async listAnalysis(query: ListAnalysisQueryDto): Promise<Paginated<unknown>> {
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

    // Admin PR 2: trazabilidad — foco directo en un análisis puntual desde Programados.
    if (query.analysisId) {
      qb.andWhere('analysis.id = :analysisId', {
        analysisId: query.analysisId,
      });
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

    // PR 13A: una sola consulta en lote (IN analysisId) para toda la página, no una por fila —
    // findResponseByAnalysisId (AnalysisVerdictService) está pensado para GET /analysis/:id, una
    // sola fila, así que acá se lee el repositorio directo, mismo criterio que el resto de este
    // método con Field/Analysis. Nunca genera ni regenera nada, solo lee lo que ya persiste
    // AnalysisVerdictService.generateAndPersist.
    const verdictsByAnalysisId = await this.getTechnicalVerdictsByAnalysisId(
      items.map((analysis) => analysis.id),
    );

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
        technicalVerdict: verdictsByAnalysisId.get(analysis.id) ?? null,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * PR 13A: lectura en lote, solo lectura — nunca llama a AnalysisVerdictService.generateAndPersist
   * ni a ningún generador. Con `ids` vacío evita un `IN ()` inválido (find() sin where devolvería
   * todas las filas de la tabla, lo contrario de lo que se quiere acá).
   */
  private async getTechnicalVerdictsByAnalysisId(
    ids: string[],
  ): Promise<Map<string, AdminAnalysisTechnicalVerdict>> {
    if (!ids.length) {
      return new Map();
    }

    const verdicts = await this.analysisVerdictRepository.find({
      where: { analysisId: In(ids) },
    });

    return new Map(
      verdicts.map((verdict) => [
        verdict.analysisId,
        toAdminAnalysisTechnicalVerdict(verdict),
      ]),
    );
  }

  // ── Análisis programados (PR 13B) ───────────────────────────────────

  /**
   * PR 13B: visibilidad operativa de solo lectura sobre el pipeline de Fase 4A/5/12A — nunca
   * dispara una corrida, nunca reintenta un email, nunca regenera un veredicto. Cuatro consultas
   * en lote (nunca una por fila, sin importar cuántos schedules haya en la página):
   *   1. schedules paginados (con Field/User resueltos, mismo criterio que listAnalysis);
   *   2. la corrida MÁS RECIENTE de cada schedule en una sola query (DISTINCT ON, Postgres),
   *      con su Analysis ya resuelto por join — evita una segunda consulta para analysisStatus;
   *   3. los technicalVerdict de esos analysisId, reusando getTechnicalVerdictsByAnalysisId;
   *   4. (PR 16D) los weeklyTechnicalVerdict de esos scheduledRunId (run.id), vía
   *      WeeklyTechnicalVerdictService.findResponsesByScheduledRunIds.
   */
  async listScheduledAnalysis(query: ListScheduledAnalysisQueryDto): Promise<
    Paginated<AdminScheduledAnalysisItem> & {
      summary: AdminScheduledAnalysisSummary;
    }
  > {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.fieldAnalysisScheduleRepository
      .createQueryBuilder('schedule')
      .leftJoinAndMapOne(
        'schedule.field',
        Field,
        'field',
        // A diferencia de Analysis.fieldId (texto libre histórico, ver listAnalysis más abajo),
        // FieldAnalysisSchedule.fieldId es uuid real — sin el cast ::text que necesita ese otro
        // join (con el cast, "text = uuid" no tiene operador válido en Postgres).
        'field.id = schedule."fieldId"',
      )
      .leftJoinAndMapOne('field.user', User, 'user', 'user.id = field."userId"')
      .orderBy('schedule.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    // Admin PR 2: trazabilidad — "ver programados de este campo/usuario" desde Campos/Usuarios,
    // y "solo activos". hasRuns=false queda fuera (ver comentario en ListScheduledAnalysisQueryDto).
    if (query.fieldId) {
      qb.andWhere('schedule."fieldId" = :fieldId', { fieldId: query.fieldId });
    }

    if (query.userId) {
      qb.andWhere('schedule."userId" = :userId', { userId: query.userId });
    }

    if (query.enabled !== undefined) {
      qb.andWhere('schedule.enabled = :enabled', { enabled: query.enabled });
    }

    // Admin PR 3: existencia REAL de corridas (EXISTS/NOT EXISTS contra scheduled_analysis_runs),
    // no `lastRunAt` — ver comentario en ListScheduledAnalysisQueryDto. Mismo criterio que usa el
    // resumen agregado (`withoutRuns`, más abajo).
    if (query.hasRuns === true) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM scheduled_analysis_runs r WHERE r."scheduleId" = schedule.id)`,
      );
    } else if (query.hasRuns === false) {
      qb.andWhere(
        `NOT EXISTS (SELECT 1 FROM scheduled_analysis_runs r WHERE r."scheduleId" = schedule.id)`,
      );
    }

    // Admin PR 3: el resumen es GLOBAL (todos los schedules, sin los filtros de arriba) — responde
    // "¿cómo está el flujo semanal?" en general, no la pregunta más angosta de la página actual.
    // Se pide en paralelo con la query principal, no es N+1 (una consulta agregada más, no una por
    // fila ni por schedule).
    const [[schedules, total], summary] = await Promise.all([
      qb.getManyAndCount() as Promise<
        [
          (FieldAnalysisSchedule & {
            field?:
              | (Pick<Field, 'id' | 'name' | 'userId'> & {
                  user?: Pick<User, 'id' | 'email' | 'fullName'>;
                })
              | null;
          })[],
          number,
        ]
      >,
      this.getScheduledAnalysisSummary(),
    ]);

    const latestRunsByScheduleId = await this.getLatestRunsByScheduleId(
      schedules.map((schedule) => schedule.id),
    );

    const analysisIds = Array.from(latestRunsByScheduleId.values())
      .map((run) => run.analysisId)
      .filter((id): id is string => Boolean(id));
    const verdictsByAnalysisId =
      await this.getTechnicalVerdictsByAnalysisId(analysisIds);

    const scheduledRunIds = Array.from(latestRunsByScheduleId.values()).map(
      (run) => run.id,
    );
    const weeklyVerdictsByRunId =
      await this.weeklyTechnicalVerdictService.findResponsesByScheduledRunIds(
        scheduledRunIds,
      );

    return {
      items: schedules.map((schedule) => {
        const latestRun = latestRunsByScheduleId.get(schedule.id) ?? null;
        const technicalVerdict = latestRun?.analysisId
          ? (verdictsByAnalysisId.get(latestRun.analysisId) ?? null)
          : null;
        const weeklyTechnicalVerdict = latestRun
          ? (weeklyVerdictsByRunId.get(latestRun.id) ?? null)
          : null;

        return {
          id: schedule.id,
          fieldId: schedule.fieldId,
          fieldName: schedule.field?.name ?? null,
          userId: schedule.userId,
          userEmail: schedule.field?.user?.email ?? null,
          userFullName: schedule.field?.user?.fullName ?? null,
          enabled: schedule.enabled,
          frequency: schedule.frequency,
          nextRunAt: schedule.nextRunAt
            ? schedule.nextRunAt.toISOString()
            : null,
          lastRunAt: schedule.lastRunAt
            ? schedule.lastRunAt.toISOString()
            : null,
          lastStatus: schedule.lastStatus,
          lastErrorMessage: schedule.lastErrorMessage,
          latestRun: latestRun
            ? this.toAdminScheduledAnalysisRun(latestRun)
            : null,
          technicalVerdict,
          weeklyTechnicalVerdict,
        };
      }),
      total,
      page,
      limit,
      summary,
    };
  }

  /**
   * Admin PR 3: resumen global de Programados — ver AdminScheduledAnalysisSummary (comentario
   * completo en el DTO) para el detalle de cada número. Una sola query DISTINCT ON resuelve
   * lastRunOk/lastRunFailed/mailPendingOrFailed juntos (agregados en JS sobre esas filas, sin
   * volver a golpear la DB), en vez de tres consultas separadas.
   */
  private async getScheduledAnalysisSummary(): Promise<AdminScheduledAnalysisSummary> {
    const now = new Date();
    const cutoff7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      total,
      active,
      inactive,
      withoutRuns,
      latestRunRows,
      mailSentLast7Days,
      mailSentLast30Days,
    ] = await Promise.all([
      this.fieldAnalysisScheduleRepository.count(),
      this.fieldAnalysisScheduleRepository.count({ where: { enabled: true } }),
      this.fieldAnalysisScheduleRepository.count({ where: { enabled: false } }),
      this.fieldAnalysisScheduleRepository
        .createQueryBuilder('schedule')
        .where(
          `NOT EXISTS (SELECT 1 FROM scheduled_analysis_runs r WHERE r."scheduleId" = schedule.id)`,
        )
        .getCount(),
      this.fieldAnalysisScheduleRepository.manager.query<
        {
          status: ScheduledRunStatus;
          failedAt: Date | null;
          emailSentAt: Date | null;
        }[]
      >(`
        SELECT DISTINCT ON (r."scheduleId") r.status, r."failedAt", r."emailSentAt"
        FROM scheduled_analysis_runs r
        ORDER BY r."scheduleId", r."createdAt" DESC
      `),
      this.scheduledAnalysisRunRepository.count({
        where: { emailSentAt: MoreThanOrEqual(cutoff7) },
      }),
      this.scheduledAnalysisRunRepository.count({
        where: { emailSentAt: MoreThanOrEqual(cutoff30) },
      }),
    ]);

    let lastRunOk = 0;
    let lastRunFailed = 0;
    let mailPendingOrFailed = 0;

    for (const row of latestRunRows) {
      if (row.status === 'completed') {
        lastRunOk += 1;
        if (!row.emailSentAt) {
          mailPendingOrFailed += 1;
        }
      } else if (row.status === 'failed') {
        lastRunFailed += 1;
        // failedAt NULL en una corrida 'failed' significa que el análisis SÍ terminó bien y recién
        // después se omitió el mail porque el schedule se desactivó antes de poder enviarlo (ver
        // ScheduledAnalysisRunnerService.reconcileRun) — nunca una falla del pipeline (esas
        // siempre setean failedAt). Es el único caso real de "el mail específicamente falló".
        if (!row.failedAt) {
          mailPendingOrFailed += 1;
        }
      }
    }

    return {
      total,
      active,
      inactive,
      withoutRuns,
      lastRunOk,
      lastRunFailed,
      mailSentLast7Days,
      mailSentLast30Days,
      mailPendingOrFailed,
    };
  }

  /**
   * DISTINCT ON (Postgres): una fila por scheduleId, la de mayor createdAt — el ORDER BY tiene que
   * empezar por la misma columna que distinctOn (constraint real de Postgres, no un detalle de
   * TypeORM). leftJoinAndSelect('run.analysis', ...) resuelve analysisStatus en la misma consulta,
   * sin una query aparte por cada run.
   */
  private async getLatestRunsByScheduleId(
    scheduleIds: string[],
  ): Promise<Map<string, ScheduledAnalysisRun>> {
    if (!scheduleIds.length) {
      return new Map();
    }

    const runs = await this.scheduledAnalysisRunRepository
      .createQueryBuilder('run')
      .distinctOn(['run.scheduleId'])
      .leftJoinAndSelect('run.analysis', 'analysis')
      .where('run.scheduleId IN (:...scheduleIds)', { scheduleIds })
      .orderBy('run.scheduleId', 'ASC')
      .addOrderBy('run.createdAt', 'DESC')
      .getMany();

    return new Map(runs.map((run) => [run.scheduleId, run]));
  }

  private toAdminScheduledAnalysisRun(
    run: ScheduledAnalysisRun,
  ): AdminScheduledAnalysisRun {
    return {
      id: run.id,
      status: run.status,
      scheduledFor: run.scheduledFor,
      analysisId: run.analysisId,
      analysisStatus: run.analysis?.status ?? null,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      failedAt: run.failedAt ? run.failedAt.toISOString() : null,
      emailSentAt: run.emailSentAt ? run.emailSentAt.toISOString() : null,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  async markAnalysisReviewed(
    id: string,
    actor: AuditActorContext,
  ): Promise<Analysis> {
    const analysis = await this.analysisRepository.findOne({ where: { id } });

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    if (analysis.status !== 'Error') {
      throw new BadRequestException(
        'Solo se pueden marcar como revisados los diagnósticos con status Error.',
      );
    }

    const before = {
      reviewedAt: analysis.reviewedAt,
      reviewedByUserId: analysis.reviewedByUserId,
    };

    analysis.reviewedAt = new Date();
    analysis.reviewedByUserId = actor.actorUserId;

    const saved = await this.analysisRepository.save(analysis);

    await this.auditLogService.record({
      actor,
      action: 'admin.analysis.marked_reviewed',
      targetType: 'analysis',
      targetId: id,
      before,
      after: {
        reviewedAt: saved.reviewedAt,
        reviewedByUserId: saved.reviewedByUserId,
      },
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

    const before = {
      retryCount: analysis.retryCount,
      lastRetriedAt: analysis.lastRetriedAt,
    };

    analysis.retryCount += 1;
    analysis.lastRetriedAt = new Date();

    const saved = await this.analysisRepository.save(analysis);

    await this.auditLogService.record({
      actor,
      action: 'admin.analysis.retry_requested',
      targetType: 'analysis',
      targetId: id,
      before,
      after: {
        retryCount: saved.retryCount,
        lastRetriedAt: saved.lastRetriedAt,
      },
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
  async listAuditLogs(
    query: ListAuditLogsQueryDto,
  ): Promise<Paginated<AdminAuditLog>> {
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
          select: {
            id: true,
            fieldId: true,
            lotName: true,
            completedAt: true,
            createdAt: true,
          },
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

  private async checkDbHealth(): Promise<{
    status: 'ok' | 'error';
    error?: string;
  }> {
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
    const envCommit =
      this.config.get<string>('GIT_COMMIT') ||
      this.config.get<string>('SOURCE_COMMIT');

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
