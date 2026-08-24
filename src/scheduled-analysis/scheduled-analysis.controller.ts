import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpsertFieldAnalysisScheduleDto } from './dto/upsert-field-analysis-schedule.dto';
import { FieldAnalysisScheduleService } from './field-analysis-schedule.service';
import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('fields/:fieldId/analysis-schedule')
export class ScheduledAnalysisController {
  constructor(
    private readonly scheduleService: FieldAnalysisScheduleService,
    private readonly runnerService: ScheduledAnalysisRunnerService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Put()
  upsert(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: UpsertFieldAnalysisScheduleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.scheduleService.upsert(fieldId, dto, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  get(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Req() req: AuthenticatedRequest) {
    return this.scheduleService.get(fieldId, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('run-now')
  runNow(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Req() req: AuthenticatedRequest) {
    return this.runnerService.runNow(fieldId, req.user.sub);
  }
}
