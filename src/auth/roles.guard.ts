import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AuthenticatedUser } from './jwt.strategy';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from '../users/user-role.enum';

/**
 * ADMIN-1: guard genérico y reutilizable — no específico de /admin/*. Lee
 * los roles permitidos desde @Roles(...) (metadata a nivel método o
 * controller) y los compara contra request.user.role, que JwtStrategy
 * repuebla en cada request desde la DB (ver comentario en jwt.strategy.ts),
 * así que un cambio de rol/desactivación se refleja sin esperar a que
 * expire el JWT. Siempre debe ir después de JwtAuthGuard en @UseGuards(...):
 * sin JwtAuthGuard, request.user no existe y este guard deniega por default.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user) {
      return false;
    }

    return requiredRoles.includes(request.user.role);
  }
}
