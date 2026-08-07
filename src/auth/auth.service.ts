import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsNull, MoreThan, Repository } from 'typeorm';

import { AuditLogService } from '../audit-log/audit-log.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { PublicUser, UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
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
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = this.normalizeEmail(dto.email);

    const existing = await this.usersService.findByEmail(email);

    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese email.');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const user = await this.usersService.create({
      email,
      passwordHash,
      fullName: dto.fullName.trim(),
      companyName: dto.companyName?.trim() || undefined,
    });

    return this.buildAuthResponse(user);
  }

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
   */
  async resetPassword(
    dto: ResetPasswordDto,
    requestMeta: RequestAuditMeta = {},
  ): Promise<{ message: string }> {
    const tokenHash = hashToken(dto.token);

    const resetToken = await this.passwordResetRepository.findOne({
      where: { tokenHash, usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });

    if (!resetToken) {
      throw new BadRequestException('El link de recuperación no es válido o ya expiró.');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    await this.usersService.updatePassword(resetToken.userId, passwordHash);

    resetToken.usedAt = new Date();
    await this.passwordResetRepository.save(resetToken);

    await this.auditLogService.record({
      actor: {
        actorUserId: resetToken.userId,
        ip: requestMeta.ip,
        userAgent: requestMeta.userAgent,
      },
      action: 'auth.password_reset.completed',
      targetType: 'user',
      targetId: resetToken.userId,
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

  private buildAuthResponse(user: User): AuthResponse {
    const publicUser = this.usersService.toPublicUser(user);

    const accessToken = this.jwtService.sign({
      sub: publicUser.id,
      email: publicUser.email,
      role: publicUser.role,
    });

    return { user: publicUser, accessToken };
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
