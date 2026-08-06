import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../user.entity';

/**
 * ADMIN-2: a diferencia de UserInvitation/AdminAuditLog, acá `userId` sí
 * tiene FK con CASCADE — un reset token sin usuario dueño no tiene ningún
 * sentido (nunca pasa en la práctica, porque los usuarios no se borran
 * físicamente, pero si alguna vez pasara, el token debe desaparecer con él).
 */
@Entity('password_reset_tokens')
export class PasswordResetToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index({ unique: true })
  @Column()
  tokenHash: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  usedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
