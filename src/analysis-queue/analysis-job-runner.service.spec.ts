import { AnalysisJobConsumerService } from './analysis-job-consumer.service';
import { AnalysisJobQueue } from './analysis-job-queue';
import { AnalysisJobReconcilerService } from './analysis-job-reconciler.service';
import { AnalysisJobRunnerService } from './analysis-job-runner.service';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';
import { resolveAnalysisQueueConfig } from './analysis-queue.config';

describe('AnalysisJobRunnerService (ADR-001)', () => {
  const build = (runnerEnabled: boolean) => {
    // Mocks sueltos (no métodos de un objeto) para poder afirmar sobre ellos sin unbound-method.
    const queueMocks = {
      start: jest.fn().mockResolvedValue(undefined),
      work: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    const queue: AnalysisJobQueue = {
      ...queueMocks,
      publish: jest.fn(),
      getJobState: jest.fn(),
    };
    const dispatcher = { dispatchPending: jest.fn().mockResolvedValue({}) };
    const reconciler = { reconcile: jest.fn().mockResolvedValue({}) };
    const consumer = { handle: jest.fn() };
    const config = resolveAnalysisQueueConfig(
      (key) =>
        ({
          ANALYSIS_JOB_RUNNER_ENABLED: String(runnerEnabled),
          ANALYSIS_OUTBOX_DISPATCH_INTERVAL_MS: '100',
          ANALYSIS_JOB_SHUTDOWN_TIMEOUT_MS: '4321',
        })[key],
    );
    const runner = new AnalysisJobRunnerService(
      queue,
      config,
      dispatcher as unknown as AnalysisOutboxDispatcherService,
      consumer as unknown as AnalysisJobConsumerService,
      reconciler as unknown as AnalysisJobReconcilerService,
    );

    return { runner, queue: queueMocks, dispatcher, reconciler };
  };

  it('ANALYSIS_JOB_RUNNER_ENABLED=false: no toca pg-boss ni consume', async () => {
    const { runner, queue } = build(false);

    await expect(runner.start()).resolves.toBe(false);
    expect(queue.start).not.toHaveBeenCalled();
    expect(queue.work).not.toHaveBeenCalled();
  });

  it('start: inicia pg-boss, registra el consumidor y corre dispatch + reconcile', async () => {
    const { runner, queue, dispatcher, reconciler } = build(true);

    await expect(runner.start()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queue.start).toHaveBeenCalledTimes(1);
    expect(queue.work).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchPending).toHaveBeenCalled();
    expect(reconciler.reconcile).toHaveBeenCalled();

    await runner.stop();
  });

  it('stop (SIGTERM): corta los loops ANTES de liberar la cola, espera el tick en curso y es idempotente', async () => {
    const { runner, queue, dispatcher } = build(true);
    let releaseTick: () => void = () => undefined;
    dispatcher.dispatchPending.mockImplementation(
      () => new Promise((resolve) => (releaseTick = () => resolve({}))),
    );

    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stopping = runner.stop();
    const stoppingAgain = runner.stop();
    expect(runner.isRunning()).toBe(false);
    expect(queue.stop).not.toHaveBeenCalled(); // espera el tick de dispatch en curso

    releaseTick();
    await Promise.all([stopping, stoppingAgain]);

    expect(queue.stop).toHaveBeenCalledTimes(1);
    expect(queue.stop).toHaveBeenCalledWith(4321);

    const callsAfterStop = dispatcher.dispatchPending.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dispatcher.dispatchPending.mock.calls.length).toBe(callsAfterStop);
  });
});
