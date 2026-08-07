import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/user.entity';

/**
 * ADMIN-2: ledger de acciones admin, append-only (no se edita ni se borra
 * desde ningún endpoint). `targetType`/`targetId` son polimórficos (pueden
 * apuntar a un user, access_request, analysis o invitation) así que no hay
 * FK posible ahí — sí hay FK real en `actorUserId` (ON DELETE SET NULL,
 * nunca debería dispararse en la práctica porque los usuarios no se borran
 * físicamente, pero es una garantía de integridad gratis). `before`/`after`
 * SIEMPRE pasan por AuditLogService.sanitize() antes de guardarse acá — ver
 * admin/audit-log.service.ts — nunca deben contener password/hash/token.
 */
@Entity('admin_audit_logs')
export class AdminAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  actorUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actorUser?: User;

  @Column()
  action: string;

  @Column()
  targetType: string;

  @Column({ type: 'varchar', nullable: true })
  targetId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', nullable: true })
  userAgent: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
