import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
import { FieldAnalysisScheduleService } from './field-analysis-schedule.service';
import { ScheduledAnalysisController } from './scheduled-analysis.controller';
import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';

describe('ScheduledAnalysisController', () => {
  let controller: ScheduledAnalysisController;
  let scheduleService: jest.Mocked<Pick<FieldAnalysisScheduleService, 'upsert' | 'get'>>;
  let runnerService: jest.Mocked<Pick<ScheduledAnalysisRunnerService, 'runNow'>>;

  const user: AuthenticatedUser = { sub: 'user-A', email: 'usera@example.com', role: 'owner' };
  const req = { user } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      // SEC-008: run-now ahora lleva @UseGuards(JwtAuthGuard, UserComputeThrottlerGuard) — ver el
      // mismo comentario en analysis.controller.spec.ts.
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 20 },
          { name: 'compute', ttl: 600_000, limit: 10 },
        ]),
      ],
      controllers: [ScheduledAnalysisController],
      providers: [
        UserComputeThrottlerGuard,
        { provide: FieldAnalysisScheduleService, useValue: { upsert: jest.fn(), get: jest.fn() } },
        { provide: ScheduledAnalysisRunnerService, useValue: { runNow: jest.fn() } },
      ],
    }).compile();

    controller = module.get(ScheduledAnalysisController);
    scheduleService = module.get(FieldAnalysisScheduleService);
    runnerService = module.get(ScheduledAnalysisRunnerService);
  });

  it('upsert delega en scheduleService.upsert(fieldId, dto, user.sub)', () => {
    const dto = { enabled: true } as any;
    controller.upsert('field-1', dto, req);
    expect(scheduleService.upsert).toHaveBeenCalledWith('field-1', dto, 'user-A');
  });

  it('get delega en scheduleService.get(fieldId, user.sub)', () => {
    controller.get('field-1', req);
    expect(scheduleService.get).toHaveBeenCalledWith('field-1', 'user-A');
  });

  it('runNow delega en runnerService.runNow(fieldId, user.sub)', () => {
    controller.runNow('field-1', req);
    expect(runnerService.runNow).toHaveBeenCalledWith('field-1', 'user-A');
  });

  describe('SEC-008: rate limiting por usuario en run-now', () => {
    it('lleva UserComputeThrottlerGuard además de JwtAuthGuard', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (controller as any).runNow,
      ) as unknown[] | undefined;

      expect(guards).toContain(UserComputeThrottlerGuard);
    });

    it('usa el throttler "compute" (10 req / 10 min) — mismo bucket que analysis/weekly-reports, no el "default"', () => {
      const handler = (controller as any).runNow;

      expect(Reflect.getMetadata('THROTTLER:LIMITcompute', handler)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLcompute', handler)).toBe(600_000);
      expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handler)).toBe(true);
    });
  });
});
