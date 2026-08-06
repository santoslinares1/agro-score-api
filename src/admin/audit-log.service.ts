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
  | 'admin.password_reset.created'
  | 'admin.analysis.retry_requested'
  | 'admin.analysis.marked_reviewed';

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
