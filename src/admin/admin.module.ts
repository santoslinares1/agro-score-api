import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditLogService } from './audit-log.service';
import { AdminAuditLog } from './entities/admin-audit-log.entity';

/**
 * ADMIN-1: para usuarios, siempre pasa por UsersService (UsersModule) — no
 * hay una segunda vía de acceso a la tabla `users`. Para fields/lots/
 * analysis/access-requests, AdminService inyecta los repositorios
 * directamente en vez de pasar por FieldsService/AnalysisService: esos
 * services están diseñados para operar siempre scoped a un userId (el
 * dueño autenticado) y no tienen forma de listar "todos los registros de
 * todos los usuarios" — agregarles ese bypass ahí mezclaría el modelo de
 * ownership del usuario final con el de lectura admin. Mantenerlos
 * separados evita tocar código de autorización ya probado y auditado.
 *
 * ADMIN-2: suma PythonWorkerModule (para GET /admin/system/health, reusa
 * PythonWorkerService.checkHealth) y las entidades de invitaciones/
 * password-reset/audit log. AuditLogService es su propio provider — lo usan
 * AdminController/Service, no AuthModule (accept-invitation no genera
 * entradas de auditoría, ver docs/admin-backend.md).
 */
@Module({
  imports: [
    UsersModule,
    PythonWorkerModule,
    TypeOrmModule.forFeature([
      Field,
      FieldLot,
      Analysis,
      AccessRequest,
      AdminAuditLog,
      UserInvitation,
      PasswordResetToken,
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService, AuditLogService],
})
export class AdminModule {}
