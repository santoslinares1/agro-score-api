import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { UserRole } from '../users/user-role.enum';
import { PublicUser, UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { hashToken } from './token.util';

const SALT_ROUNDS = 10;

export type AuthResponse = {
  user: PublicUser;
  accessToken: string;
};

// ADMIN-3: metadata de request para auditoría — mismo shape reducido que
// AdminController.buildActorContext, pero acá no hay `actorUserId` de
// antemano (son endpoints públicos): cada método arma el actor real (el
// usuario que se acaba de crear / que resetea su propio password) una vez
// que lo tiene.
export type RequestAuditMeta = {
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    @InjectRepository(UserInvitation)
    private readonly invitationRepository: Repository<UserInvitation>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetRepository: Repository<PasswordResetToken>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // SEC-002 (AUTH-POLICY-1): no hay método `register()` — el registro público
  // fue eliminado a nivel de ruta y de servicio (ver AuthController). El alta
  // de un usuario nuevo pasa por `acceptInvitation` (más abajo) o por
  // `UsersService.create` invocado desde AdminService.
  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = this.normalizeEmail(dto.email);

    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    // PROFILE-SEC-1: cierra RISK-conocido "Inactive login" de
    // 15-auth-access-and-roles.md — antes de esta ficha, un usuario
    // desactivado (por admin o por deactivateAccount propio) recibía un JWT
    // igual, que quedaba inerte recién en el primer request protegido
    // (JwtStrategy). Mismo mensaje genérico que credenciales inválidas —
    // no reveal si el email pertenece a una cuenta desactivada.
    if (!user.isActive) {
      throw new UnauthorizedException('Credenciales inválidas.');
    }

    // KPI review — instrumentación (ticket 2/3, "Recurrencia real de usuario"): recién acá, con
    // credenciales e isActive ya validados — nunca antes, para no registrar un intento fallido
    // como si fuera un login real. recordLogin nunca lanza (ver UsersService.recordLogin), así
    // que esto no puede convertir un login legítimo en un error.
    await this.usersService.recordLogin(user.id);

    return this.buildAuthResponse(user);
  }

  /**
   * ADMIN-2: consume una UserInvitation creada desde el panel admin
   * (POST /admin/invitations o /admin/access-requests/:id/create-user).
   * Busca por hash del token recibido (nunca se guardó el token crudo, así
   * que no hay otra forma de encontrarla) — no vencida, no aceptada todavía.
   * Mensaje de error genérico en los tres casos (no existe / vencida /
   * usada) para no darle a un atacante información sobre cuál es el motivo.
   */
  async acceptInvitation(
    dto: AcceptInvitationDto,
    requestMeta: RequestAuditMeta = {},
  ): Promise<AuthResponse> {
    const tokenHash = hashToken(dto.token);

    const invitation = await this.invitationRepository.findOne({
      where: { tokenHash, acceptedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });

    if (!invitation) {
      throw new BadRequestException('La invitación no es válida o ya expiró.');
    }

    const existing = await this.usersService.findByEmail(invitation.email);

    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese email.');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const user = await this.usersService.create({
      email: invitation.email,
      passwordHash,
      fullName: dto.fullName.trim(),
      role: invitation.role,
      isActive: true,
    });

    invitation.acceptedAt = new Date();
    await this.invitationRepository.save(invitation);

    // ADMIN-3: el "actor" es el propio usuario recién creado — no hay un
    // admin detrás de este endpoint público.
    await this.auditLogService.record({
      actor: { actorUserId: user.id, ip: requestMeta.ip, userAgent: requestMeta.userAgent },
      action: 'auth.invitation.accepted',
      targetType: 'invitation',
      targetId: invitation.id,
      after: { email: user.email, role: user.role },
    });

    return this.buildAuthResponse(user);
  }

  /**
   * ADMIN-3: consume un PasswordResetToken creado desde el panel admin
   * (POST /admin/users/:id/password-reset). Mismo patrón que
   * acceptInvitation: busca por hash, no vencido, no usado; mensaje de
   * error genérico en los tres casos para no filtrar información. A
   * diferencia de acceptInvitation, no hace login automático (ver
   * docs/admin-backend.md) — el frontend redirige a /login después de un
   * reset exitoso.
   *
   * F03 (fix de atomicidad): antes, el consumo del token (`usedAt`) y el cambio de credenciales
   * (`UsersService.updatePassword`, que a su vez cambia `passwordHash` e incrementa
   * `tokenVersion`) eran dos escrituras independientes, cada una en su propia transacción
   * implícita — sin nada que impidiera que dos requests concurrentes con el MISMO token pasaran
   * ambas el chequeo `usedAt IS NULL` (leído antes de que cualquiera escribiera nada) y las dos
   * terminaran cambiando la contraseña, incrementando `tokenVersion` dos veces. Ahora las dos
   * escrituras viven en la MISMA transacción, con el `SELECT` del token bajo
   * `lock: 'pessimistic_write'` (`SELECT ... FOR UPDATE`): la segunda transacción que intenta
   * tomar la fila queda bloqueada hasta que la primera confirme o revierta — y si la primera
   * confirmó, la segunda vuelve a evaluar el `WHERE` (`usedAt IS NULL`) contra la fila ya
   * actualizada y no la encuentra, sin necesitar ningún chequeo extra en el código.
   *
   * `bcrypt.hash` es CPU-bound (~50-100ms con SALT_ROUNDS=10) — se calcula ANTES de abrir la
   * transacción (y por lo tanto antes de tomar el lock de fila), para no retener ese lock más de
   * lo estrictamente necesario: dos requests para el MISMO token deben serializarse (es la carrera
   * real que se está cerrando), pero solo por el tiempo de un puñado de sentencias SQL, no por el
   * costo del hash. El chequeo inicial (no transaccional) sigue existiendo como antes, como
   * fast-path: evita pagar el costo de bcrypt para el caso común de un token ya inválido/vencido
   * de entrada — no es la garantía real (esa la da el lock dentro de la transacción), solo una
   * optimización que preserva el comportamiento previo a esta ficha.
   */
  async resetPassword(
    dto: ResetPasswordDto,
    requestMeta: RequestAuditMeta = {},
  ): Promise<{ message: string }> {
    const tokenHash = hashToken(dto.token);
    const invalidTokenMessage =
      'El link de recuperación no es válido o ya expiró.';

    const tokenLooksValid = await this.passwordResetRepository.findOne({
      where: { tokenHash, usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });

    if (!tokenLooksValid) {
      throw new BadRequestException(invalidTokenMessage);
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const consumedUserId = await this.dataSource.transaction(
      async (manager): Promise<string> => {
        const resetToken = await manager
          .getRepository(PasswordResetToken)
          .findOne({
            where: {
              tokenHash,
              usedAt: IsNull(),
              expiresAt: MoreThan(new Date()),
            },
            lock: { mode: 'pessimistic_write' },
          });

        if (!resetToken) {
          // Ganó otra transacción concurrente (ya consumió el token y confirmó antes de que esta
          // pudiera tomar el lock), o el token expiró/no existe. Mismo mensaje genérico en ambos
          // casos — no le da a un atacante información sobre cuál de los dos pasó. Lanzar acá
          // adentro revierte la transacción completa: ninguna escritura de este intento llega a
          // aplicarse.
          throw new BadRequestException(invalidTokenMessage);
        }

        resetToken.usedAt = new Date();
        await manager.getRepository(PasswordResetToken).save(resetToken);

        // F03: `updateResult.affected === 0` significa que `resetToken.userId` no matchea ningún
        // User — no debería ser alcanzable en la práctica (password_reset_tokens.userId es FK NOT
        // NULL con onDelete CASCADE hacia users, ver la entidad y la migración
        // 1786026385139-CreatePasswordResetTokens: si el usuario se borrara, el token se borra
        // con él), pero si algún día se rompiera esa garantía, mejor revertir todo con un error
        // explícito que dejar el token consumido para un usuario fantasma sin haber cambiado
        // ninguna credencial real.
        const updateResult = await this.usersService.updatePassword(
          resetToken.userId,
          passwordHash,
          manager,
        );

        if (!updateResult.affected) {
          throw new BadRequestException(invalidTokenMessage);
        }

        return resetToken.userId;
      },
    );

    // F03: la auditoría corre DESPUÉS de que la transacción de arriba confirmó — nunca antes. Si
    // la transacción falla o revierte, el `throw` de adentro sale de este método sin llegar acá,
    // así que nunca se registra un "auth.password_reset.completed" para un reset que no ocurrió
    // de verdad.
    //
    // A la inversa: si ESTE `record()` fallara, se propaga sin capturar — mismo criterio, sin
    // try/catch, que acceptInvitation/changePassword/revokeOtherSessions/deactivateAccount ya
    // usan en este archivo (no es una omisión nueva de esta ficha). El resultado es que el
    // request respondería con un error aunque la contraseña YA cambió con éxito en DB — un
    // fallo de auditoría nunca revierte (ni puede revertir, el commit ya ocurrió) las
    // credenciales. Preservar esta política existente está dentro de las restricciones de esta
    // ficha; endurecerla (ej. try/catch best-effort acá) sería un cambio de comportamiento
    // transversal a los otros cuatro métodos, no algo local a resetPassword — queda documentado
    // como riesgo preexistente en la entrega, no corregido acá.
    await this.auditLogService.record({
      actor: {
        actorUserId: consumedUserId,
        ip: requestMeta.ip,
        userAgent: requestMeta.userAgent,
      },
      action: 'auth.password_reset.completed',
      targetType: 'user',
      targetId: consumedUserId,
    });

    return { message: 'Contraseña actualizada correctamente.' };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    return this.usersService.toPublicUser(user);
  }

  /**
   * PROFILE-SEC-1: cambio de password autenticado (distinto de
   * resetPassword, que es el flujo público por token/email). Verifica la
   * password actual, hashea la nueva con el mismo criterio que el resto de
   * AgroScore y reusa updatePassword() — que además incrementa
   * `tokenVersion`, invalidando cualquier JWT emitido con la password
   * anterior. Para que la sesión actual (la que acaba de cambiar su propia
   * password) no quede deslogueada por su propio cambio, se reemite un
   * accessToken fresco con el tokenVersion nuevo — mismo shape que
   * login/register, así el frontend puede reusar storeSession().
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    requestMeta: RequestAuditMeta = {},
  ): Promise<AuthResponse> {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    const currentMatches = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );

    if (!currentMatches) {
      throw new UnauthorizedException('La contraseña actual no es correcta.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await this.usersService.updatePassword(userId, passwordHash);

    const updated = await this.usersService.findById(userId);

    if (!updated) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    await this.auditLogService.record({
      actor: { actorUserId: userId, ip: requestMeta.ip, userAgent: requestMeta.userAgent },
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: userId,
    });

    return this.buildAuthResponse(updated);
  }

  /**
   * PROFILE-SEC-1: "cerrar otras sesiones" — no hay tabla de sesiones en
   * AgroScore (JWT stateless, ver 15-auth-access-and-roles.md), así que
   * "otras sesiones" son, en la práctica, "cualquier otro JWT ya emitido".
   * Incrementar tokenVersion los invalida a todos sin distinguir cuál es
   * "otro" — por eso, igual que changePassword, se reemite un token fresco
   * para que la sesión que pidió la acción siga funcionando.
   */
  async revokeOtherSessions(
    userId: string,
    requestMeta: RequestAuditMeta = {},
  ): Promise<AuthResponse> {
    await this.usersService.incrementTokenVersion(userId);

    const updated = await this.usersService.findById(userId);

    if (!updated) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    await this.auditLogService.record({
      actor: { actorUserId: userId, ip: requestMeta.ip, userAgent: requestMeta.userAgent },
      action: 'auth.sessions_revoked',
      targetType: 'user',
      targetId: userId,
    });

    return this.buildAuthResponse(updated);
  }

  /**
   * SEC-003: cierra el replay de un JWT después de logout reutilizando el mismo mecanismo de
   * invalidación por generación que `changePassword`/`revokeOtherSessions` (`tokenVersion`) — no
   * hay sesiones individuales, JTI ni blacklist en AgroScore, así que "cerrar sesión" y "cerrar
   * todas las sesiones" son, en este modelo, la MISMA operación: el incremento invalida
   * indistintamente el JWT que ejecutó el logout y cualquier otro emitido antes para el mismo
   * usuario. Limitación deliberada de esta remediación mínima (ver docs/audits/secops-audit.md,
   * SEC-012).
   *
   * A diferencia de `revokeOtherSessions` (que reemite un accessToken para que la sesión que pidió
   * la acción siga funcionando), logout NO reemite nada — es la semántica esperada de "cerrar
   * sesión": quien lo pide también queda deslogueado.
   *
   * Igual que `resetPassword`/`acceptInvitation`, la auditoría corre DESPUÉS de que el incremento
   * ya se aplicó (un solo `UPDATE` atómico vía `UsersService.incrementTokenVersion`, sin
   * transacción explícita que lo agrupe con el audit log — no hay dos escrituras que necesiten
   * serializarse entre sí, a diferencia de resetPassword). Si `auditLogService.record()` fallara,
   * se propaga sin capturar (mismo criterio sin try/catch que el resto de este archivo): el
   * request respondería con error 500 aunque el token YA quedó revocado. La invariante de
   * seguridad (ningún JWT anterior autoriza un request nuevo) se sostiene igual — solo la
   * respuesta HTTP no lo refleja como éxito. No se agrega try/catch acá por la misma razón
   * documentada en resetPassword: sería un cambio de comportamiento transversal a los otros
   * métodos de este archivo, fuera de alcance de esta ficha.
   */
  async logout(
    userId: string,
    requestMeta: RequestAuditMeta = {},
  ): Promise<{ message: string }> {
    await this.usersService.incrementTokenVersion(userId);

    await this.auditLogService.record({
      actor: { actorUserId: userId, ip: requestMeta.ip, userAgent: requestMeta.userAgent },
      action: 'auth.logout',
      targetType: 'user',
      targetId: userId,
    });

    return { message: 'Sesión cerrada correctamente.' };
  }

  /**
   * PROFILE-SEC-1: "eliminar cuenta" real = desactivación, no hard delete —
   * reusa `isActive` (mismo mecanismo que AdminService.deactivateUser),
   * nunca toca Field/FieldLot/Analysis/reportes del usuario. JwtStrategy ya
   * rechaza cualquier request de un usuario con isActive=false en el
   * próximo request, así que no hace falta tocar tokenVersion acá. Mismo
   * chequeo de "no dejar el sistema sin ningún owner activo" que ya aplica
   * AdminService — un owner no puede autodesactivarse si es el último owner
   * activo.
   */
  async deactivateAccount(
    userId: string,
    dto: DeactivateAccountDto,
    requestMeta: RequestAuditMeta = {},
  ): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('La contraseña no es correcta.');
    }

    if (user.role === UserRole.OWNER && user.isActive) {
      const otherActiveOwners = await this.usersService.countActiveByRole(
        UserRole.OWNER,
        user.id,
      );

      if (otherActiveOwners === 0) {
        throw new BadRequestException(
          'No se puede completar la operación: dejaría el sistema sin ningún owner activo.',
        );
      }
    }

    await this.usersService.update(userId, { isActive: false });

    await this.auditLogService.record({
      actor: { actorUserId: userId, ip: requestMeta.ip, userAgent: requestMeta.userAgent },
      action: 'auth.account_deactivated',
      targetType: 'user',
      targetId: userId,
      before: { isActive: true },
      after: { isActive: false },
    });

    return { message: 'Tu cuenta fue desactivada correctamente.' };
  }

  private buildAuthResponse(user: User): AuthResponse {
    const publicUser = this.usersService.toPublicUser(user);

    const accessToken = this.jwtService.sign({
      sub: publicUser.id,
      email: publicUser.email,
      role: publicUser.role,
      tokenVersion: user.tokenVersion,
    });

    return { user: publicUser, accessToken };
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
