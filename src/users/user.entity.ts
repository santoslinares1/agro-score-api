import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { UserRole } from './user-role.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @Column()
  fullName: string;

  @Column({ nullable: true })
  companyName?: string;

  /**
   * ADMIN-1: default cambió de 'owner' a 'user' (ver migración
   * AddUserRolesAndActive). 'owner' nunca tuvo efecto de autorización real
   * hasta esta ficha — era el default heredado del scaffold inicial y no
   * distinguía nada. No usar un `type: 'enum'` de Postgres acá: mismo
   * criterio que AnalysisStatus/NdviVariability (columna varchar simple,
   * tipado a nivel TS/DTO, sin CHECK constraint en DB).
   */
  @Column({ type: 'varchar', default: UserRole.USER })
  role: UserRole;

  /**
   * ADMIN-1: soft-delete para usuarios administrados desde el panel admin.
   * false = desactivado (no puede loguearse, ver JwtStrategy.validate).
   * Nunca se borra un User físicamente si tiene fields/analysis asociados.
   */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
