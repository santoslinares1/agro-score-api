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

  /**
   * MEASUREMENT GAP P1-06 ("Self-service frente a asistencia"): cuándo el equipo empezó a asistir
   * MATERIALMENTE a este usuario a completar el flujo de producto (configurar campo/lotes,
   * ejecutar el análisis, o llegar al primer resultado técnico utilizable) — ver
   * AdminService.markActivationAssistanceStarted / POST /admin/users/:id/activation-assistance.
   * Nunca se infiere: ni de `role`, ni de que la cuenta se haya creado desde Admin (el
   * provisioning de cuenta es obligatorio hoy, no asistencia), ni de emails, retries,
   * `ScheduledAnalysisRun.triggerSource` ni actividad general — solo lo fija esta acción
   * explícita de un owner/admin.
   *
   * Set-once: la primera marca fija el valor; cualquier llamada posterior (reutilización, retry,
   * concurrencia) lo conserva sin cambios — ver el UPDATE guardado por
   * `"activationAssistanceStartedAt" IS NULL` en UsersService.markActivationAssistanceStarted,
   * nunca un valor enviado por el cliente. `null` para todo usuario anterior a este rollout, y
   * también para todo usuario cuyo equipo simplemente no haya marcado la asistencia todavía —
   * ambos casos son indistinguibles a propósito: null NUNCA se interpreta automáticamente como
   * "self-service" sin aplicar el rollout gate (ver el ticket de origen), y la creación
   * administrativa de la cuenta/invitación NUNCA fija esta columna.
   */
  @Column({ type: 'timestamp', nullable: true })
  activationAssistanceStartedAt: Date | null;

  /**
   * KPI review — instrumentación (ticket 2/3, "Recurrencia real de usuario"): última vez que
   * este usuario completó un login exitoso — ver UsersService.recordLogin / AuthService.login.
   * A diferencia de `activationAssistanceStartedAt` (set-once), esta columna se SOBREESCRIBE en
   * cada login: importa la última vez, no la primera.
   *
   * Nunca se actualiza en un login fallido (password incorrecta, cuenta inactiva, email
   * inexistente), ni en ningún otro flujo (aceptar invitación, reset de password). Hoy no existe
   * endpoint de refresh de token (`JWT_EXPIRES_IN=7d`, ver `.env.example`, ni `AuthController`),
   * así que un usuario activo dentro de su misma sesión de hasta 7 días no vuelve a loguearse:
   * esta columna mide "última vez que inició sesión", no "última vez que usó la aplicación", y
   * por eso subestima recurrencia en ventanas menores a la duración de esa sesión.
   *
   * `null` para todo usuario existente antes de este rollout y para todo usuario que nunca inició
   * sesión desde entonces — no existe backfill posible (no había ningún registro de logins antes
   * de esta columna, en ningún repo). Deliberadamente excluida de `PublicUser` (ver ese tipo en
   * users.service.ts) y de cualquier respuesta HTTP: capturar el dato es el alcance de este
   * ticket, exponerlo es un ticket aparte.
   */
  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
