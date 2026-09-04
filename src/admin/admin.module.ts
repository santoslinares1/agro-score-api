import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { AnalysisVerdictModule } from '../analysis-verdict/analysis-verdict.module';
import { AnalysisTechnicalVerdict } from '../analysis-verdict/entities/analysis-technical-verdict.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmailModule } from '../email/email.module';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { FieldAnalysisSchedule } from '../scheduled-analysis/entities/field-analysis-schedule.entity';
import { ScheduledAnalysisRun } from '../scheduled-analysis/entities/scheduled-analysis-run.entity';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { UsersModule } from '../users/users.module';
import { WeeklyTechnicalVerdictModule } from '../weekly-technical-verdict/weekly-technical-verdict.module';
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
 *
 * ADMIN-2: suma PythonWorkerModule (para GET /admin/system/health, reusa
 * PythonWorkerService.checkHealth) y las entidades de invitaciones/
 * password-reset.
 *
 * ADMIN-3: AuditLogService se extrajo a su propio AuditLogModule (ver
 * src/audit-log/audit-log.module.ts) porque AuthModule también lo necesita
 * ahora (accept-invitation/reset-password sí generan auditoría — a
 * diferencia de lo que decía el comentario viejo acá). AdminModule ya no lo
 * provee directo, solo lo importa. Suma también EmailModule para el envío
 * real de invitaciones/reset (ver src/email/email.module.ts).
 *
 * PR 13A: AnalysisTechnicalVerdict entra por el mismo criterio que
 * Field/FieldLot/Analysis — repositorio directo, no AnalysisVerdictModule/
 * AnalysisVerdictService. findResponseByAnalysisId no sirve acá igual (no
 * expone errorMessage, ver admin-analysis-technical-verdict.dto.ts) y
 * AdminService necesita una lectura en lote (IN analysisId) para el listado
 * paginado, no una consulta por id como esa.
 *
 * PR 13B: mismo criterio para FieldAnalysisSchedule/ScheduledAnalysisRun —
 * repositorio directo, no ScheduledAnalysisModule (que además arrastra
 * EmailModule/PythonWorkerModule/etc. innecesarios solo para leer dos
 * tablas de solo lectura).
 *
 * PR 16D: weeklyTechnicalVerdict es la ÚNICA excepción al criterio de arriba — importa
 * WeeklyTechnicalVerdictModule (liviano: solo TypeOrmModule.forFeature + sus 2 generadores, sin
 * EmailModule/PythonWorkerModule) y reusa WeeklyTechnicalVerdictService.findResponsesByScheduledRunIds
 * en vez de inyectar el repositorio directo. A diferencia de AnalysisTechnicalVerdict (donde
 * findResponseByAnalysisId no servía porque el shape público omite errorMessage, ver PR 13A),
 * WeeklyTechnicalVerdictResponse ya incluye errorMessage por diseño desde PR 16B — no hay motivo
 * real para duplicar la query/el mapeo entidad→DTO que el servicio ya resuelve.
 *
 * PR 17: AnalysisVerdictModule es la SEGUNDA excepción, por el mismo motivo que weeklyTechnicalVerdict
 * arriba — AdminService.retryTechnicalVerdict necesita ejecutar una generación real (nunca solo
 * leer), y esa lógica (resolver provider, guardar 'generated'/'failed', ser idempotente por
 * analysisId) ya vive completa y testeada en AnalysisVerdictService.generateAndPersist. Reinventarla
 * acá con el repositorio directo (como si fuera solo lectura, PR 13A) duplicaría exactamente el
 * código que este PR necesita reusar sin tocar.
 */
@Module({
  imports: [
    UsersModule,
    PythonWorkerModule,
    AuditLogModule,
    EmailModule,
    WeeklyTechnicalVerdictModule,
    AnalysisVerdictModule,
    TypeOrmModule.forFeature([
      Field,
      FieldLot,
      Analysis,
      AnalysisTechnicalVerdict,
      FieldAnalysisSchedule,
      ScheduledAnalysisRun,
      AccessRequest,
      UserInvitation,
      PasswordResetToken,
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
