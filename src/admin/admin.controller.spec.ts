import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/user-role.enum';
import { AdminController } from './admin.controller';

// Complementa admin.guards.spec.ts (comportamiento end-to-end vía supertest):
// esto verifica que la protección esté efectivamente declarada en el
// controller, así detecta si alguien borra el @UseGuards/@Roles por error.
describe('AdminController — metadata de protección (ADMIN-1)', () => {
  it('el controller lleva JwtAuthGuard y RolesGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminController) as
      | unknown[]
      | undefined;

    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  it('el controller exige role owner o admin', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminController) as
      | UserRole[]
      | undefined;

    expect(roles).toEqual([UserRole.OWNER, UserRole.ADMIN]);
  });
});
