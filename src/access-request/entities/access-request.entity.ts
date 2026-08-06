import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { AccessRequestProfile } from '../access-request-profile.enum';
import { User } from '../../users/user.entity';

// ADMIN-2: se agregan 'interested' y 'converted' para el flujo operativo
// completo. Los valores viejos ('new'/'contacted'/'discarded') no cambian de
// significado — filas existentes siguen siendo válidas sin migración de datos.
export type AccessRequestStatus =
  | 'new'
  | 'contacted'
  | 'interested'
  | 'discarded'
  | 'converted';

/**
 * ADMIN-1: hasta esta ficha /access-request solo enviaba un email (ver
 * docs/audits/access-request-flow.md, sección "Deuda pendiente" — la
 * persistencia quedó fuera de alcance ahí a propósito). El panel admin
 * necesita poder listar solicitudes, así que se agrega esta tabla; el envío
 * de mail existente no cambia, esto es aditivo.
 */
@Entity('access_requests')
export class AccessRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  organization: string;

  @Column({ type: 'varchar' })
  profile: AccessRequestProfile;

  @Column({ nullable: true })
  estimatedSurface?: string;

  @Column({ nullable: true })
  message?: string;

  @Column({ type: 'varchar', default: 'new' })
  status: AccessRequestStatus;

  /**
   * ADMIN-2: notas internas del equipo (nunca se manda al solicitante, solo
   * visible en el panel admin).
   */
  @Column({ type: 'text', nullable: true })
  internalNotes: string | null;

  @Column({ type: 'uuid', nullable: true })
  assignedToUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'assignedToUserId' })
  assignedToUser?: User;

  @Column({ type: 'timestamp', nullable: true })
  contactedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  convertedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  discardedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
