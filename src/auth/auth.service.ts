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

import { UserInvitation } from '../users/entities/user-invitation.entity';
import { PublicUser, UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { hashToken } from './token.util';

const SALT_ROUNDS = 10;

export type AuthResponse = {
  user: PublicUser;
  accessToken: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @InjectRepository(UserInvitation)
    private readonly invitationRepository: Repository<UserInvitation>,
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
  async acceptInvitation(dto: AcceptInvitationDto): Promise<AuthResponse> {
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

    return this.buildAuthResponse(user);
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
