import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ListWeeklyAnalysisSnapshotsQueryDto } from './dto/list-weekly-analysis-snapshots-query.dto';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

/**
 * Fase 5: historial de reportes semanales comparativos — solo lectura, ownership vía
 * FieldsService en cada método del service (mismo patrón que ScheduledAnalysisController).
 */
@Controller('fields/:fieldId/weekly-analysis-snapshots')
@UseGuards(JwtAuthGuard)
export class WeeklyAnalysisSnapshotController {
  constructor(private readonly snapshotService: WeeklyAnalysisSnapshotService) {}

  @Get()
  list(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Query() query: ListWeeklyAnalysisSnapshotsQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.snapshotService.findByField(fieldId, req.user.sub, query);
  }

  @Get('latest')
  latest(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Req() req: AuthenticatedRequest) {
    return this.snapshotService.findLatest(fieldId, req.user.sub);
  }

  @Get(':snapshotId')
  findOne(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.snapshotService.findOne(fieldId, snapshotId, req.user.sub);
  }

  // MEASUREMENT GAP P1-05 ("Monitoreo semanal consultado"): acknowledgement explícito, separado
  // a propósito de cualquier GET (list/latest/:snapshotId) — devolver un snapshot nunca implica
  // que una persona lo vio en la sección principal (list/latest se piden aunque
  // field-weekly-monitoring esté fuera de vista). Nunca acepta timestamp ni identidad en el body
  // (ver WeeklyAnalysisSnapshotService.markViewed).
  @Post(':snapshotId/viewed')
  markViewed(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.snapshotService.markViewed(fieldId, snapshotId, req.user.sub);
  }
}
