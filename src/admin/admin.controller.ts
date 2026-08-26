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
import { PaginationQueryDto } from './dto/pagination-query.dto';
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

  @Get('system/health')
  getSystemHealth() {
    return this.adminService.getSystemHealth();
  }

  @Get('audit-logs')
  listAuditLogs(@Query() query: ListAuditLogsQueryDto) {
    return this.adminService.listAuditLogs(query);
  }

  @Get('users')
  listUsers(@Query() query: PaginationQueryDto) {
    return this.adminService.listUsers(query);
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

  @Get('lots')
  listLots(@Query() query: PaginationQueryDto) {
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
  listScheduledAnalysis(@Query() query: PaginationQueryDto) {
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
