import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

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
 */
@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([Field, FieldLot, Analysis, AccessRequest]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
