import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLogService } from './audit-log.service';
import { AdminAuditLog } from './entities/admin-audit-log.entity';

/**
 * ADMIN-3: extraído de AdminModule (donde vivía como provider directo desde
 * ADMIN-2) porque AuthModule también necesita auditar ahora
 * (auth.invitation.accepted, auth.password_reset.completed vía
 * POST /auth/accept-invitation y POST /auth/reset-password). Importar
 * AdminModule completo en AuthModule hubiera traído de arrastre Field/
 * FieldLot/Analysis/AccessRequest — acoplamiento que no hace falta solo para
 * auditar. AdminModule y AuthModule importan este módulo por igual.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminAuditLog])],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
