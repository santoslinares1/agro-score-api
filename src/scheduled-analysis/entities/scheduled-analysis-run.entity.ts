import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Analysis } from '../../analysis/entities/analysis.entity';
import { Field } from '../../fields/entities/field.entity';
import { User } from '../../users/user.entity';
import { FieldAnalysisSchedule } from './field-analysis-schedule.entity';

export type ScheduledRunStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'email_sent';

/**
 * Una corrida puntual de un FieldAnalysisSchedule (disparada por el dispatcher automático o por
 * POST .../run-now). `scheduledFor` es la fecha (lunes, en la zona del schedule) a la que
 * pertenece la corrida — unique(scheduleId, scheduledFor) es la protección real contra
 * duplicados: no importa si el proceso se reinició o si el usuario tocó "Ejecutar ahora" el
 * mismo día que ya corrió el automático, nunca hay dos runs para la misma semana.
 */
@Entity('scheduled_analysis_runs')
@Index(['scheduleId'])
@Index(['fieldId'])
@Index(['userId'])
@Index(['analysisId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['startedAt'])
@Index(['scheduledFor'])
@Index('UQ_scheduled_analysis_runs_schedule_week', ['scheduleId', 'scheduledFor'], { unique: true })
export class ScheduledAnalysisRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  scheduleId: string;

  @ManyToOne(() => FieldAnalysisSchedule, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'scheduleId' })
  schedule?: FieldAnalysisSchedule;

  @Column({ type: 'uuid' })
  fieldId: string;

  @ManyToOne(() => Field, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'fieldId' })
  field?: Field;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  analysisId: string | null;

  @ManyToOne(() => Analysis, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'varchar', default: 'pending' })
  status: ScheduledRunStatus;

  @Column({ type: 'date' })
  scheduledFor: string;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  failedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  emailSentAt: Date | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
