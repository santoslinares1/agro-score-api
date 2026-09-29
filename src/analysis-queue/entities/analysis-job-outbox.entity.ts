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
import type { AnalysisExecuteJobPayload } from '../analysis-job.contract';

/**
 * ADR-001: intención durable de ejecución de un Analysis. Se inserta en la MISMA transacción que
 * crea el Analysis (Queued) — así nunca existe un Analysis encolado sin su intención de ejecución
 * (dual-write). El dispatcher del job runner la publica en pg-boss y recién entonces marca
 * `dispatchedAt` (+ `jobId`). Solo IDs y metadata de entrega: nunca GeoJSON ni resultJson.
 */
@Entity('analysis_job_outbox')
@Index('UQ_analysis_job_outbox_analysis_job_type', ['analysisId', 'jobType'], {
  unique: true,
})
export class AnalysisJobOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  analysisId: string;

  @ManyToOne(() => Analysis, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'analysisId' })
  analysis?: Analysis;

  @Column({ type: 'varchar' })
  jobType: string;

  @Column({ type: 'int' })
  payloadVersion: number;

  @Column({ type: 'jsonb' })
  payload: AnalysisExecuteJobPayload;

  @CreateDateColumn()
  createdAt: Date;

  /** Seteado SOLO después de que pg-boss confirmó la publicación del job. */
  @Column({ type: 'timestamp', nullable: true })
  dispatchedAt: Date | null;

  /** Id del job en pg-boss (determinista: igual a `id` de esta fila). */
  @Column({ type: 'uuid', nullable: true })
  jobId: string | null;

  @Column({ type: 'int', default: 0 })
  dispatchAttempts: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastDispatchError: string | null;

  /** Último reclamo por un dispatcher (informativo; la exclusión real es FOR UPDATE SKIP LOCKED). */
  @Column({ type: 'timestamp', nullable: true })
  lockedAt: Date | null;

  /** Fila que nunca se publicará (versión de payload desconocida) — el Analysis pasa a Error. */
  @Column({ type: 'timestamp', nullable: true })
  abandonedAt: Date | null;
}
