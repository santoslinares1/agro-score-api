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
import { ScheduledAnalysisRun } from '../../scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from '../../scheduled-analysis/entities/weekly-analysis-snapshot.entity';

/**
 * PR 16B: interpretación de la EVOLUCIÓN semanal (delta vs. el snapshot anterior), a diferencia
 * de AnalysisTechnicalVerdict (analysis-verdict/entities/analysis-technical-verdict.entity.ts),
 * que interpreta un Analysis puntual sin eje temporal. Son conceptos y tablas deliberadamente
 * separados (ver PR 16A, sección 7) — nunca se mezclan ni se reusa la tabla individual acá.
 *
 * Tipos duplicados a propósito en vez de importados desde analysis-verdict/entities (mismo
 * criterio que analysis-verdict-input.util.ts duplica extractNdmiMean en vez de importar de
 * scheduled-analysis: este módulo es hermano de analysis-verdict, no una dependencia suya).
 */
export type WeeklyVerdictStatus = 'generated' | 'failed';
export type WeeklyVerdictLabel =
  | 'favorable'
  | 'attention'
  | 'critical'
  | 'insufficient_data';
export type WeeklyVerdictTrend =
  | 'improving'
  | 'stable'
  | 'worsening'
  | 'mixed'
  | 'insufficient_data';
export type WeeklyVerdictConfidence = 'low' | 'medium' | 'high';

/**
 * unique(snapshotId): un diagnóstico semanal por WeeklyAnalysisSnapshot — el snapshot (no el
 * Analysis ni el ScheduledAnalysisRun) es la unidad natural "una semana comparada" (ver
 * unique(fieldId, weekStart, weekEnd) en WeeklyAnalysisSnapshot). `analysisId`/`scheduledRunId` se
 * denormalizan igual acá (mismo criterio que el propio WeeklyAnalysisSnapshot ya hace) solo para
 * trazabilidad/consulta directa, nunca como fuente de verdad — esa es siempre snapshotId.
 *
 * CASCADE en snapshotId (igual que AnalysisTechnicalVerdict.analysisId): este diagnóstico no
 * tiene ningún valor fuera del snapshot que interpreta. SET NULL en analysisId/scheduledRunId
 * (igual que WeeklyAnalysisSnapshot.analysisId/scheduledRunId): borrar el Analysis o el run
 * histórico no debe destruir el diagnóstico ya calculado.
 */
@Entity('weekly_technical_verdicts')
@Index('UQ_weekly_technical_verdicts_snapshot', ['snapshotId'], {
  unique: true,
})
export class WeeklyTechnicalVerdict {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  snapshotId: string;

  @ManyToOne(() => WeeklyAnalysisSnapshot, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'snapshotId' })
  snapshot?: WeeklyAnalysisSnapshot;

  @Column({ type: 'uuid', nullable: true })
  analysisId: string | null;

  @ManyToOne(() => Analysis, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'uuid', nullable: true })
  scheduledRunId: string | null;

  @ManyToOne(() => ScheduledAnalysisRun, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'scheduledRunId' })
  scheduledRun?: ScheduledAnalysisRun;

  @Column({ type: 'varchar' })
  status: WeeklyVerdictStatus;

  @Column({ type: 'varchar', nullable: true })
  verdict: WeeklyVerdictLabel | null;

  @Column({ type: 'varchar', nullable: true })
  trend: WeeklyVerdictTrend | null;

  @Column({ type: 'varchar', nullable: true })
  confidence: WeeklyVerdictConfidence | null;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  keyChanges: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  areasToReview: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  recommendations: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  limitations: string[] | null;

  /** Copiado de comparisonVsPrevious.previousSnapshotId al momento de generar — columna propia
   * (no solo dentro de inputSnapshot) para poder consultar/joinear directo sin parsear jsonb. */
  @Column({ type: 'uuid', nullable: true })
  previousSnapshotId: string | null;

  /** Snapshot del input efectivo que se usó para generar (mismo criterio que
   * AnalysisTechnicalVerdict.inputSnapshot) — para auditar sin recalcular contra
   * WeeklyAnalysisSnapshot, que puede evolucionar de forma entre versiones. */
  @Column({ type: 'jsonb', nullable: true })
  inputSnapshot: Record<string, unknown> | null;

  @Column({ type: 'varchar' })
  generator: string;

  @Column({ type: 'varchar', nullable: true })
  promptVersion: string | null;

  /** Mismo criterio que AnalysisTechnicalVerdict.errorMessage: mensaje resumido, nunca stack
   * trace completo. */
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  generatedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
