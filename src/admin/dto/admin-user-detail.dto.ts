import { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import { ScheduleFrequency } from '../../scheduled-analysis/entities/field-analysis-schedule.entity';
import { PublicUser } from '../../users/users.service';
import { WeeklyTechnicalVerdictResponse } from '../../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
import { AdminAnalysisTechnicalVerdict } from './admin-analysis-technical-verdict.dto';
import {
  AdminFieldAnalysisStatus,
  AdminFieldLatestAnalysis,
  AdminFieldWeeklyMonitoring,
} from './admin-field.dto';
import { AdminScheduledAnalysisRun } from './admin-scheduled-analysis.dto';

/**
 * Admin PR 7: vista de detalle de UN usuario — GET /admin/users/:userId, solo lectura. Mismo
 * patrón de composición que Field Detail (PR6): reusa los helpers batched de PR5/PR6/PR13B con
 * `userId` como criterio (en vez de `fieldIds=[fieldId]`), nunca una query por fila. Reusa
 * exactamente las mismas reglas de estado que Campos: deriveFieldAnalysisStatus /
 * fieldRequiresAttention, sin duplicar ni divergir.
 */
export const USER_DETAIL_FIELDS_LIMIT = 50;
export const USER_DETAIL_ANALYSES_LIMIT = 20;
export const USER_DETAIL_SCHEDULES_LIMIT = 50;
export const USER_DETAIL_AUDIT_LOGS_LIMIT = 20;

export type AdminUserDetailField = {
  id: string;
  name: string;
  lotsCount: number;
  createdAt: string;
  updatedAt: string;
  analysisStatus: AdminFieldAnalysisStatus;
  requiresAttention: boolean;
  latestAnalysis: AdminFieldLatestAnalysis | null;
  technicalVerdict: AdminAnalysisTechnicalVerdict | null;
  weeklyMonitoring: AdminFieldWeeklyMonitoring;
};

export type AdminUserDetailAnalysisRow = {
  id: string;
  fieldId: string | null;
  fieldName: string | null;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /** Mismo criterio que AdminFieldLatestAnalysis.score (PR5): solo cuando status='Finalizado'. */
  score: number | null;
  errorMessage: string | null;
  reviewedAt: string | null;
};

export type AdminUserDetailScheduledItem = {
  scheduleId: string;
  fieldId: string;
  fieldName: string | null;
  enabled: boolean;
  frequency: ScheduleFrequency;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Existencia REAL de ScheduledAnalysisRun (mismo criterio que hasRuns, PR3) — no lastRunAt. */
  hasRuns: boolean;
  latestRun: AdminScheduledAnalysisRun | null;
  technicalVerdict: AdminAnalysisTechnicalVerdict | null;
  weeklyTechnicalVerdict: WeeklyTechnicalVerdictResponse | null;
};

/**
 * Admin PR 7: única correlación de auditoría que se puede armar hoy sin inventar nada — eventos
 * con targetType='user' AND targetId=<userId> (admin.user.created/updated/deactivated/
 * role_changed, admin.password_reset.created/email_sent — ver AdminAuditAction en
 * audit-log.service.ts). Eventos de invitación/solicitud de acceso quedan afuera a propósito:
 * su targetId es el id de la invitación/solicitud, no el del usuario, y cruzarlos por email no
 * sería una correlación real (ver docs/admin-ux-notes.md).
 */
export type AdminUserDetailAuditLog = {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetType: string;
  targetId: string | null;
  createdAt: string;
};

export type AdminUserDetailSummary = {
  fieldsCount: number;
  lotsCount: number;
  analysesCount: number;
  completedAnalysesCount: number;
  failedAnalysesCount: number;
  fieldsWithoutAnalysisCount: number;
  fieldsRequiringAttentionCount: number;
  activeSchedulesCount: number;
  schedulesWithoutRunsCount: number;
  sentEmailsCount: number;
};

export type AdminUserDetail = {
  user: PublicUser;
  /** Cubre TODOS los campos/schedules/análisis del usuario — nunca solo los que se muestran en
   * los arrays de abajo (esos sí están acotados por los límites de más arriba). */
  summary: AdminUserDetailSummary;
  /** Hasta USER_DETAIL_FIELDS_LIMIT, orden DESC por createdAt. */
  fields: AdminUserDetailField[];
  /** Últimas USER_DETAIL_ANALYSES_LIMIT, orden DESC por createdAt, de cualquier campo del usuario. */
  recentAnalyses: AdminUserDetailAnalysisRow[];
  /** Hasta USER_DETAIL_SCHEDULES_LIMIT schedules de los campos del usuario, orden DESC. */
  scheduledAnalysis: AdminUserDetailScheduledItem[];
  /** Últimos USER_DETAIL_AUDIT_LOGS_LIMIT, orden DESC. Ver comentario en
   * AdminUserDetailAuditLog sobre qué correlación es honesta y cuál no. */
  recentAuditLogs: AdminUserDetailAuditLog[];
};
