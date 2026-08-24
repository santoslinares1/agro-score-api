import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';

// Cada 10 minutos en vez de un único cron duro "lunes 9:00": si el proceso estuvo caído a las
// 9:00 en punto, el primer tick después de volver a estar arriba igual encuentra el schedule
// vencido (nextRunAt <= now) y lo dispara — recuperación automática sin lógica extra.
const DISPATCH_INTERVAL_MS = 10 * 60 * 1000;

// La reconciliación corre más seguido que el dispatcher porque no espera a nada más que a que
// AnalysisService termine su fire-and-forget — no hay motivo para hacer esperar al usuario 10
// minutos más una vez que el análisis ya terminó.
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Wiring de scheduling de Fase 4A — deliberadamente fino: toda la lógica real vive en
 * ScheduledAnalysisRunnerService (testeada ahí, sin depender de temporizadores reales). Esta
 * clase solo decide "cada cuánto" y nunca deja que un fallo puntual tumbe el proceso.
 */
@Injectable()
export class ScheduledAnalysisScheduler {
  private readonly logger = new Logger(ScheduledAnalysisScheduler.name);

  constructor(private readonly runner: ScheduledAnalysisRunnerService) {}

  @Interval('scheduled-analysis-dispatch', DISPATCH_INTERVAL_MS)
  async handleDispatch(): Promise<void> {
    try {
      await this.runner.processDueSchedules();
    } catch (error) {
      this.logger.error(
        `[scheduled-analysis] Tick de dispatch falló: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Interval('scheduled-analysis-reconcile', RECONCILE_INTERVAL_MS)
  async handleReconcile(): Promise<void> {
    try {
      await this.runner.reconcilePendingRuns();
    } catch (error) {
      this.logger.error(
        `[scheduled-analysis] Tick de reconciliación falló: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
