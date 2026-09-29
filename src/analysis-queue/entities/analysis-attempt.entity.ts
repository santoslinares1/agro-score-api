import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Analysis } from '../../analysis/entities/analysis.entity';

/**
 * - running: el consumidor reclamó el job y todavía no terminó (a lo sumo uno por Analysis).
 * - succeeded: este intento persistió el resultado y pasó el Analysis a Finalizado.
 * - superseded: el Worker respondió pero el Analysis ya era terminal — no se sobrescribió nada.
 * - failed_retryable: falla transitoria; pg-boss reintentará el job.
 * - failed_terminal: falla definitiva (no reintentable o intentos agotados); Analysis=Error.
 * - lease_lost: el intento quedó abandonado (runner caído/expirado) y otro lo reemplazó o cerró.
 */
export type AnalysisAttemptOutcome =
  | 'running'
  | 'succeeded'
  | 'superseded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'lease_lost';

/**
 * ADR-001: un intento de ejecución de un job analysis.execute.v1. `(jobId, attemptNumber)` es la
 * identidad del intento lógico (attemptNumber = retryCount de pg-boss + 1) y es única. El índice
 * parcial UQ_analysis_attempt_running_per_analysis impide dos intentos activos del mismo Analysis.
 * errorMessage es siempre el mensaje público sanitizado — nunca stack traces ni respuestas crudas.
 */
@Entity('analysis_attempt')
@Index('UQ_analysis_attempt_job_attempt', ['jobId', 'attemptNumber'], {
  unique: true,
})
@Index('IDX_analysis_attempt_analysis_started', ['analysisId', 'startedAt'])
export class AnalysisAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  analysisId: string;

  @ManyToOne(() => Analysis, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'uuid' })
  jobId: string;

  @Column({ type: 'int' })
  attemptNumber: number;

  @Column({ type: 'timestamp' })
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date | null;

  @Column({ type: 'varchar' })
  outcome: AnalysisAttemptOutcome;

  @Column({ type: 'varchar', nullable: true })
  errorCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  errorMessage: string | null;

  @Column({ type: 'boolean', nullable: true })
  retryable: boolean | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  /** Nullable: el contrato actual del Worker no expone versión (ADR-002 fuera de alcance). */
  @Column({ type: 'varchar', nullable: true })
  workerVersion: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
