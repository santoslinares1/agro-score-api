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

/**
 * PR 11A: 'pending' nunca se persiste todavía — este PR solo crea la fila una vez que el
 * análisis terminó de procesar (éxito o intento de generación fallido), nunca antes. El valor
 * queda en el tipo para que la respuesta pueda representar "en curso" de forma explícita el día
 * que un generador async (Claude real) necesite un estado intermedio real en vez de `null`.
 */
export type AnalysisVerdictStatus = 'pending' | 'generated' | 'failed';
export type AnalysisVerdictLabel =
  | 'favorable'
  | 'attention'
  | 'critical'
  | 'insufficient_data';
export type AnalysisVerdictConfidence = 'low' | 'medium' | 'high';

/**
 * PR 11A: veredicto técnico determinístico ("deterministic-v1") de un Analysis — sin Claude/IA
 * real todavía (ver AnalysisVerdictGenerator). Tabla separada (no columnas en `analysis`, que ya
 * es ancha y la tocan admin/report-pdf/scheduled-analysis) siguiendo el mismo molde que
 * WeeklyAnalysisSnapshot: FK a analysisId, generado solo al finalizar, nunca recalcula nada del
 * análisis en sí.
 *
 * unique(analysisId): un veredicto por análisis (no una tabla de historial de intentos). CASCADE
 * en vez de SET NULL (a diferencia de WeeklyAnalysisSnapshot): el veredicto no tiene ningún valor
 * fuera del análisis que interpreta, así que borrar el análisis borra su veredicto.
 */
@Entity('analysis_technical_verdicts')
@Index('UQ_analysis_technical_verdicts_analysis', ['analysisId'], {
  unique: true,
})
export class AnalysisTechnicalVerdict {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  analysisId: string;

  @ManyToOne(() => Analysis, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'varchar' })
  status: AnalysisVerdictStatus;

  @Column({ type: 'varchar', nullable: true })
  verdict: AnalysisVerdictLabel | null;

  @Column({ type: 'varchar', nullable: true })
  confidence: AnalysisVerdictConfidence | null;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  keyFindings: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  possibleCauses: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  recommendations: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  limitations: string[] | null;

  /**
   * Snapshot de las señales que se usaron para generar el veredicto (score, ndvi, ndmi, etc.) —
   * pensado para poder auditar/depurar por qué se llegó a un veredicto dado sin tener que
   * recalcular contra el resultJson del análisis, que puede cambiar de forma entre versiones del
   * worker.
   */
  @Column({ type: 'jsonb', nullable: true })
  inputSnapshot: Record<string, unknown> | null;

  @Column({ type: 'varchar' })
  generator: string;

  @Column({ type: 'varchar', nullable: true })
  promptVersion: string | null;

  /** Mismo criterio que Analysis.errorMessage: mensaje resumido, nunca stack trace completo. */
  @Column({ type: 'varchar', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamp', nullable: true })
  generatedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
