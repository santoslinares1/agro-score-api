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
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/user-role.enum';
import { AdminService } from './admin.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { ListAccessRequestsQueryDto } from './dto/list-access-requests-query.dto';
import { ListAnalysisQueryDto } from './dto/list-analysis-query.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

// ADMIN-1: todo /admin/* exige JWT válido (JwtAuthGuard) + role owner|admin
// (RolesGuard + @Roles). Guards a nivel de controller, no repetidos método
// por método — cualquier endpoint nuevo que se agregue acá queda protegido
// automáticamente por default.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('metrics')
  getMetrics() {
    return this.adminService.getMetrics();
  }

  @Get('users')
  listUsers(@Query() query: PaginationQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Post('users')
  createUser(@Body() dto: CreateAdminUserDto) {
    return this.adminService.createUser(dto);
  }

  @Patch('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserDto,
  ) {
    return this.adminService.updateUser(id, dto);
  }

  // Soft delete: nunca borra el registro (ver AdminService.deactivateUser),
  // solo pone isActive=false. Coherente con la consigna de no eliminar
  // usuarios que tengan fields/analysis asociados.
  @Delete('users/:id')
  deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deactivateUser(id);
  }

  @Get('fields')
  listFields(@Query() query: PaginationQueryDto) {
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

  @Get('access-requests')
  listAccessRequests(@Query() query: ListAccessRequestsQueryDto) {
    return this.adminService.listAccessRequests(query);
  }
}
