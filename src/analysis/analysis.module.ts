import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
import { AnalysisController } from './analysis.controller';
import { AnalysisReconcileScheduler } from './analysis-reconcile.scheduler';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';
import { FieldsModule } from 'src/fields/fields.module';
import { ReportPdfService } from './report-pdf/report-pdf.service';
import { AnalysisVerdictModule } from '../analysis-verdict/analysis-verdict.module';
import {
  ANALYSIS_QUEUE_CONFIG,
  analysisQueueConfigProvider,
} from '../analysis-queue/analysis-queue.config';
import { AnalysisAttempt } from '../analysis-queue/entities/analysis-attempt.entity';
import { AnalysisJobOutbox } from '../analysis-queue/entities/analysis-job-outbox.entity';

@Module({
  imports: [
    // ADR-001: outbox/intentos se registran acá (autoLoadEntities) porque AnalysisService escribe
    // el outbox en la misma transacción que crea el Analysis.
    TypeOrmModule.forFeature([Analysis, AnalysisJobOutbox, AnalysisAttempt]),
    PythonWorkerModule,
    FieldsModule,
    AnalysisVerdictModule,
  ],
  controllers: [AnalysisController],
  // OPS-1: AnalysisReconcileScheduler no necesita registrar nada más — ScheduleModule.forRoot()
  // ya está montado globalmente en AppModule, así que @Interval() funciona acá sin volver a
  // importar ScheduleModule (mismo criterio que ScheduledAnalysisScheduler).
  providers: [
    AnalysisService,
    ReportPdfService,
    AnalysisReconcileScheduler,
    UserComputeThrottlerGuard,
    // ADR-001: flags/valores de la cola (ANALYSIS_QUEUE_*) — ver analysis-queue.config.ts.
    analysisQueueConfigProvider,
  ],
  // Fase 4A (scheduled-analysis): el scheduler reutiliza AnalysisService.runFieldAnalysis/findOne
  // tal cual (mismo pipeline manual, sin duplicar lógica) — antes no se exportaba porque nada
  // fuera de este módulo lo necesitaba. No cambia ningún comportamiento del análisis manual.
  exports: [AnalysisService, ANALYSIS_QUEUE_CONFIG],
})
export class AnalysisModule {}
