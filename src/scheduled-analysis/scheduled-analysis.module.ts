import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalysisModule } from '../analysis/analysis.module';
import { AnalysisVerdictModule } from '../analysis-verdict/analysis-verdict.module';
import { EmailModule } from '../email/email.module';
import { FieldsModule } from '../fields/fields.module';
import { UsersModule } from '../users/users.module';
import { WeeklyTechnicalVerdictModule } from '../weekly-technical-verdict/weekly-technical-verdict.module';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import { ScheduledAnalysisRun } from './entities/scheduled-analysis-run.entity';
import { WeeklyAnalysisSnapshot } from './entities/weekly-analysis-snapshot.entity';
import { FieldAnalysisScheduleService } from './field-analysis-schedule.service';
import { ScheduledAnalysisController } from './scheduled-analysis.controller';
import { ScheduledAnalysisScheduler } from './scheduled-analysis.scheduler';
import { ScheduledAnalysisRunnerService } from './scheduled-analysis-runner.service';
import { WeeklyAnalysisSnapshotController } from './weekly-analysis-snapshot.controller';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';

/**
 * Fase 4A: automatiza el análisis ACTUAL (mismo pipeline/resultJson/PDF de siempre) por email
 * semanal. Módulo completamente separado de weekly-reports (índices NDVI/NDMI/NDRE con delta),
 * que queda congelada y sin tocar — ninguna dependencia cruzada entre los dos.
 *
 * Fase 5: WeeklyAnalysisSnapshot vive en este mismo módulo (no en weekly-reports) — se deriva de
 * Analysis.resultJson vía ScheduledAnalysisRunnerService, un concepto y una fuente de datos
 * distintos de weekly-reports (que tiene su propio pipeline de worker). Ver justificación en el
 * entregable de Fase 5.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FieldAnalysisSchedule,
      ScheduledAnalysisRun,
      WeeklyAnalysisSnapshot,
    ]),
    FieldsModule,
    AnalysisModule,
    AnalysisVerdictModule,
    UsersModule,
    EmailModule,
    WeeklyTechnicalVerdictModule,
  ],
  controllers: [ScheduledAnalysisController, WeeklyAnalysisSnapshotController],
  providers: [
    FieldAnalysisScheduleService,
    ScheduledAnalysisRunnerService,
    ScheduledAnalysisScheduler,
    WeeklyAnalysisSnapshotService,
  ],
  exports: [
    FieldAnalysisScheduleService,
    ScheduledAnalysisRunnerService,
    WeeklyAnalysisSnapshotService,
  ],
})
export class ScheduledAnalysisModule {}
