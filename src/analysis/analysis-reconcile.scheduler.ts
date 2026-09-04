import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { AnalysisService } from './analysis.service';

// OPS-1: corre independiente del reconcile de scheduled-analysis (cada 2 min) — este no tiene
// apuro (staleness por definición implica que el proceso original ya no existe, no hay nada que
// "esperar a que termine"), así que 5 min alcanza y reduce la frecuencia de la query sobre
// `analysis` sin alargar significativamente la ventana de bloqueo de un campo.
const STALE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Wiring de reconciliación de Analysis stale — deliberadamente fino, mismo patrón que
 * ScheduledAnalysisScheduler: toda la lógica real vive en AnalysisService.reconcileStaleAnalyses,
 * esta clase solo decide cada cuánto correr y evita que un fallo puntual tumbe el proceso.
 */
@Injectable()
export class AnalysisReconcileScheduler {
  private readonly logger = new Logger(AnalysisReconcileScheduler.name);

  constructor(private readonly analysisService: AnalysisService) {}

  @Interval('analysis-reconcile-stale', STALE_RECONCILE_INTERVAL_MS)
  async handleReconcileStale(): Promise<void> {
    try {
      await this.analysisService.reconcileStaleAnalyses();
    } catch (error) {
      this.logger.error(
        `[analysis-reconcile] Tick de reconciliación de análisis stale falló: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
