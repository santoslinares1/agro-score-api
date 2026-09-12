import { execSync } from 'child_process';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
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
import { WorkerResultJson } from '../python-worker/types';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import {
  FieldAnalysisSchedule,
  ScheduleFrequency,
} from '../scheduled-analysis/entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from '../scheduled-analysis/entities/field-analysis-schedule-status-transition.entity';
import {
  ScheduledAnalysisRun,
  ScheduledRunStatus,
} from '../scheduled-analysis/entities/scheduled-analysis-run.entity';
import {
  WeeklyAnalysisSnapshot,
  WeeklySnapshotDataQuality,
} from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import {
  classifyDataQuality,
  extractSnapshotMetrics,
} from '../scheduled-analysis/weekly-analysis-snapshot-metrics.util';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../scheduled-analysis/schedule-time.util';
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
  AdminFieldDetail,
  AdminFieldDetailWeeklyMonitoring,
  FIELD_DETAIL_ANALYSES_LIMIT,
  FIELD_DETAIL_RUNS_LIMIT,
} from './dto/admin-field-detail.dto';
import {
  AdminFieldAnalysisStatus,
  AdminFieldItem,
  AdminFieldLatestAnalysis,
  AdminFieldWeeklyMonitoring,
} from './dto/admin-field.dto';
import { AdminLotItem } from './dto/admin-lot.dto';
import {
  AdminUserDetail,
  AdminUserDetailAnalysisRow,
  AdminUserDetailAuditLog,
  AdminUserDetailField,
  AdminUserDetailScheduledItem,
  USER_DETAIL_ANALYSES_LIMIT,
  USER_DETAIL_AUDIT_LOGS_LIMIT,
  USER_DETAIL_FIELDS_LIMIT,
  USER_DETAIL_SCHEDULES_LIMIT,
} from './dto/admin-user-detail.dto';
import {
  AdminActivationMetric,
  AdminNorthStarMetric,
  AdminProductAnalyticsCoverage,
  AdminProductAnalyticsDto,
  AdminQualityBreakdownEntry,
  AdminQualityBreakdownMetric,
  AdminRetentionMetric,
  AdminTimeToFirstTechnicalValueMetric,
} from './dto/admin-product-analytics.dto';
import { AdminProductAnalyticsQueryDto } from './dto/admin-product-analytics-query.dto';
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
import {
  CalendarWeek,
  endOfDayInstant,
  localTimeInstant,
  resolveCalendarWeekFromDateOnly,
  resolveLastCompleteCalendarWeek,
  shiftCalendarWeek,
} from './product-analytics-week.util';
import {
  computeTimeToValuePercentiles,
  hoursBetween,
} from './time-to-value.util';

// Mismo costo que AuthService — ver src/auth/auth.service.ts. No se
// comparte la constante entre módulos para no acoplar AdminModule a
// AuthModule por un valor tan chico; si cambia, cambia en los dos lugares.
const SALT_ROUNDS = 10;

const INVITATION_EXPIRES_IN_DAYS = 7;
const PASSWORD_RESET_EXPIRES_IN_HOURS = 2;

// KPIs P0 (auditoría de KPIs + Decision 1/2): mismo timezone default que scheduled-analysis (sin
// DST, offset fijo — ver schedule-time.util.ts) para que la semana calendario de reporting sea
// consistente con el resto del producto, no una convención nueva.
const PRODUCT_ANALYTICS_TIMEZONE = DEFAULT_SCHEDULE_TIMEZONE;

// North Star eligibility — decisión de producto (ticket de corrección del denominador de North
// Star, guardada como memoria de proyecto "agroscore-north-star-eligibility-decision"): un field
// es elegible para una semana si su schedule tenía esta configuración EXACTA y estaba enabled=true
// el lunes 09:00 de esa semana en America/Argentina/Cordoba. Coincide HOY con los defaults de
// creación de FieldAnalysisScheduleService (DEFAULT_DAY_OF_WEEK/HOUR/MINUTE) — pero se declara acá
// de forma INDEPENDIENTE a propósito: es una decisión sobre qué población cuenta para el KPI, no
// un detalle de formulario, y no deben acoplarse aunque hoy coincidan (si el default de creación
// cambia mañana, el cutoff canónico de North Star no cambia solo porque comparten el número hoy).
// Consecuencias aceptadas (ver la decisión): una activación posterior al cutoff entra recién la
// semana siguiente; una desactivación posterior al cutoff NO saca retroactivamente la
// elegibilidad; schedules con cualquier otra configuración quedan fuera del P0 por completo y se
// exponen aparte como `coverage.nonCanonicalSchedules` — nunca se reconstruye su historia de
// horario (no existe, fuera de alcance) para intentar incluirlos.
const NORTH_STAR_CANONICAL_FREQUENCY: ScheduleFrequency = 'weekly';
const NORTH_STAR_CANONICAL_DAY_OF_WEEK = 1; // lunes — misma convención que Date.getUTCDay().
const NORTH_STAR_CANONICAL_HOUR = 9;
const NORTH_STAR_CANONICAL_MINUTE = 0;
const NORTH_STAR_CANONICAL_TIMEZONE = PRODUCT_ANALYTICS_TIMEZONE;

// Tope operativo de Analysis.resultJson efectivamente cargados para activation/time-to-value
// (computeActivationAndTimeToValue) — resultJson puede traer imágenes base64 pesadas (mapAssets,
// imageSeries), así que "sin límite" no es una opción real. El scan corta ANTES de este tope en la
// práctica: se detiene apenas toda la cohorte elegible queda activada, sin importar cuánto volumen
// de Analysis exista más allá de eso. Si el tope se alcanza con usuarios todavía sin resolver, se
// expone explícitamente en coverage.analysisClassificationScan — nunca se infla activation en
// silencio ni se pretende cobertura completa.
const ANALYSIS_ACTIVATION_SCAN_BATCH_SIZE = 200;
const ANALYSIS_ACTIVATION_SCAN_MAX_ROWS = 5000;

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
    @InjectRepository(WeeklyAnalysisSnapshot)
    private readonly weeklyAnalysisSnapshotRepository: Repository<WeeklyAnalysisSnapshot>,
    @InjectRepository(FieldAnalysisScheduleStatusTransition)
    private readonly fieldAnalysisScheduleTransitionRepository: Repository<FieldAnalysisScheduleStatusTransition>,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
    @InjectRepository(UserInvitation)
    private readonly invitationRepository: Repository<UserInvitation>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetRepository: Repository<PasswordResetToken>,
    private readonly weeklyTechnicalVerdictService: WeeklyTechnicalVerdictService,
    private readonly analysisVerdictService: AnalysisVerdictService,
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
   * KPIs P0 (auditoría de KPIs + Decision 1/2) — GET /admin/product-analytics. Reemplaza el funnel
   * de 9 etapas (Admin PR 4, mezclaba users/fields/schedules/runs/emails en una sola "conversión"
   * que nunca fue un funnel de cohorte real) por el conjunto mínimo de KPIs P0: solo resultados
   * `dataQualityStatus='sufficient'` cuentan como entrega técnica utilizable — `partial` nunca se
   * promueve a un numerador de valor, ver AdminQualityBreakdownMetric para dónde sí aparece.
   *
   * North Star/calidad usan la MISMA semana calendario (lunes-domingo, ver
   * product-analytics-week.util.ts) — no la ventana móvil de 7 días propia de cada
   * WeeklyAnalysisSnapshot, que no es comparable entre campos con schedules en días distintos.
   * Activation/time-to-value NO están acotados a esa semana: miden la cohorte completa de usuarios
   * elegibles hasta ahora (ver computeActivationAndTimeToValue).
   *
   * Retención usa un par de semanas PROPIO, `week - 1` (N) → `week` (N+1) — nunca `week` → `week +
   * 1` como el resto: con el default (`week` = última semana completa), `week + 1` sería siempre la
   * semana EN CURSO, y la retención quedaría subestimada hasta que esa semana termine (ver el
   * ticket de corrección — gap P0 confirmado). Anclar N+1 a `week` garantiza que, en el caso
   * default, ambas mitades ya estén completamente terminadas. Una `week` pedida explícitamente
   * puede seguir siendo la semana en curso o futura — para eso existe
   * `retention.periodComplete` (ver computeRetention): nunca se infiere completitud desde la
   * existencia de snapshots, solo desde el reloj.
   *
   * `northStarCutoffInstant` (North Star eligibility, decisión de producto — ver
   * NORTH_STAR_CANONICAL_* arriba) se calcula UNA sola vez acá y se reusa tanto para reconstruir
   * elegibilidad (computeNorthStar) como para juzgar si la cobertura histórica alcanza para
   * afirmarla (getScheduleHistoryCoverage) — un solo criterio de "cutoff", nunca dos que puedan
   * divergir entre sí.
   */
  async getProductAnalytics(
    query: AdminProductAnalyticsQueryDto = {},
  ): Promise<AdminProductAnalyticsDto> {
    const now = new Date();
    const week: CalendarWeek = query.week
      ? resolveCalendarWeekFromDateOnly(query.week)
      : resolveLastCompleteCalendarWeek(now, PRODUCT_ANALYTICS_TIMEZONE);
    const retentionWeek = shiftCalendarWeek(week, -1);
    const retentionNextWeek = week;
    const northStarCutoffInstant = localTimeInstant(
      week.weekStart,
      NORTH_STAR_CANONICAL_HOUR,
      NORTH_STAR_CANONICAL_MINUTE,
      NORTH_STAR_CANONICAL_TIMEZONE,
    );

    const [
      northStar,
      activationAndTimeToValue,
      retention,
      qualityBreakdown,
      scheduleHistoryCoverage,
      nonCanonicalSchedulesCount,
      analysisTimingCoverage,
    ] = await Promise.all([
      this.computeNorthStar(week, northStarCutoffInstant),
      this.computeActivationAndTimeToValue(),
      this.computeRetention(retentionWeek, retentionNextWeek, now),
      this.computeQualityBreakdown(week),
      this.getScheduleHistoryCoverage(northStarCutoffInstant),
      this.getNonCanonicalSchedulesCount(),
      this.getAnalysisTimingCoverage(),
    ]);

    const coverage: AdminProductAnalyticsCoverage = {
      scheduleHistory: scheduleHistoryCoverage,
      analysisClassificationScan: activationAndTimeToValue.coverage,
      nonCanonicalSchedules: { count: nonCanonicalSchedulesCount },
      analysisTimingAvailability: analysisTimingCoverage,
    };

    return {
      generatedAt: now.toISOString(),
      period: { week, timezone: PRODUCT_ANALYTICS_TIMEZONE },
      coverage,
      northStar,
      activation: activationAndTimeToValue.activation,
      timeToFirstTechnicalValue:
        activationAndTimeToValue.timeToFirstTechnicalValue,
      retention,
      qualityBreakdown,
    };
  }

  /**
   * KPI #1 — "Campos con monitoreo utilizable semanal" (North Star). Población elegible
   * restringida a schedules CANÓNICOS (frequency/dayOfWeek/hour/minute/timezone == los
   * NORTH_STAR_CANONICAL_* de arriba — decisión de producto explícita, ver esa constante):
   * cualquier otra configuración queda fuera del P0 por completo, ni numerador ni denominador —
   * ver `coverage.nonCanonicalSchedules` para esa cuenta aparte.
   *
   * Denominador: fields con schedule canónico cuyo estado reconstruido (desde
   * field_analysis_schedule_status_transitions, ticket anterior) al CUTOFF canónico
   * (`cutoffInstant` — lunes 09:00 de esa semana, nunca el cierre del domingo) es enabled=true.
   * Numerador: de ESOS MISMOS fields (INNER JOIN contra el universo elegible, no una query
   * independiente) los que además tienen snapshot sufficient con `weekEnd` en la semana — así
   * usableFieldsCount <= eligibleFieldsCount queda garantizado por construcción SQL, no solo por
   * convención.
   */
  private async computeNorthStar(
    week: CalendarWeek,
    cutoffInstant: Date,
  ): Promise<AdminNorthStarMetric> {
    const rows =
      await this.fieldAnalysisScheduleTransitionRepository.manager.query<
        { eligibleFieldsCount: string; usableFieldsCount: string }[]
      >(
        `WITH canonical_schedules AS (
         SELECT id
         FROM field_analysis_schedules
         WHERE frequency = $1
           AND "dayOfWeek" = $2
           AND hour = $3
           AND minute = $4
           AND timezone = $5
       ),
       -- DISTINCT ON (scheduleId) ... ORDER BY effectiveAt DESC = la transición vigente de cada
       -- schedule canónico al cutoff consultado (ver invariante en
       -- field-analysis-schedule-status-transition.entity.ts).
       latest_transition AS (
         SELECT DISTINCT ON (t."scheduleId") t."scheduleId", t."fieldId", t.enabled
         FROM field_analysis_schedule_status_transitions t
         INNER JOIN canonical_schedules cs ON cs.id = t."scheduleId"
         WHERE t."effectiveAt" <= $6
         ORDER BY t."scheduleId", t."effectiveAt" DESC, t."createdAt" DESC
       ),
       eligible_fields AS (
         SELECT DISTINCT "fieldId" FROM latest_transition WHERE enabled = true
       )
       SELECT
         (SELECT COUNT(*)::int FROM eligible_fields) AS "eligibleFieldsCount",
         (SELECT COUNT(DISTINCT s."fieldId")::int
          FROM weekly_analysis_snapshots s
          INNER JOIN eligible_fields ef ON ef."fieldId" = s."fieldId"
          WHERE s."weekEnd" BETWEEN $7 AND $8 AND s."dataQualityStatus" = 'sufficient'
         ) AS "usableFieldsCount"`,
        [
          NORTH_STAR_CANONICAL_FREQUENCY,
          NORTH_STAR_CANONICAL_DAY_OF_WEEK,
          NORTH_STAR_CANONICAL_HOUR,
          NORTH_STAR_CANONICAL_MINUTE,
          NORTH_STAR_CANONICAL_TIMEZONE,
          cutoffInstant,
          week.weekStart,
          week.weekEnd,
        ],
      );

    const eligibleFieldsCount = Number(rows[0]?.eligibleFieldsCount ?? 0);
    const usableFieldsCount = Number(rows[0]?.usableFieldsCount ?? 0);

    return {
      week,
      usableFieldsCount,
      eligibleFieldsCount,
      rate:
        eligibleFieldsCount > 0
          ? usableFieldsCount / eligibleFieldsCount
          : null,
    };
  }

  /**
   * Señal de calidad de datos para North Star (ver `coverage.nonCanonicalSchedules` en el DTO):
   * cuántos schedules HOY tienen una configuración distinta de la canónica. Es un conteo sobre la
   * configuración VIGENTE, no reconstruido para ninguna semana en particular — no existe historia
   * de dayOfWeek/hour/minute/timezone (solo de `enabled`, ver ticket anterior), así que no hay
   * forma de afirmar con certeza qué configuración tenía un schedule en el pasado. Nunca se
   * excluyen del conteo por estar `enabled=false`: la pregunta es "¿cuántos schedules no siguen el
   * cutoff que North Star asume?", no "¿cuántos están afectando el KPI ahora mismo?".
   */
  private async getNonCanonicalSchedulesCount(): Promise<number> {
    const rows = await this.fieldAnalysisScheduleRepository.manager.query<
      { count: string }[]
    >(
      `SELECT COUNT(*)::int AS count
       FROM field_analysis_schedules
       WHERE NOT (
         frequency = $1
         AND "dayOfWeek" = $2
         AND hour = $3
         AND minute = $4
         AND timezone = $5
       )`,
      [
        NORTH_STAR_CANONICAL_FREQUENCY,
        NORTH_STAR_CANONICAL_DAY_OF_WEEK,
        NORTH_STAR_CANONICAL_HOUR,
        NORTH_STAR_CANONICAL_MINUTE,
        NORTH_STAR_CANONICAL_TIMEZONE,
      ],
    );

    return Number(rows[0]?.count ?? 0);
  }

  /**
   * KPI #4 — retención semanal técnica de fields. Denominador: fields sufficient en la semana N.
   * Numerador: el MISMO fieldId, también sufficient en N+1 — el INTERSECT hace esa comparación por
   * identidad de fila, nunca por conteo agregado (evita el error clásico de "conteo de N+1 / conteo
   * de N", que no garantiza que sean los mismos campos).
   *
   * `periodComplete` es un chequeo de RELOJ, nunca de datos: compara `now` contra el instante real
   * de cierre de N+1 (23:59:59.999 en America/Argentina/Cordoba) — jamás se infiere que N+1 ya
   * terminó porque ya tiene algún snapshot sufficient (eso solo demostraría que ALGÚN campo corrió
   * temprano esa semana, no que la semana completa). `week`/`nextWeek` que recibe este método ya
   * vienen resueltas por el caller (getProductAnalytics) para que N+1 sea `period.week` — acá no se
   * decide esa relación, solo se verifica si terminó.
   */
  private async computeRetention(
    week: CalendarWeek,
    nextWeek: CalendarWeek,
    now: Date,
  ): Promise<AdminRetentionMetric> {
    const periodComplete =
      now.getTime() >=
      endOfDayInstant(nextWeek.weekEnd, PRODUCT_ANALYTICS_TIMEZONE).getTime();

    const [sufficientRows, retainedRows] = await Promise.all([
      this.weeklyAnalysisSnapshotRepository.manager.query<{ count: string }[]>(
        `SELECT COUNT(DISTINCT "fieldId")::int AS count
         FROM weekly_analysis_snapshots
         WHERE "weekEnd" BETWEEN $1 AND $2 AND "dataQualityStatus" = 'sufficient'`,
        [week.weekStart, week.weekEnd],
      ),
      this.weeklyAnalysisSnapshotRepository.manager.query<{ count: string }[]>(
        `SELECT COUNT(*)::int AS count FROM (
           SELECT "fieldId" FROM weekly_analysis_snapshots
           WHERE "weekEnd" BETWEEN $1 AND $2 AND "dataQualityStatus" = 'sufficient'
           INTERSECT
           SELECT "fieldId" FROM weekly_analysis_snapshots
           WHERE "weekEnd" BETWEEN $3 AND $4 AND "dataQualityStatus" = 'sufficient'
         ) retained`,
        [week.weekStart, week.weekEnd, nextWeek.weekStart, nextWeek.weekEnd],
      ),
    ]);

    const sufficientInWeekCount = Number(sufficientRows[0]?.count ?? 0);
    const retainedInNextWeekCount = Number(retainedRows[0]?.count ?? 0);

    return {
      week,
      nextWeek,
      periodComplete,
      sufficientInWeekCount,
      retainedInNextWeekCount,
      // Invariante del ticket: rate != null ⟹ N y N+1 terminaron completamente. `periodComplete`
      // se evalúa PRIMERO — un denominador > 0 nunca alcanza para mostrar un rate si N+1 todavía
      // está en curso o es futura.
      rate:
        periodComplete && sufficientInWeekCount > 0
          ? retainedInNextWeekCount / sufficientInWeekCount
          : null,
    };
  }

  /**
   * KPI #5 — breakdown de calidad. Siempre las tres categorías, incluso en 0 — nunca se omite
   * 'partial'/'insufficient' porque esa semana no tuvo ninguno (el ticket exige poder distinguir
   * "cero partial" de "no se sabe").
   */
  private async computeQualityBreakdown(
    week: CalendarWeek,
  ): Promise<AdminQualityBreakdownMetric> {
    const rows = await this.weeklyAnalysisSnapshotRepository.manager.query<
      { status: WeeklySnapshotDataQuality; count: string }[]
    >(
      `SELECT "dataQualityStatus" AS status, COUNT(*)::int AS count
       FROM weekly_analysis_snapshots
       WHERE "weekEnd" BETWEEN $1 AND $2
       GROUP BY "dataQualityStatus"`,
      [week.weekStart, week.weekEnd],
    );

    const counts = new Map<WeeklySnapshotDataQuality, number>([
      ['sufficient', 0],
      ['partial', 0],
      ['insufficient', 0],
    ]);
    for (const row of rows) {
      counts.set(row.status, Number(row.count));
    }

    const totalSnapshots = Array.from(counts.values()).reduce(
      (acc, n) => acc + n,
      0,
    );

    const breakdown: AdminQualityBreakdownEntry[] = (
      ['sufficient', 'partial', 'insufficient'] as const
    ).map((status) => {
      const count = counts.get(status) ?? 0;
      return {
        status,
        count,
        proportion: totalSnapshots > 0 ? count / totalSnapshots : null,
      };
    });

    return { week, totalSnapshots, breakdown };
  }

  /**
   * Cobertura honesta del denominador de North Star (ticket anterior: "hasta que exista cobertura
   * completa del historial de schedules, devolver metadata que indique denominador histórico
   * incompleto"). `complete` exige que el CUTOFF real evaluado (`cutoffInstant` — lunes 09:00 de la
   * semana consultada, ver getProductAnalytics) esté en o después de la fila más antigua del
   * historial — el mismo instante que `computeNorthStar` reconstruye, nunca uno distinto (antes
   * era el cierre del domingo; una baseline posterior al lunes 09:00 pero anterior al domingo
   * habría afirmado "completo" incorrectamente, ver el ticket de corrección).
   */
  private async getScheduleHistoryCoverage(
    cutoffInstant: Date,
  ): Promise<AdminProductAnalyticsCoverage['scheduleHistory']> {
    const rows =
      await this.fieldAnalysisScheduleTransitionRepository.manager.query<
        { min: Date | null }[]
      >(
        `SELECT MIN("effectiveAt") AS min FROM field_analysis_schedule_status_transitions`,
      );

    const availableFrom = rows[0]?.min ?? null;

    if (!availableFrom) {
      // Sin ninguna fila todavía: no hay evidencia de ningún tipo — nunca se afirma "completo" por
      // ausencia de datos, aunque el count resultante (0) sea, de hecho, correcto.
      return { availableFrom: null, complete: false };
    }

    const availableFromDate = new Date(availableFrom);

    return {
      availableFrom: availableFromDate.toISOString(),
      complete: cutoffInstant.getTime() >= availableFromDate.getTime(),
    };
  }

  /**
   * Cobertura honesta del insumo de `activation`/`timeToFirstTechnicalValue` (KPI review —
   * instrumentación, ticket 1/3): ambas métricas filtran `Analysis.completedAt IS NOT NULL`
   * (columna agregada por la migración `AddAnalysisTimingFields`, sin backfill — ver esa
   * migración). Mismo patrón que `getScheduleHistoryCoverage`: `availableFrom` se calcula SIEMPRE
   * desde el dato real (`MIN(completedAt)`), nunca desde la fecha de la migración — un deploy no
   * prueba que la columna ya tenga datos reales.
   *
   * `complete` exige que no exista ningún Analysis `Finalizado` con `completedAt IS NULL` creado
   * ANTES de `availableFrom` — si existe, significa que hay usuarios cuyo primer resultado
   * sufficient puede ser anterior al rollout y por lo tanto invisible para `activation`/
   * `timeToFirstTechnicalValue`, que no tienen forma de contarlos. Sin ningún `completedAt`
   * todavía (`availableFrom: null`) nunca se afirma `complete: true` — ausencia total de datos no
   * es cobertura completa, mismo criterio que `getScheduleHistoryCoverage`.
   */
  private async getAnalysisTimingCoverage(): Promise<
    AdminProductAnalyticsCoverage['analysisTimingAvailability']
  > {
    const rows = await this.analysisRepository.manager.query<
      { availableFrom: Date | null; hasGap: boolean }[]
    >(
      `SELECT
         (SELECT MIN("completedAt") FROM analysis) AS "availableFrom",
         EXISTS (
           SELECT 1 FROM analysis
           WHERE status = 'Finalizado'
             AND "completedAt" IS NULL
             AND "createdAt" < (SELECT MIN("completedAt") FROM analysis)
         ) AS "hasGap"`,
    );

    const availableFrom = rows[0]?.availableFrom ?? null;

    if (!availableFrom) {
      // Sin ningún completedAt todavía: igual que getScheduleHistoryCoverage, ausencia total de
      // evidencia nunca se afirma como cobertura completa.
      return { availableFrom: null, complete: false };
    }

    return {
      availableFrom: new Date(availableFrom).toISOString(),
      complete: !rows[0].hasGap,
    };
  }

  /**
   * KPIs #2/#3 — Activation técnica y Time to First Technical Value. Único lugar que clasifica
   * Analysis.resultJson directamente (no WeeklyAnalysisSnapshot.dataQualityStatus, que solo existe
   * para corridas del scheduler): la activación de un usuario puede venir de CUALQUIER Analysis de
   * Field, manual o automático — reusa classifyDataQuality/extractSnapshotMetrics tal cual, nunca
   * reimplementa la regla en SQL.
   *
   * Lectura acotada (ver ANALYSIS_ACTIVATION_SCAN_* arriba): recorre Analysis 'Finalizado' de Field
   * (regla scope/fieldId/lotId de siempre, ver AnalysisService.findByField) en lotes ordenados por
   * completedAt ASC, y se DETIENE apenas toda la cohorte elegible queda activada — nunca carga más
   * resultJson que los estrictamente necesarios para resolver "el primer sufficient de cada
   * usuario", acotado además por un tope duro de filas.
   */
  private async computeActivationAndTimeToValue(): Promise<{
    activation: AdminActivationMetric;
    timeToFirstTechnicalValue: AdminTimeToFirstTechnicalValueMetric;
    coverage: AdminProductAnalyticsCoverage['analysisClassificationScan'];
  }> {
    const eligibleUsers = await this.usersService.listEligibleProducers();

    if (eligibleUsers.length === 0) {
      return {
        activation: {
          eligibleUsersCount: 0,
          activatedUsersCount: 0,
          rate: null,
        },
        timeToFirstTechnicalValue: {
          cohortUsersCount: 0,
          activatedUsersCount: 0,
          notActivatedUsersCount: 0,
          p50Hours: null,
          p75Hours: null,
          p95Hours: null,
        },
        coverage: {
          scanned: 0,
          limit: ANALYSIS_ACTIVATION_SCAN_MAX_ROWS,
          truncated: false,
        },
      };
    }

    const createdAtByUserId = new Map(
      eligibleUsers.map((user) => [user.id, user.createdAt]),
    );
    const pendingUserIds = new Set(eligibleUsers.map((user) => user.id));
    const activatedAt = new Map<string, Date>();

    // Cursor compuesto (completedAt, id) — nunca solo completedAt: dos Analysis distintos pueden
    // compartir el mismo completedAt exacto (mismo tick de reconciliación, por ejemplo), y un
    // cursor de una sola columna con comparación estricta ">" puede dejar SIN VOLVER A CONSULTAR
    // para siempre a la fila empatada que cayó del lado equivocado de un corte de lote — no un
    // simple "incompleto" (eso ya lo cubre `truncated`), sino un resultado directamente
    // incorrecto: un usuario cuyo primer Analysis sufficient real cae justo en ese empate
    // aparecería como "no activado". `id` como desempate hace que el cursor sea una clave
    // verdaderamente única, igual que ORDER BY completedAt ASC, id ASC de abajo.
    let cursor: { completedAt: Date; id: string } | null = null;
    let scanned = 0;

    while (
      pendingUserIds.size > 0 &&
      scanned < ANALYSIS_ACTIVATION_SCAN_MAX_ROWS
    ) {
      const batchLimit = Math.min(
        ANALYSIS_ACTIVATION_SCAN_BATCH_SIZE,
        ANALYSIS_ACTIVATION_SCAN_MAX_ROWS - scanned,
      );

      const rows: Array<{
        id: string;
        resultJson: WorkerResultJson | null;
        completedAt: Date;
        userId: string;
      }> = await this.analysisRepository.manager.query(
        `SELECT a.id, a."resultJson", a."completedAt", f."userId" AS "userId"
           FROM analysis a
           INNER JOIN fields f ON (
             (a.scope = 'field' AND a."fieldId" = f.id::text) OR
             (a.scope IS NULL AND a."lotId" = f.id::text)
           )
           WHERE a.status = 'Finalizado'
             AND a."completedAt" IS NOT NULL
             AND (
               $1::timestamp IS NULL
               OR a."completedAt" > $1
               OR (a."completedAt" = $1 AND a.id > $4::uuid)
             )
             AND f."userId" = ANY($2::uuid[])
           ORDER BY a."completedAt" ASC, a.id ASC
           LIMIT $3`,
        [
          cursor?.completedAt ?? null,
          Array.from(pendingUserIds),
          batchLimit,
          cursor?.id ?? null,
        ],
      );

      if (rows.length === 0) {
        break;
      }

      scanned += rows.length;
      const lastRow = rows[rows.length - 1];
      cursor = { completedAt: lastRow.completedAt, id: lastRow.id };

      for (const row of rows) {
        if (!pendingUserIds.has(row.userId)) {
          continue; // ya activado en un lote anterior — no reclasifica de más.
        }

        const classification = classifyDataQuality(
          extractSnapshotMetrics(row.resultJson),
        );
        if (classification.status === 'sufficient') {
          activatedAt.set(row.userId, row.completedAt);
          pendingUserIds.delete(row.userId);
        }
      }

      if (rows.length < batchLimit) {
        break; // no hay más candidatos — se agotaron antes del tope.
      }
    }

    const activatedUsersCount = activatedAt.size;
    const durationsHours = Array.from(activatedAt.entries()).map(
      ([userId, completedAt]) =>
        hoursBetween(createdAtByUserId.get(userId) as Date, completedAt),
    );
    const percentiles = computeTimeToValuePercentiles(durationsHours);

    return {
      activation: {
        eligibleUsersCount: eligibleUsers.length,
        activatedUsersCount,
        rate:
          eligibleUsers.length > 0
            ? activatedUsersCount / eligibleUsers.length
            : null,
      },
      timeToFirstTechnicalValue: {
        cohortUsersCount: eligibleUsers.length,
        activatedUsersCount,
        notActivatedUsersCount: eligibleUsers.length - activatedUsersCount,
        p50Hours: percentiles.p50,
        p75Hours: percentiles.p75,
        p95Hours: percentiles.p95,
      },
      coverage: {
        scanned,
        limit: ANALYSIS_ACTIVATION_SCAN_MAX_ROWS,
        truncated:
          pendingUserIds.size > 0 &&
          scanned >= ANALYSIS_ACTIVATION_SCAN_MAX_ROWS,
      },
    };
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

  /**
   * Admin PR 7: vista de detalle de UN usuario — GET /admin/users/:userId, solo lectura. Mismo
   * principio de reuso que Field Detail (PR6): en vez de `fieldIds=[fieldId]`, acá los mismos
   * helpers batched de PR5 se llaman con TODOS los fieldIds del usuario. `fields` se trae
   * completo (sin paginar) porque los conteos de `summary` (fieldsWithoutAnalysisCount,
   * fieldsRequiringAttentionCount, lotsCount) tienen que cubrir TODOS los campos del usuario, no
   * solo los que se muestran en pantalla — sigue siendo O(1) queries (nunca una por campo), solo
   * que el array de entrada a esas queries batched es más grande. El array `fields` que viaja al
   * frontend sí se acota a USER_DETAIL_FIELDS_LIMIT.
   */
  async getUserDetail(userId: string): Promise<AdminUserDetail> {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const fields = await this.fieldRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    const fieldIds = fields.map((field) => field.id);

    const [
      lotsCountByFieldId,
      latestAnalysisByFieldId,
      scheduleByFieldId,
      analysisCounts,
      recentAnalysisRows,
      sentEmailsCount,
      recentAuditLogs,
    ] = await Promise.all([
      this.countLotsByFieldId(fieldIds),
      this.getLatestAnalysisByFieldId(fieldIds),
      this.getSchedulesByFieldId(fieldIds),
      this.getAnalysisCountsForUser(userId),
      this.getRecentAnalysesForUser(userId, USER_DETAIL_ANALYSES_LIMIT),
      this.scheduledAnalysisRunRepository.count({
        where: { userId, emailSentAt: Not(IsNull()) },
      }),
      this.getAuditLogsForUser(userId, USER_DETAIL_AUDIT_LOGS_LIMIT),
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

    // Estado por campo, para TODOS los campos del usuario — reusa deriveFieldAnalysisStatus /
    // fieldRequiresAttention tal cual (mismos métodos que listFields/getFieldDetail), sin
    // divergir. Sirve tanto para el array `fields` (acotado abajo) como para los conteos de
    // `summary` (que sí cubren el total).
    const fieldRows: AdminUserDetailField[] = fields.map((field) => {
      const latestAnalysisRow = latestAnalysisByFieldId.get(field.id) ?? null;
      const latestAnalysis: AdminFieldLatestAnalysis | null = latestAnalysisRow
        ? {
            id: latestAnalysisRow.id,
            status: latestAnalysisRow.status,
            createdAt: latestAnalysisRow.createdAt.toISOString(),
            completedAt: latestAnalysisRow.completedAt
              ? latestAnalysisRow.completedAt.toISOString()
              : null,
            durationMs: latestAnalysisRow.durationMs,
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
    });

    const schedules = Array.from(scheduleByFieldId.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, USER_DETAIL_SCHEDULES_LIMIT);
    const scheduledAnalysis = await this.buildScheduledAnalysisForSchedules(
      schedules,
      fields,
    );

    const recentAnalyses: AdminUserDetailAnalysisRow[] = recentAnalysisRows.map(
      (analysis) => ({
        id: analysis.id,
        fieldId: analysis.fieldId,
        fieldName: analysis.field?.name ?? analysis.lotName,
        status: analysis.status,
        createdAt: analysis.createdAt.toISOString(),
        completedAt: analysis.completedAt
          ? analysis.completedAt.toISOString()
          : null,
        durationMs: analysis.durationMs,
        score: analysis.status === 'Finalizado' ? analysis.globalScore : null,
        errorMessage: analysis.errorMessage,
        reviewedAt: analysis.reviewedAt
          ? analysis.reviewedAt.toISOString()
          : null,
      }),
    );

    const activeSchedules = Array.from(scheduleByFieldId.values()).filter(
      (schedule) => schedule.enabled,
    );

    return {
      user: this.usersService.toPublicUser(user),
      summary: {
        fieldsCount: fields.length,
        lotsCount: Array.from(lotsCountByFieldId.values()).reduce(
          (total, count) => total + count,
          0,
        ),
        analysesCount: analysisCounts.total,
        completedAnalysesCount: analysisCounts.completed,
        failedAnalysesCount: analysisCounts.failed,
        fieldsWithoutAnalysisCount: fieldRows.filter(
          (field) => field.analysisStatus === 'without_analysis',
        ).length,
        fieldsRequiringAttentionCount: fieldRows.filter(
          (field) => field.requiresAttention,
        ).length,
        activeSchedulesCount: activeSchedules.length,
        schedulesWithoutRunsCount: activeSchedules.filter(
          (schedule) => !scheduleIdsWithRuns.has(schedule.id),
        ).length,
        sentEmailsCount,
      },
      fields: fieldRows.slice(0, USER_DETAIL_FIELDS_LIMIT),
      recentAnalyses,
      scheduledAnalysis,
      recentAuditLogs,
    };
  }

  /**
   * Admin PR 7: total/completados/fallidos de Analysis para TODOS los campos del usuario en una
   * sola consulta agregada (COUNT... FILTER) — mismo join scope/lotId de siempre, nunca una
   * consulta por campo ni por análisis.
   */
  private async getAnalysisCountsForUser(
    userId: string,
  ): Promise<{ total: number; completed: number; failed: number }> {
    const rows = await this.fieldRepository.manager.query<
      { total: string; completed: string; failed: string }[]
    >(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE a.status = 'Finalizado')::int AS completed,
        COUNT(*) FILTER (WHERE a.status = 'Error')::int AS failed
      FROM analysis a
      INNER JOIN fields f ON (
        (a.scope = 'field' AND a."fieldId" = f.id::text) OR
        (a.scope IS NULL AND a."lotId" = f.id::text)
      )
      WHERE f."userId" = $1
      `,
      [userId],
    );

    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  /**
   * Admin PR 7: últimas `limit` análisis de CUALQUIER campo del usuario — misma condición
   * scope/lotId de siempre para el join, pero a diferencia de listAnalysis (que solo matchea por
   * `fieldId` directo y por eso pierde los análisis legacy con scope=null al filtrar por userId),
   * acá se usa el criterio completo (igual que getAnalysesForField/fieldAnalysisExistsSubquery)
   * para no excluir esos análisis históricos del usuario.
   */
  private async getRecentAnalysesForUser(
    userId: string,
    limit: number,
  ): Promise<AnalysisWithField[]> {
    const items = await this.analysisRepository
      .createQueryBuilder('analysis')
      .leftJoinAndMapOne(
        'analysis.field',
        Field,
        'field',
        `(analysis.scope = 'field' AND field.id::text = analysis."fieldId") OR (analysis.scope IS NULL AND field.id::text = analysis."lotId")`,
      )
      .where('field."userId" = :userId', { userId })
      .orderBy('analysis.createdAt', 'DESC')
      .take(limit)
      .getMany();

    return items;
  }

  /**
   * Admin PR 7: arma AdminUserDetailScheduledItem[] a partir de los schedules ya resueltos (sin
   * volver a golpear field_analysis_schedules) — reusa getLatestRunsByScheduleId (PR13B),
   * getTechnicalVerdictsByAnalysisId y findResponsesByScheduledRunIds (PR16D), igual que
   * listScheduledAnalysis, solo que acotado a los schedules de este usuario en vez de paginado.
   */
  private async buildScheduledAnalysisForSchedules(
    schedules: FieldAnalysisSchedule[],
    fields: Field[],
  ): Promise<AdminUserDetailScheduledItem[]> {
    if (!schedules.length) {
      return [];
    }

    const fieldNameById = new Map(
      fields.map((field) => [field.id, field.name]),
    );
    const scheduleIds = schedules.map((schedule) => schedule.id);

    const [latestRunsByScheduleId, scheduleIdsWithRuns] = await Promise.all([
      this.getLatestRunsByScheduleId(scheduleIds),
      this.getScheduleIdsWithRuns(scheduleIds),
    ]);

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

    return schedules.map((schedule) => {
      const latestRunEntity = latestRunsByScheduleId.get(schedule.id) ?? null;
      const technicalVerdict = latestRunEntity?.analysisId
        ? (verdictsByAnalysisId.get(latestRunEntity.analysisId) ?? null)
        : null;

      return {
        scheduleId: schedule.id,
        fieldId: schedule.fieldId,
        fieldName: fieldNameById.get(schedule.fieldId) ?? null,
        enabled: schedule.enabled,
        frequency: schedule.frequency,
        nextRunAt: schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null,
        lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
        hasRuns: scheduleIdsWithRuns.has(schedule.id),
        latestRun: latestRunEntity
          ? this.toAdminScheduledAnalysisRun(latestRunEntity)
          : null,
        technicalVerdict,
        weeklyTechnicalVerdict: latestRunEntity
          ? (weeklyVerdictsByRunId.get(latestRunEntity.id) ?? null)
          : null,
      };
    });
  }

  /**
   * Admin PR 7: auditoría relacionada — reusa AuditLogService.list() tal cual (mismos filtros
   * targetType/targetId de ADMIN-2/PR2, sin duplicar lógica de query) y resuelve el email del
   * actor en UNA consulta batched (UsersService.findByIds), nunca un findById por fila. Ver
   * comentario en AdminUserDetailAuditLog (DTO) sobre por qué targetType='user' es la única
   * correlación honesta disponible hoy.
   */
  private async getAuditLogsForUser(
    userId: string,
    limit: number,
  ): Promise<AdminUserDetailAuditLog[]> {
    const { items } = await this.auditLogService.list({
      targetType: 'user',
      targetId: userId,
      page: 1,
      limit,
    });

    const actorIds = Array.from(
      new Set(
        items
          .map((log) => log.actorUserId)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const actors = await this.usersService.findByIds(actorIds);
    const emailByActorId = new Map(
      actors.map((actor) => [actor.id, actor.email]),
    );

    return items.map((log) => ({
      id: log.id,
      action: log.action,
      actorUserId: log.actorUserId,
      actorEmail: log.actorUserId
        ? (emailByActorId.get(log.actorUserId) ?? null)
        : null,
      targetType: log.targetType,
      targetId: log.targetId,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  async createUser(
    dto: CreateAdminUserDto,
    actor: AuditActorContext,
    actorRole: UserRole,
  ): Promise<PublicUser> {
    // SEC-001: ver assertCanGrantOwnerRole — antes de tocar nada más.
    this.assertCanGrantOwnerRole(actorRole, dto.role);

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
    actorRole: UserRole,
  ): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    // SEC-001: ver assertCanGrantOwnerRole. Solo se dispara cuando dto.role === OWNER — nunca
    // bloquea un cambio de role admin↔user, ni un update que no toca `role` en absoluto (incluido
    // sobre un target que ya es owner). No reemplaza ni se superpone con assertNotLastActiveOwner
    // (esa protege la degradación/desactivación del último owner activo; esta protege quién puede
    // OTORGAR owner).
    this.assertCanGrantOwnerRole(actorRole, dto.role);

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
   * MEASUREMENT GAP P1-06 ("Self-service frente a asistencia") — POST
   * /admin/users/:id/activation-assistance. Un owner/admin confirma explícitamente que el
   * equipo empezó a asistir materialmente a este usuario (nunca automático: no dispara esto
   * ningún otro flujo — crear la cuenta, crear una invitación, resetear password, revisar un
   * Analysis, ni P1-01 a P1-05). 404 genérico si el usuario no existe, mismo criterio que el
   * resto de las rutas `users/:id`.
   *
   * Set-once real en UsersService (ver ese método): esta capa solo decide SI auditar, no cómo
   * escribir. La auditoría se registra únicamente cuando `wasNewlySet` es true — una llamada
   * repetida sobre un usuario ya marcado responde éxito con el mismo timestamp, pero NUNCA
   * fabrica una segunda entrada de auditoría para la misma transición de negocio.
   */
  async markActivationAssistanceStarted(
    id: string,
    actor: AuditActorContext,
  ): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const { user, wasNewlySet } =
      await this.usersService.markActivationAssistanceStarted(id);

    if (wasNewlySet) {
      await this.auditLogService.record({
        actor,
        action: 'admin.user.activation_assistance_started',
        targetType: 'user',
        targetId: id,
        after: {
          activationAssistanceStartedAt: user.activationAssistanceStartedAt,
        },
      });
    }

    return this.usersService.toPublicUser(user);
  }

  /**
   * SEC-001: solo un actor con role `owner` puede OTORGAR el role `owner` — a otro usuario o a sí
   * mismo — desde cualquiera de los 4 endpoints que aceptan un `role` de destino (createUser,
   * updateUser, createInvitation, createUserFromAccessRequest). Antes de esta ficha, el guard de
   * clase de AdminController (@Roles(OWNER, ADMIN)) trataba ambos roles como equivalentes para
   * toda operación, y ningún DTO ni service comparaba el role *solicitado* contra el role del
   * actor: cualquier admin podía escalarse (o escalar a otro) a owner sin ninguna restricción.
   *
   * Deliberadamente NO toca ningún otro caso:
   * - `requestedRole` undefined (el caller no está tocando `role`) → no dispara nunca.
   * - `requestedRole` en {admin, user} → no dispara, sin importar el role del actor (admin sigue
   *   pudiendo asignar admin/user como hoy).
   * - degradar/desactivar a un owner existente → sigue gobernado exclusivamente por
   *   assertNotLastActiveOwner, sin relación con este chequeo.
   */
  private assertCanGrantOwnerRole(
    actorRole: UserRole,
    requestedRole: UserRole | undefined,
  ): void {
    if (requestedRole === UserRole.OWNER && actorRole !== UserRole.OWNER) {
      throw new ForbiddenException('Solo un owner puede otorgar el rol owner.');
    }
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
   * llegar acá (ver issueInvitation) — un fallo del envío SMTP nunca revierte la
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

  async createInvitation(
    dto: CreateInvitationDto,
    actor: AuditActorContext,
    actorRole: UserRole,
  ) {
    // SEC-001: ver assertCanGrantOwnerRole.
    this.assertCanGrantOwnerRole(actorRole, dto.role);

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
    actorRole: UserRole,
  ) {
    const accessRequest = await this.accessRequestRepository.findOne({
      where: { id },
    });

    if (!accessRequest) {
      throw new NotFoundException('Solicitud de acceso no encontrada.');
    }

    const role = dto.role ?? UserRole.USER;

    // SEC-001: ver assertCanGrantOwnerRole. `role` ya resuelve el default (USER) antes de esta
    // llamada, así que un dto.role ausente nunca dispara el chequeo.
    this.assertCanGrantOwnerRole(actorRole, role);

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

  /**
   * Admin PR 6: vista de detalle de UN campo — GET /admin/fields/:fieldId, solo lectura. Reusa
   * tal cual los helpers batched de PR5 (con fieldIds=[fieldId], mismo código, misma forma) más
   * dos consultas nuevas acotadas por LIMIT: historial de análisis del campo y últimas corridas
   * del schedule. Nunca duplica las reglas de analysisStatus/requiresAttention — mismos métodos
   * privados que usa listFields.
   */
  async getFieldDetail(fieldId: string): Promise<AdminFieldDetail> {
    const field = await this.fieldRepository.findOne({
      where: { id: fieldId },
      relations: { user: true },
    });

    if (!field) {
      throw new NotFoundException('Campo no encontrado.');
    }

    const [
      lotsCountByFieldId,
      latestAnalysisByFieldId,
      scheduleByFieldId,
      lots,
      analysisRows,
    ] = await Promise.all([
      this.countLotsByFieldId([fieldId]),
      this.getLatestAnalysisByFieldId([fieldId]),
      this.getSchedulesByFieldId([fieldId]),
      this.fieldLotRepository.find({
        where: { fieldId },
        order: { createdAt: 'DESC' },
      }),
      this.getAnalysesForField(fieldId, FIELD_DETAIL_ANALYSES_LIMIT),
    ]);

    const latestAnalysisRow = latestAnalysisByFieldId.get(fieldId) ?? null;
    const latestAnalysis: AdminFieldLatestAnalysis | null = latestAnalysisRow
      ? {
          id: latestAnalysisRow.id,
          status: latestAnalysisRow.status,
          createdAt: latestAnalysisRow.createdAt.toISOString(),
          completedAt: latestAnalysisRow.completedAt
            ? latestAnalysisRow.completedAt.toISOString()
            : null,
          durationMs: latestAnalysisRow.durationMs,
          score:
            latestAnalysisRow.status === 'Finalizado'
              ? latestAnalysisRow.globalScore
              : null,
        }
      : null;

    // Solo el análisis más reciente necesita su veredicto resuelto acá (el historial de
    // `analyses` no lo incluye, ver comentario en AdminFieldDetailAnalysisRow/DTO) — un solo id,
    // pero se reusa el mismo helper batched de siempre en vez de un find() aparte.
    const verdictsByAnalysisId = await this.getTechnicalVerdictsByAnalysisId(
      latestAnalysis ? [latestAnalysis.id] : [],
    );
    const technicalVerdict = latestAnalysis
      ? (verdictsByAnalysisId.get(latestAnalysis.id) ?? null)
      : null;

    const schedule = scheduleByFieldId.get(fieldId) ?? null;
    const scheduleIdsWithRuns = await this.getScheduleIdsWithRuns(
      schedule ? [schedule.id] : [],
    );
    const weeklyMonitoring: AdminFieldDetailWeeklyMonitoring = {
      active: schedule?.enabled ?? false,
      scheduleId: schedule?.id ?? null,
      frequency: schedule?.frequency ?? null,
      nextRunAt: schedule?.nextRunAt ? schedule.nextRunAt.toISOString() : null,
      lastRunAt: schedule?.lastRunAt ? schedule.lastRunAt.toISOString() : null,
      hasRuns: schedule ? scheduleIdsWithRuns.has(schedule.id) : false,
    };

    const scheduledRunRows = schedule
      ? await this.getRecentRunsForSchedule(
          schedule.id,
          FIELD_DETAIL_RUNS_LIMIT,
        )
      : [];
    const weeklyVerdictsByRunId =
      await this.weeklyTechnicalVerdictService.findResponsesByScheduledRunIds(
        scheduledRunRows.map((run) => run.id),
      );

    return {
      field: {
        id: field.id,
        name: field.name,
        ownerId: field.userId,
        ownerEmail: field.user?.email ?? null,
        ownerFullName: field.user?.fullName ?? null,
        lotsCount: lotsCountByFieldId.get(fieldId) ?? 0,
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
      },
      latestAnalysis,
      technicalVerdict,
      lots: lots.map((lot) => ({
        id: lot.id,
        name: lot.name,
        createdAt: lot.createdAt.toISOString(),
        updatedAt: lot.updatedAt.toISOString(),
      })),
      analyses: analysisRows.map((analysis) => ({
        id: analysis.id,
        status: analysis.status,
        createdAt: analysis.createdAt.toISOString(),
        completedAt: analysis.completedAt
          ? analysis.completedAt.toISOString()
          : null,
        durationMs: analysis.durationMs,
        score: analysis.status === 'Finalizado' ? analysis.globalScore : null,
        errorMessage: analysis.errorMessage,
        reviewedAt: analysis.reviewedAt
          ? analysis.reviewedAt.toISOString()
          : null,
        reviewedByUserId: analysis.reviewedByUserId,
      })),
      weeklyMonitoring,
      scheduledRuns: scheduledRunRows.map((run) => ({
        ...this.toAdminScheduledAnalysisRun(run),
        weeklyTechnicalVerdict: weeklyVerdictsByRunId.get(run.id) ?? null,
      })),
    };
  }

  // Admin PR 6: historial de análisis de UN campo (no solo el más reciente, a diferencia de
  // getLatestAnalysisByFieldId) — mismo criterio scope/lotId de siempre, queryBuilder simple (no
  // hace falta DISTINCT ON: es un solo campo, no una tanda).
  private async getAnalysesForField(
    fieldId: string,
    limit: number,
  ): Promise<Analysis[]> {
    return this.analysisRepository
      .createQueryBuilder('analysis')
      .where(
        `(analysis.scope = 'field' AND analysis."fieldId" = :fieldId) OR (analysis.scope IS NULL AND analysis."lotId" = :fieldId)`,
        { fieldId },
      )
      .orderBy('analysis.createdAt', 'DESC')
      .take(limit)
      .getMany();
  }

  // Admin PR 6: últimas `limit` corridas de un schedule — relations:['analysis'] para que
  // toAdminScheduledAnalysisRun pueda resolver analysisStatus sin una consulta aparte por fila
  // (mismo criterio que getLatestRunsByScheduleId, PR13B).
  private async getRecentRunsForSchedule(
    scheduleId: string,
    limit: number,
  ): Promise<ScheduledAnalysisRun[]> {
    return this.scheduledAnalysisRunRepository.find({
      where: { scheduleId },
      relations: { analysis: true },
      order: { createdAt: 'DESC' },
      take: limit,
    });
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

  /**
   * PR 17: retry manual y acotado del veredicto técnico de un Analysis ya 'Finalizado' — el caso
   * de uso es exactamente el de la mini-auditoría: un rechazo legítimo del guardrail de seguridad
   * (VerdictSafetyValidationError) no debe dejar el Analysis sin veredicto para siempre si un
   * admin quiere pedir una nueva generación.
   *
   * A diferencia de retryAnalysis (arriba), que solo deja constancia operativa sin ejecutar nada,
   * este método SÍ ejecuta una generación real — pero reutiliza tal cual
   * AnalysisVerdictService.generateAndPersist, el mismo código que ya usa el pipeline automático
   * (ver AnalysisService.processFieldAnalysisInBackground). Nunca reimplementa esa lógica acá:
   * - nunca vuelve a correr el worker/Earth Engine/scoring/zoning — parte del Analysis ya
   *   persistido, tal como está guardado;
   * - es idempotente por analysisId (find-then-merge, ver AnalysisVerdictService.saveVerdict) —
   *   no puede crear una segunda fila en analysis_technical_verdicts;
   * - si Claude vuelve a ser rechazado por el guardrail (o falla por cualquier otro motivo),
   *   generateAndPersist ya se encarga de persistir status='failed' con el contenido placeholder
   *   seguro de siempre — este método nunca fuerza ni maquilla un resultado.
   *
   * Guardas explícitas antes de invocar la generación: el Analysis debe existir y estar
   * 'Finalizado' (nunca 'Procesando' ni 'Error' — no hay nada que interpretar en ninguno de esos
   * dos casos). La autorización admin/owner ya la resuelve @UseGuards(JwtAuthGuard, RolesGuard) +
   * @Roles(...) a nivel de AdminController (ADMIN-1) — un producer nunca llega a este método.
   */
  async retryTechnicalVerdict(
    id: string,
    actor: AuditActorContext,
  ): Promise<AdminAnalysisTechnicalVerdict> {
    const analysis = await this.analysisRepository.findOne({ where: { id } });

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    if (analysis.status !== 'Finalizado') {
      throw new BadRequestException(
        'Solo se puede reintentar el veredicto técnico de análisis con status Finalizado.',
      );
    }

    const existing = await this.analysisVerdictRepository.findOne({
      where: { analysisId: id },
    });
    const before = existing
      ? {
          status: existing.status,
          generator: existing.generator,
          promptVersion: existing.promptVersion,
          errorMessage: existing.errorMessage,
        }
      : null;

    const verdict = await this.analysisVerdictService.generateAndPersist(
      analysis,
    );

    await this.auditLogService.record({
      actor,
      action: 'admin.analysis.technical_verdict_retry_requested',
      targetType: 'analysis_technical_verdict',
      targetId: id,
      before,
      after: {
        status: verdict.status,
        generator: verdict.generator,
        promptVersion: verdict.promptVersion,
        errorMessage: verdict.errorMessage,
      },
    });

    return toAdminAnalysisTechnicalVerdict(verdict);
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
