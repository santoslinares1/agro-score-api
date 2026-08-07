import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AdminAuditLog } from './entities/admin-audit-log.entity';

// ADMIN-2: nombres de acciones auditadas — string union en vez de enum
// TypeORM (mismo criterio que AnalysisStatus): la columna es varchar simple,
// tipado a nivel TS, sin CHECK constraint en DB.
export type AdminAuditAction =
  | 'admin.user.created'
  | 'admin.user.updated'
  | 'admin.user.deactivated'
  | 'admin.user.role_changed'
  | 'admin.access_request.updated'
  | 'admin.access_request.converted'
  | 'admin.invitation.created'
  | 'admin.invitation.email_sent'
  | 'admin.password_reset.created'
  | 'admin.password_reset.email_sent'
  | 'admin.analysis.retry_requested'
  | 'admin.analysis.marked_reviewed'
  // ADMIN-3: acciones disparadas por el propio usuario final (no un admin)
  // desde endpoints públicos de /auth — mismo ledger, mismo AuditLogService
  // (ver src/audit-log/audit-log.module.ts sobre por qué se extrajo de
  // AdminModule). El "actor" en estos dos casos es el propio usuario que
  // acaba de crear su cuenta o resetear su password.
  | 'auth.invitation.accepted'
  | 'auth.password_reset.completed';

export type AuditActorContext = {
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type RecordAuditParams = {
  actor: AuditActorContext;
  action: AdminAuditAction;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
};

// ADMIN-3 (fix): shape estructuralmente compatible con
// ListAuditLogsQueryDto (src/admin/dto/list-audit-logs-query.dto.ts) sin
// importarlo — AuditLogModule no depende de AdminModule (ver comentario en
// audit-log.module.ts sobre por qué se extrajo).
export type ListAuditLogsParams = {
  page?: number;
  limit?: number;
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
};

export type PaginatedAuditLogs = {
  items: AdminAuditLog[];
  total: number;
  page: number;
  limit: number;
};

// Nunca debe llegar a `before`/`after` en el audit log, sin importar qué
// pase el caller — es una red de seguridad además de la disciplina de cada
// caller de armar objetos "limpios" a mano.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'accesstoken',
  'resettoken',
  'resetturl',
  'jwtsecret',
  'secret',
]);

@Injectable()
export class AuditLogService {
  constructor(
    @InjectRepository(AdminAuditLog)
    private readonly auditLogRepository: Repository<AdminAuditLog>,
  ) {}

  async record(params: RecordAuditParams): Promise<void> {
    const entry = this.auditLogRepository.create({
      actorUserId: params.actor.actorUserId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      before: this.sanitize(params.before),
      after: this.sanitize(params.after),
      ip: params.actor.ip ?? null,
      userAgent: params.actor.userAgent ?? null,
    });

    await this.auditLogRepository.save(entry);
  }

  /**
   * Movido desde AdminService.listAuditLogs (ADMIN-3 lo dejó inyectando
   * AdminAuditLogRepository directo, lo cual dejó de resolver una vez que
   * AdminModule dejó de registrar la entidad en su TypeOrmModule.forFeature
   * — el repositorio ahora vive únicamente acá). AdminService debe consumir
   * este método en vez de tener su propio acceso al repositorio.
   */
  async list(params: ListAuditLogsParams): Promise<PaginatedAuditLogs> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    const qb = this.auditLogRepository
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (params.actorUserId) {
      qb.andWhere('log."actorUserId" = :actorUserId', { actorUserId: params.actorUserId });
    }

    if (params.action) {
      qb.andWhere('log.action = :action', { action: params.action });
    }

    if (params.targetType) {
      qb.andWhere('log."targetType" = :targetType', { targetType: params.targetType });
    }

    if (params.targetId) {
      qb.andWhere('log."targetId" = :targetId', { targetId: params.targetId });
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total, page, limit };
  }

  /**
   * Recorre el objeto recursivamente y omite cualquier key que matchee
   * SENSITIVE_KEYS (case-insensitive). Devuelve null si no hay nada que
   * guardar, para no meter `{}` vacíos en la columna jsonb.
   */
  private sanitize(value: unknown): Record<string, unknown> | null {
    if (value === undefined || value === null) {
      return null;
    }

    const cleaned = this.deepOmitSensitive(value);

    return (cleaned as Record<string, unknown>) ?? null;
  }

  private deepOmitSensitive(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.deepOmitSensitive(item));
    }

    if (value instanceof Date) {
      return value;
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};

      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
          continue;
        }

        result[key] = this.deepOmitSensitive(val);
      }

      return result;
    }

    return value;
  }
}
