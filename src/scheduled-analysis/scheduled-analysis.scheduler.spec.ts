import { Test, TestingModule } from '@nestjs/testing';

import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';
import { ScheduledAnalysisScheduler } from './scheduled-analysis.scheduler';

describe('ScheduledAnalysisScheduler', () => {
  let scheduler: ScheduledAnalysisScheduler;
  let runner: jest.Mocked<Pick<ScheduledAnalysisRunnerService, 'processDueSchedules' | 'reconcilePendingRuns'>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledAnalysisScheduler,
        {
          provide: ScheduledAnalysisRunnerService,
          useValue: { processDueSchedules: jest.fn(), reconcilePendingRuns: jest.fn() },
        },
      ],
    }).compile();

    scheduler = module.get(ScheduledAnalysisScheduler);
    runner = module.get(ScheduledAnalysisRunnerService);
  });

  it('handleDispatch delega en runner.processDueSchedules', async () => {
    runner.processDueSchedules.mockResolvedValue(undefined);

    await scheduler.handleDispatch();

    expect(runner.processDueSchedules).toHaveBeenCalledTimes(1);
  });

  it('handleDispatch no propaga si processDueSchedules rechaza (un tick roto no debe tumbar el proceso)', async () => {
    runner.processDueSchedules.mockRejectedValue(new Error('DB caída'));

    await expect(scheduler.handleDispatch()).resolves.toBeUndefined();
  });

  it('handleReconcile delega en runner.reconcilePendingRuns', async () => {
    runner.reconcilePendingRuns.mockResolvedValue(undefined);

    await scheduler.handleReconcile();

    expect(runner.reconcilePendingRuns).toHaveBeenCalledTimes(1);
  });

  it('handleReconcile no propaga si reconcilePendingRuns rechaza', async () => {
    runner.reconcilePendingRuns.mockRejectedValue(new Error('DB caída'));

    await expect(scheduler.handleReconcile()).resolves.toBeUndefined();
  });
});
