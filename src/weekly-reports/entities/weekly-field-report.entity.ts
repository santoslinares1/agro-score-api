import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Field } from '../../fields/entities/field.entity';
import { User } from '../../users/user.entity';
import { WeeklyLotIndexObservation } from './weekly-lot-index-observation.entity';

export type WeeklyReportStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type WeeklyReportSource = 'manual' | 'scheduled' | 'backfill';

/**
 * Una corrida de seguimiento semanal para un campo (Fase 2 del handoff de adaptación del
 * notebook 004_reporte_semanal.ipynb). Vive fuera de Analysis.resultJson a propósito: es una
 * serie temporal que crece semana×índice×lote×campaña y se consulta por campo/lote/fecha/índice
 * — un uso muy distinto al de un resultJson de diagnóstico puntual.
 *
 * unique(fieldId, weekAnchorDate, methodologyVersion) WHERE status <> 'failed' (ver migración):
 * evita duplicar el mismo punto de la serie semanal sin importar quién/qué la disparó — el
 * `source` explícitamente NO forma parte de este unique, porque permitirlo duplicaría por diseño
 * el problema que week_anchor_date del worker existe para resolver (ver Cambio 4 del handoff de
 * Fase 1). Se excluyen los `failed` para no bloquear un reintento tras un error real.
 */
@Entity('weekly_field_reports')
@Index(['fieldId'])
@Index(['userId'])
@Index(['weekAnchorDate'])
@Index(['status'])
@Index(['fieldId', 'weekAnchorDate'])
@Index('UQ_weekly_field_reports_field_week_version', ['fieldId', 'weekAnchorDate', 'methodologyVersion'], {
  unique: true,
  where: `"status" <> 'failed'`,
})
export class WeeklyFieldReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fieldId: string;

  @ManyToOne(() => Field, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'fieldId' })
  field?: Field;

  /**
   * Quién disparó esta corrida manualmente. Nullable: source='scheduled'/'backfill' (no
   * implementados todavía, ver WeeklyReportSource) no tienen un usuario pidiéndola, y no se
   * inventa un "usuario sistema" para rellenar esto. La ownership de un reporte NUNCA se decide
   * por esta columna — siempre se resuelve vía field.userId en WeeklyReportsService, igual que
   * Analysis resuelve ownership por su Field y no por ninguna columna propia.
   */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'date' })
  campaignStart: string;

  @Column({ type: 'date', nullable: true })
  campaignEnd: string | null;

  @Column({ type: 'date' })
  targetDate: string;

  @Column({ type: 'date' })
  weekAnchorDate: string;

  @Column({ type: 'int', default: 7 })
  stepDays: number;

  @Column({ type: 'varchar', default: 'weekly-v1' })
  methodologyVersion: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: WeeklyReportStatus;

  @Column({ type: 'varchar', default: 'manual' })
  source: WeeklyReportSource;

  @Column({ type: 'boolean', default: false })
  includeNdreExperimental: boolean;

  @Column({ type: 'jsonb' })
  indices: string[];

  @Column({ type: 'jsonb', nullable: true })
  warnings: string[] | null;

  /** Mismo criterio que Analysis.errorMessage: resumen truncado, nunca el stack completo. */
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  failedAt: Date | null;

  @OneToMany(() => WeeklyLotIndexObservation, (observation) => observation.weeklyReport)
  observations: WeeklyLotIndexObservation[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
