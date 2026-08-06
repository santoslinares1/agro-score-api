import { WorkerResultJson } from 'src/python-worker/types';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/user.entity';

export type AnalysisStatus = 'Procesando' | 'Finalizado' | 'Error';
export type NdviVariability = 'Baja' | 'Media' | 'Alta';
export type AnalysisScope = 'lot' | 'field';

@Entity('analysis')
export class Analysis {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  lotId: string | null;

  @Column({ type: 'varchar', nullable: true })
  fieldId: string | null;

  /**
   * Distingue explícitamente un análisis de lote único de uno de campo
   * multi-lote. Nullable porque los análisis creados antes de este cambio
   * no lo tienen (ver fallback por lotId en AnalysisService.findByField y en
   * el guard de duplicados de runFieldAnalysis).
   */
  @Column({ type: 'varchar', nullable: true })
  scope: AnalysisScope | null;

  @Column()
  lotName: string;

  @Column({ default: 'Procesando' })
  status: AnalysisStatus;

  @Column({ type: 'int', default: 0 })
  globalScore: number;

  @Column({ default: 'Procesando análisis' })
  category: string;

  @Column({ type: 'int', default: 0 })
  confidenceScore: number;

  @Column({ type: 'int', default: 0 })
  productivityScore: number;

  @Column({ type: 'int', default: 0 })
  stabilityScore: number;

  @Column({ type: 'int', default: 0 })
  soilScore: number;

  @Column({ type: 'int', default: 0 })
  climateScore: number;

  @Column({ type: 'float', default: 0 })
  ndviAverageMax: number;

  @Column({ default: 'Media' })
  ndviVariability: NdviVariability;

  @Column({ type: 'int', default: 0 })
  zonesDetected: number;

  @Column({ type: 'int', default: 30 })
  maxCloudiness: number;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'jsonb', nullable: true })
  resultJson: WorkerResultJson | null;

  /**
   * ADMIN-1: timing/error para el panel admin. Nullable: los análisis
   * creados antes de esta migración no los tienen y eso es válido — no hay
   * backfill posible (no se guardaba el dato antes), así que se muestran
   * como null en vez de inventar un valor. `status` sigue siendo la fuente
   * de verdad ('Procesando'/'Finalizado'/'Error'); estas columnas son
   * metadata adicional, no un estado paralelo.
   */
  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  failedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  /**
   * Mensaje resumido y truncado (ver ANALYSIS_ERROR_MESSAGE_MAX_LENGTH en
   * analysis.service.ts) — nunca el stack trace completo ni datos sensibles.
   */
  @Column({ type: 'varchar', nullable: true })
  errorMessage: string | null;

  /**
   * ADMIN-2: operación sobre diagnósticos fallidos desde el panel admin.
   * `retryCount`/`lastRetriedAt` reflejan pedidos de reintento ("retry
   * requested") — ver comentario en AdminService.retryAnalysis: no
   * re-ejecutan el pipeline todavía, solo llevan la cuenta.
   */
  @Column({ type: 'timestamp', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reviewedByUserId' })
  reviewedByUser?: User;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastRetriedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
