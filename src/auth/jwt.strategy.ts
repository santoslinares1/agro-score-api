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
  // PROFILE-SEC-1: opcional para que tokens firmados antes de esta ficha
  // (sin el claim) sigan validando — ver el fallback `?? 0` en validate().
  tokenVersion?: number;
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

    // PROFILE-SEC-1: mismo criterio que isActive arriba, pero para
    // "cambiar contraseña" y "cerrar otras sesiones" desde /app/profile —
    // sin esto, un JWT emitido con la password/sesión anterior seguiría
    // siendo válido hasta expirar (hasta 7 días). Un payload sin el claim
    // (tokens emitidos antes de esta ficha) se trata como versión 0, que es
    // el default de todo usuario existente — no invalida sesiones activas
    // al desplegar este cambio, solo a partir del primer bump real.
    const payloadTokenVersion = payload.tokenVersion ?? 0;

    if (payloadTokenVersion !== user.tokenVersion) {
      throw new UnauthorizedException('Sesión inválida. Iniciá sesión nuevamente.');
    }

    return { sub: user.id, email: user.email, role: user.role };
  }
}
