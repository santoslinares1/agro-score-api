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
import { ScheduledAnalysisRun } from './scheduled-analysis-run.entity';

export type WeeklyAnalysisSnapshotSource = 'scheduled_analysis';
export type WeeklySnapshotDataQuality = 'sufficient' | 'partial' | 'insufficient';

/**
 * Fase 5: resumen comparable semana-a-semana de un análisis automático de scheduled-analysis —
 * distinto de `weekly-reports` (weekly_field_reports / weekly_lot_index_observations), que es
 * una serie temporal por lote×índice de OTRO pipeline del worker (runWeeklyReport), con su propia
 * metodología y sin relación con Analysis.resultJson. Un snapshot acá se deriva SIEMPRE del mismo
 * Analysis que ya generó el informe completo (mismo resultJson, mismo PDF) — nunca dispara un
 * cálculo nuevo, solo extrae y compara lo que ese resultJson ya trae.
 *
 * unique(fieldId, weekStart, weekEnd): un snapshot por campo y ventana semanal — protege contra
 * que dos ticks del reconciler que se solapan (ver ScheduledAnalysisRunnerService.reconcileRun)
 * creen dos snapshots para la misma semana.
 */
@Entity('weekly_analysis_snapshots')
@Index(['fieldId'])
@Index(['userId'])
@Index(['analysisId'])
@Index(['scheduledRunId'])
@Index(['weekStart'])
@Index(['weekEnd'])
@Index('UQ_weekly_analysis_snapshots_field_week', ['fieldId', 'weekStart', 'weekEnd'], { unique: true })
export class WeeklyAnalysisSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  /** SET NULL (no CASCADE): borrar el Analysis histórico no debe destruir el snapshot ya
   * calculado — mismo criterio que FieldAnalysisSchedule.lastAnalysisId. */
  @Column({ type: 'uuid', nullable: true })
  analysisId: string | null;

  @ManyToOne(() => Analysis, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'uuid', nullable: true })
  scheduledRunId: string | null;

  @ManyToOne(() => ScheduledAnalysisRun, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'scheduledRunId' })
  scheduledRun?: ScheduledAnalysisRun;

  /** Igual que Analysis.startDate/endDate de la misma corrida — la ventana semanal real que se
   * analizó (Fase 4D-fix: 7 días), no una fecha de "cuándo se generó" el snapshot. */
  @Column({ type: 'date' })
  weekStart: string;

  @Column({ type: 'date' })
  weekEnd: string;

  @Column({ type: 'varchar', default: 'scheduled_analysis' })
  source: WeeklyAnalysisSnapshotSource;

  @Column({ type: 'int', nullable: true })
  score: number | null;

  @Column({ type: 'varchar', nullable: true })
  scoreLabel: string | null;

  @Column({ type: 'float', nullable: true })
  analyzedAreaHa: number | null;

  @Column({ type: 'int', nullable: true })
  lotCount: number | null;

  @Column({ type: 'varchar', nullable: true })
  dominantZone: string | null;

  @Column({ type: 'float', nullable: true })
  dominantZonePercentage: number | null;

  @Column({ type: 'float', nullable: true })
  ndviMean: number | null;

  @Column({ type: 'float', nullable: true })
  ndmiMean: number | null;

  @Column({ type: 'boolean', default: false })
  hasRgbImage: boolean;

  @Column({ type: 'boolean', default: false })
  hasNdviImage: boolean;

  @Column({ type: 'boolean', default: false })
  hasNdmiImage: boolean;

  @Column({ type: 'boolean', default: false })
  hasImageSeries: boolean;

  @Column({ type: 'boolean', default: false })
  hasEnoughData: boolean;

  @Column({ type: 'varchar', default: 'insufficient' })
  dataQualityStatus: WeeklySnapshotDataQuality;

  /** Nota honesta de qué faltó (ej. "Esta semana no hubo imagen RGB válida."), o null si no hubo
   * ninguna limitación relevante — nunca inventa una limitación que no exista. */
  @Column({ type: 'text', nullable: true })
  limitations: string | null;

  @Column({ type: 'jsonb', nullable: true })
  comparisonVsPrevious: Record<string, unknown> | null;

  /** Bolsa jsonb para métricas adicionales que no ameritan columna propia todavía (ej. desglose
   * de zonas completo) — las columnas de arriba son la fuente de verdad para email/UI/comparación. */
  @Column({ type: 'jsonb', nullable: true })
  metrics: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
