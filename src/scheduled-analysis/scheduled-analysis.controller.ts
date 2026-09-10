import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
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

  // SEC-008: mismo bucket 'compute' (por usuario) que POST analysis/field/:fieldId y POST
  // fields/:fieldId/weekly-reports — ver UserComputeThrottlerGuard. El techo de concurrencia
  // (AnalysisService.assertUserBelowConcurrencyCeiling) se aplica dentro de runNow(), no acá.
  @UseGuards(JwtAuthGuard, UserComputeThrottlerGuard)
  @SkipThrottle({ default: true })
  @Throttle({ compute: { limit: 10, ttl: 600_000 } })
  @Post('run-now')
  runNow(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Req() req: AuthenticatedRequest) {
    return this.runnerService.runNow(fieldId, req.user.sub);
  }
}
