import { Test, TestingModule } from '@nestjs/testing';

import { AuthenticatedUser } from '../auth/jwt.strategy';
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
      controllers: [ScheduledAnalysisController],
      providers: [
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
});
