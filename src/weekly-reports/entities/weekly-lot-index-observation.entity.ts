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

import { Field } from '../../fields/entities/field.entity';
import { FieldLot } from '../../fields/entities/field-lot.entity';
import { WeeklyFieldReport } from './weekly-field-report.entity';

export type WeeklyDeltaDirection = 'up' | 'down' | 'stable';

/**
 * Una observación (lote × índice × semana) dentro de un WeeklyFieldReport. `fieldId` está
 * denormalizado (ya vive en weeklyReport.fieldId) a propósito: GET .../weekly-observations arma
 * series temporales por campo sin tener que joinear contra weekly_field_reports en cada query.
 *
 * `lotId` es SET NULL (no CASCADE) al borrar el FieldLot: mismo criterio que
 * FieldsService.removeLot documenta para Analysis — borrar un lote no debe destruir historial ya
 * calculado, `lotName` conserva el nombre que tenía el lote al momento de la observación.
 */
@Entity('weekly_lot_index_observations')
@Index(['weeklyReportId'])
@Index(['fieldId'])
@Index(['lotId'])
@Index(['index'])
@Index(['weekAnchorDate'])
@Index(['fieldId', 'index', 'weekAnchorDate'])
@Index(['lotId', 'index', 'weekAnchorDate'])
export class WeeklyLotIndexObservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  weeklyReportId: string;

  @ManyToOne(() => WeeklyFieldReport, (report) => report.observations, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'weeklyReportId' })
  weeklyReport?: WeeklyFieldReport;

  @Column({ type: 'uuid' })
  fieldId: string;

  @ManyToOne(() => Field, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'fieldId' })
  field?: Field;

  @Column({ type: 'uuid', nullable: true })
  lotId: string | null;

  @ManyToOne(() => FieldLot, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'lotId' })
  lot?: FieldLot;

  @Column({ type: 'varchar', nullable: true })
  lotName: string | null;

  /** 'NDVI' | 'NDMI' | 'NDRE' (validado en el DTO, no a nivel columna — mismo criterio que
   * Analysis.status/scope: unión de TS + varchar, sin CREATE TYPE en Postgres). */
  @Column({ type: 'varchar' })
  index: string;

  /** NDRE-como-experimental (ver reglas de negocio): nunca se vende como índice estable. */
  @Column({ type: 'boolean', default: false })
  experimental: boolean;

  @Column({ type: 'boolean' })
  available: boolean;

  @Column({ type: 'date' })
  weekAnchorDate: string;

  @Column({ type: 'date', nullable: true })
  imageDate: string | null;

  @Column({ type: 'numeric', nullable: true })
  cloudPct: number | null;

  @Column({ type: 'numeric', nullable: true })
  scaleM: number | null;

  @Column({ type: 'numeric', nullable: true })
  mean: number | null;

  @Column({ type: 'numeric', nullable: true })
  stdDev: number | null;

  @Column({ type: 'numeric', nullable: true })
  min: number | null;

  @Column({ type: 'numeric', nullable: true })
  max: number | null;

  @Column({ type: 'int', nullable: true })
  validPixelCount: number | null;

  /**
   * Si el worker manda deltaVsPrevious no nulo, se persiste tal cual. Si no (el caso normal en
   * esta fase — ver weekly.py de agro-score-worker: solo calcula delta si se le pasa
   * previous_observations a mano, y el spike no lo hace), el backend lo calcula contra la
   * observación anterior real ya persistida para el mismo fieldId+lotId+index (ver
   * WeeklyReportsService.resolveDelta / weekly-delta.util.ts).
   */
  @Column({ type: 'numeric', nullable: true })
  deltaVsPrevious: number | null;

  @Column({ type: 'varchar', nullable: true })
  deltaDirection: WeeklyDeltaDirection | null;

  /** Motivo de available=false (nubosidad, sin píxeles válidos, error de Earth Engine, etc.). */
  @Column({ type: 'text', nullable: true })
  unavailableReason: string | null;

  /** Notas adicionales del worker (search.notes / warnings puntuales) sin columna propia. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
