import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from '../users/users.service';
import { UserRole } from '../users/user-role.enum';
import { getRequiredJwtSecret } from './jwt-secret.util';

export type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
};

export type AuthenticatedUser = {
  sub: string;
  email: string;
  role: UserRole;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getRequiredJwtSecret(config),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.usersService.findById(payload.sub);

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado.');
    }

    // ADMIN-1: re-lee el estado actual del usuario en cada request (no solo
    // en el login) — así desactivar a alguien desde el panel admin corta su
    // acceso de inmediato, sin esperar a que expire el JWT (hasta 7 días).
    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado.');
    }

    return { sub: user.id, email: user.email, role: user.role };
  }
}
