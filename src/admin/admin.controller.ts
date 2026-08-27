import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuditActorContext } from '../audit-log/audit-log.service';
import { UserRole } from '../users/user-role.enum';
import { AdminService } from './admin.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserFromAccessRequestDto } from './dto/create-user-from-access-request.dto';
import { ListAccessRequestsQueryDto } from './dto/list-access-requests-query.dto';
import { ListAnalysisQueryDto } from './dto/list-analysis-query.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ListFieldsQueryDto } from './dto/list-fields-query.dto';
import { ListLotsQueryDto } from './dto/list-lots-query.dto';
import { ListScheduledAnalysisQueryDto } from './dto/list-scheduled-analysis-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateAccessRequestDto } from './dto/update-access-request.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

// ADMIN-1: todo /admin/* exige JWT válido (JwtAuthGuard) + role owner|admin
// (RolesGuard + @Roles). Guards a nivel de controller, no repetidos método
// por método — cualquier endpoint nuevo que se agregue acá queda protegido
// automáticamente por default.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ADMIN-2: contexto de auditoría — quién hizo qué, desde dónde. `req.ip`
  // refleja la IP del proxy si el backend corre detrás de Nginx sin
  // `trust proxy` configurado (no se tocó esa config en esta ficha, ver
  // docs/admin-backend.md).
  private buildActorContext(req: AuthenticatedRequest): AuditActorContext {
    return {
      actorUserId: req.user.sub,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
  }

  @Get('metrics')
  getMetrics() {
    return this.adminService.getMetrics();
  }

  // Admin PR 4: Product Analytics básico — funnel + insights + monitoreo semanal + top errores.
  // Endpoint separado de /admin/metrics a propósito (ver AdminService.getProductAnalytics):
  // responde una pregunta distinta ("dónde se pierde valor") y /admin/metrics ya es grande.
  @Get('product-analytics')
  getProductAnalytics() {
    return this.adminService.getProductAnalytics();
  }

  @Get('system/health')
  getSystemHealth() {
    return this.adminService.getSystemHealth();
  }

  @Get('audit-logs')
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.adminService.listAuditLogs(query);
  }

  @Get('users')
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  // Admin PR 7: vista de detalle de un usuario, solo lectura — nunca dispara nada. 404 si el
  // usuario no existe (ver AdminService.getUserDetail). Va ANTES de las rutas 'users/:id' con
  // verbos mutantes (PATCH/DELETE/POST) por agrupación, aunque el orden no importa acá: Nest
  // resuelve por método HTTP + patrón, no hay ambigüedad entre GET 'users/:userId' y esas otras.
  @Get('users/:userId')
  getUserDetail(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.adminService.getUserDetail(userId);
  }

  @Post('users')
  createUser(
    @Body() dto: CreateAdminUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.createUser(dto, this.buildActorContext(req));
  }

  @Patch('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.updateUser(id, dto, this.buildActorContext(req));
  }

  // Soft delete: nunca borra el registro (ver AdminService.deactivateUser),
  // solo pone isActive=false. Coherente con la consigna de no eliminar
  // usuarios que tengan fields/analysis asociados.
  @Delete('users/:id')
  deactivateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.deactivateUser(id, this.buildActorContext(req));
  }

  @Post('users/:id/password-reset')
  createPasswordReset(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.createPasswordResetToken(
      id,
      this.buildActorContext(req),
    );
  }

  @Post('invitations')
  createInvitation(
    @Body() dto: CreateInvitationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.createInvitation(dto, this.buildActorContext(req));
  }

  @Get('fields')
  listFields(@Query() query: ListFieldsQueryDto) {
    return this.adminService.listFields(query);
  }

  // Admin PR 6: vista de detalle de un campo, solo lectura — nunca dispara nada. 404 si el campo
  // no existe (ver AdminService.getFieldDetail).
  @Get('fields/:fieldId')
  getFieldDetail(@Param('fieldId', ParseUUIDPipe) fieldId: string) {
    return this.adminService.getFieldDetail(fieldId);
  }

  @Get('lots')
  listLots(@Query() query: ListLotsQueryDto) {
    return this.adminService.listLots(query);
  }

  @Get('analysis')
  listAnalysis(@Query() query: ListAnalysisQueryDto) {
    return this.adminService.listAnalysis(query);
  }

  @Patch('analysis/:id/mark-reviewed')
  markAnalysisReviewed(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.markAnalysisReviewed(
      id,
      this.buildActorContext(req),
    );
  }

  @Post('analysis/:id/retry')
  retryAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.retryAnalysis(id, this.buildActorContext(req));
  }

  // PR 13B: solo lectura — nunca dispara una corrida, nunca reintenta un email.
  @Get('scheduled-analysis')
  listScheduledAnalysis(@Query() query: ListScheduledAnalysisQueryDto) {
    return this.adminService.listScheduledAnalysis(query);
  }

  @Get('access-requests')
  listAccessRequests(@Query() query: ListAccessRequestsQueryDto) {
    return this.adminService.listAccessRequests(query);
  }

  @Patch('access-requests/:id')
  updateAccessRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAccessRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.updateAccessRequest(
      id,
      dto,
      this.buildActorContext(req),
    );
  }

  @Post('access-requests/:id/create-user')
  createUserFromAccessRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateUserFromAccessRequestDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.adminService.createUserFromAccessRequest(
      id,
      dto,
      this.buildActorContext(req),
    );
  }
}
