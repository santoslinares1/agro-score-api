import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Field } from '../../fields/entities/field.entity';
import { User } from '../../users/user.entity';
import { FieldAnalysisSchedule } from './field-analysis-schedule.entity';

/**
 * Taxonomía MÍNIMA de writers confirmados de `FieldAnalysisSchedule.enabled` (ver auditoría de
 * KPIs, gap P0 "denominador histórico de campos esperados"):
 * - 'schedule_upsert': el único writer real de `enabled` hoy —
 *   FieldAnalysisScheduleService.upsert, usado por el flujo autenticado de configuración
 *   (PUT /fields/:fieldId/analysis-schedule). Cubre tanto la fila inicial de un schedule nuevo
 *   como cada transición real posterior. ScheduledAnalysisRunnerService y AdminService leen
 *   `enabled` pero nunca lo escriben — no son writers, no tienen su propia fuente acá.
 * - 'migration_baseline': fila sintética que la migración de rollout inserta UNA vez por cada
 *   schedule preexistente, nunca una transición real — ver el docstring de la migración.
 * No agregar valores hipotéticos: cualquier writer nuevo de `enabled` debe agregar su propia
 * fuente acá EN EL MISMO cambio que lo introduce, nunca antes.
 */
export type FieldAnalysisScheduleTransitionSource = 'schedule_upsert' | 'migration_baseline';

/**
 * Historial append-only de las transiciones de `FieldAnalysisSchedule.enabled`. `enabled` en sí
 * vive en una única fila mutable por campo (unique(fieldId), ver field-analysis-schedule.entity.ts)
 * — reactivar/desactivar el seguimiento semanal siempre fue un UPDATE sobre esa misma fila, así
 * que los ciclos anteriores de habilitación/deshabilitación desaparecían sin dejar rastro. Esta
 * tabla es la única fuente que permite reconstruir, para una semana pasada, qué campos estaban
 * configurados para recibir monitoreo — sin inferirlo del `enabled`/`updatedAt` actuales (que solo
 * describen el presente, y `updatedAt` además cambia por edición de horario/flags sin que
 * `enabled` haya cambiado).
 *
 * `scheduleId` + `fieldId` quedan ambos, denormalizados: `scheduleId` es la referencia natural
 * (mismo patrón que ScheduledAnalysisRun), `fieldId` evita un join para las lecturas históricas
 * por campo, que es el caso de uso principal (reconstruir el denominador de "campos esperados").
 * Ambas FK son ON DELETE CASCADE hacia field_analysis_schedules/fields, respectivamente — si algún
 * día se borra un Field (hoy no ocurre; ver fields.service.ts), su schedule cascadea y este
 * historial cascadea con él, nunca queda huérfano.
 *
 * Invariante (ver FieldAnalysisScheduleService.upsert, único writer):
 *   1 fila inicial desde el comienzo de cobertura de ESE schedule (creación real o baseline de
 *   migración) + exactamente 1 fila por transición real de `enabled` + 0 filas por updates que
 *   preservan el mismo `enabled`. La fila y la actualización de FieldAnalysisSchedule se escriben
 *   en la MISMA transacción — nunca puede quedar una sin la otra.
 *
 * Estado efectivo en un instante `t` (para `t` >= la baseline de rollout): la fila de este
 * schedule con el `effectiveAt` más reciente que sea <= `t`. Antes de la baseline, el estado
 * histórico es desconocido a propósito — esta tabla nunca fabrica transiciones previas al rollout.
 */
@Entity('field_analysis_schedule_status_transitions')
@Index(['scheduleId'])
@Index(['fieldId'])
@Index(['effectiveAt'])
@Index(['scheduleId', 'effectiveAt'])
export class FieldAnalysisScheduleStatusTransition {
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

  @Column({ type: 'boolean' })
  enabled: boolean;

  /** Momento en que este estado pasó a regir — NUNCA `FieldAnalysisSchedule.updatedAt` (que
   * también cambia por edición de horario/flags sin transición real) ni `createdAt` del schedule
   * (que asumiría, sin evidencia, que el estado actual rigió desde la creación). Para
   * 'schedule_upsert' es el momento del write; para 'migration_baseline' es el momento del
   * rollout, nunca el `createdAt` original del schedule. */
  @Column({ type: 'timestamp' })
  effectiveAt: Date;

  @Column({ type: 'varchar' })
  source: FieldAnalysisScheduleTransitionSource;

  /** Usuario autenticado que disparó el write (req.user.sub en el PUT de configuración). `null`
   * para 'migration_baseline' — no hay actor humano detrás de una fila sintética de rollout, y
   * atribuirla a alguien sería fabricar historia que esta migración explícitamente evita. */
  @Column({ type: 'uuid', nullable: true })
  actorUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actorUserId' })
  actorUser?: User | null;

  /** Metadata de auditoría de la fila en sí (cuándo se insertó) — distinta de `effectiveAt` (el
   * instante que la fila describe). En la práctica casi siempre coinciden para 'schedule_upsert',
   * pero conceptualmente son cosas distintas y no deben fusionarse. */
  @CreateDateColumn()
  createdAt: Date;
}
