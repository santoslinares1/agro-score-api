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
import { DEFAULT_SCHEDULE_TIMEZONE } from '../schedule-time.util';

export type ScheduleFrequency = 'weekly';
export type ScheduleAnalysisScope = 'field';
export type ScheduleLastStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Fase 4A: seguimiento semanal automático del análisis ACTUAL (el mismo pipeline manual de
 * siempre — mismo resultJson, mismo PDF), NO la feature paralela `weekly-reports` (índices
 * NDVI/NDMI/NDRE con delta por lote, congelada aparte). Un campo tiene a lo sumo un schedule
 * (unique(fieldId)) — activar/desactivar es upsert sobre esa única fila, no crear otra.
 */
@Entity('field_analysis_schedules')
@Index(['userId'])
@Index(['enabled'])
@Index(['nextRunAt'])
@Index('UQ_field_analysis_schedules_field', ['fieldId'], { unique: true })
export class FieldAnalysisSchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  fieldId: string;

  @ManyToOne(() => Field, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'fieldId' })
  field?: Field;

  /** Dueño del campo al momento de configurar el schedule — el runner lo usa para llamar a
   * AnalysisService.runFieldAnalysis (que requiere un userId) sin depender de un request real. */
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', default: 'weekly' })
  frequency: ScheduleFrequency;

  @Column({ type: 'int', default: 1 })
  dayOfWeek: number;

  @Column({ type: 'int', default: 9 })
  hour: number;

  @Column({ type: 'int', default: 0 })
  minute: number;

  @Column({ type: 'varchar', default: DEFAULT_SCHEDULE_TIMEZONE })
  timezone: string;

  @Column({ type: 'varchar', default: 'field' })
  analysisScope: ScheduleAnalysisScope;

  /**
   * Flags del "informe visual completo" (mismo modo que field-detail.component.ts ofrece al
   * usuario). Fase 4D (decisión de producto): la ejecución real del análisis semanal por email
   * ahora FUERZA estos tres a `true` en ScheduledAnalysisRunnerService.triggerRun, sin importar
   * lo que estas columnas guarden — quedan por compatibilidad futura (si algún día se vuelve a
   * permitir un modo liviano configurable), no porque hoy controlen algo.
   */
  @Column({ type: 'boolean', default: true })
  includeMapAssets: boolean;

  @Column({ type: 'boolean', default: true })
  includeIndexImages: boolean;

  @Column({ type: 'boolean', default: true })
  includeImageSeries: boolean;

  @Column({ type: 'uuid', nullable: true })
  lastAnalysisId: string | null;

  @ManyToOne(() => Analysis, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'lastAnalysisId' })
  lastAnalysis?: Analysis;

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  nextRunAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastStatus: ScheduleLastStatus | null;

  @Column({ type: 'text', nullable: true })
  lastErrorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
