import { Test, TestingModule } from '@nestjs/testing';

import { AnalysisReconcileScheduler } from './analysis-reconcile.scheduler';
import { AnalysisService } from './analysis.service';

describe('AnalysisReconcileScheduler', () => {
  let scheduler: AnalysisReconcileScheduler;
  let analysisService: jest.Mocked<
    Pick<AnalysisService, 'reconcileStaleAnalyses'>
  >;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalysisReconcileScheduler,
        {
          provide: AnalysisService,
          useValue: { reconcileStaleAnalyses: jest.fn() },
        },
      ],
    }).compile();

    scheduler = module.get(AnalysisReconcileScheduler);
    analysisService = module.get(AnalysisService);
  });

  it('handleReconcileStale delega en AnalysisService.reconcileStaleAnalyses', async () => {
    analysisService.reconcileStaleAnalyses.mockResolvedValue(undefined);

    await scheduler.handleReconcileStale();

    expect(analysisService.reconcileStaleAnalyses).toHaveBeenCalledTimes(1);
  });

  it('handleReconcileStale no propaga si reconcileStaleAnalyses rechaza (un tick roto no debe tumbar el proceso)', async () => {
    analysisService.reconcileStaleAnalyses.mockRejectedValue(
      new Error('DB caída'),
    );

    await expect(scheduler.handleReconcileStale()).resolves.toBeUndefined();
  });
});
