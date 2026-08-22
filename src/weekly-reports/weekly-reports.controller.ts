import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateWeeklyReportDto } from './dto/create-weekly-report.dto';
import { ListWeeklyReportsQueryDto } from './dto/list-weekly-reports-query.dto';
import { WeeklyObservationsQueryDto } from './dto/weekly-observations-query.dto';
import { WeeklyReportsService } from './weekly-reports.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('fields/:fieldId')
export class WeeklyReportsController {
  constructor(private readonly weeklyReportsService: WeeklyReportsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('weekly-reports')
  create(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: CreateWeeklyReportDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.weeklyReportsService.create(fieldId, dto, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('weekly-reports')
  findAll(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Query() query: ListWeeklyReportsQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.weeklyReportsService.findAll(fieldId, req.user.sub, query);
  }

  // Tiene que declararse ANTES de 'weekly-reports/:reportId' — si no, Express/Nest matchearía
  // "latest" como si fuera un :reportId (no es un UUID válido, así que ParseUUIDPipe lo
  // rechazaría con 400 en vez de resolver esta ruta).
  @UseGuards(JwtAuthGuard)
  @Get('weekly-reports/latest')
  findLatest(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Req() req: AuthenticatedRequest) {
    return this.weeklyReportsService.findLatestCompleted(fieldId, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('weekly-reports/:reportId')
  findOne(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.weeklyReportsService.findOneWithObservations(fieldId, reportId, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('weekly-observations')
  findObservations(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Query() query: WeeklyObservationsQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.weeklyReportsService.findObservations(fieldId, req.user.sub, query);
  }
}
