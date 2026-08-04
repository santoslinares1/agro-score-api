import { SetMetadata } from '@nestjs/common';

import { UserRole } from '../users/user-role.enum';

export const ROLES_KEY = 'roles';

/**
 * ADMIN-1: marca qué roles pueden pasar RolesGuard en una ruta/controller.
 * Se combina siempre con JwtAuthGuard (el guard de roles asume que
 * request.user ya está poblado — nunca se usa solo).
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
