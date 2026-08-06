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

import { User } from '../user.entity';
import { UserRole } from '../user-role.enum';

/**
 * ADMIN-2: invitación de alta de usuario. Solo se persiste `tokenHash` (ver
 * src/auth/token.util.ts) — el token crudo nunca toca la DB. `email` no es
 * único a nivel DB a propósito: pueden existir invitaciones viejas
 * vencidas/no usadas para el mismo email sin romper nada; la unicidad real
 * (no duplicar usuarios) se valida contra la tabla `users` al crear la
 * invitación y de nuevo al aceptarla.
 */
@Entity('user_invitations')
export class UserInvitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  email: string;

  @Column({ type: 'varchar' })
  role: UserRole;

  @Column({ type: 'uuid', nullable: true })
  invitedByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invitedByUserId' })
  invitedByUser?: User;

  @Index({ unique: true })
  @Column()
  tokenHash: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
