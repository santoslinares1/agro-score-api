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

  /**
   * PROFILE-SEC-1: contador de invalidación de JWT. Se incrementa al cambiar
   * la password (changePassword/resetPassword) o al pedir "cerrar otras
   * sesiones" (revokeOtherSessions). JwtStrategy compara este valor contra
   * el que trae el token (payload.tokenVersion ?? 0 para tokens emitidos
   * antes de esta ficha) — un mismatch rechaza el request aunque el JWT no
   * haya expirado. No hay tabla de sesiones: AgroScore es JWT stateless sin
   * revocación server-side (ver 15-auth-access-and-roles.md), así que este
   * contador es el cambio mínimo compatible con esa arquitectura — mismo
   * principio que `isActive`, que ya revalida en cada request.
   */
  @Column({ type: 'int', default: 0 })
  tokenVersion: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
