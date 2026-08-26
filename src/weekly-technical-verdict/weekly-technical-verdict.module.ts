import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WeeklyTechnicalVerdict } from './entities/weekly-technical-verdict.entity';
import { WeeklyTechnicalVerdictService } from './weekly-technical-verdict.service';
import { ClaudeWeeklyTechnicalVerdictGenerator } from './generators/claude-weekly-technical-verdict.generator';
import { DeterministicWeeklyTechnicalVerdictGenerator } from './generators/deterministic-weekly-technical-verdict.generator';

/**
 * PR 16B: módulo propio (src/weekly-technical-verdict/**), no bajo scheduled-analysis/ ni
 * analysis-verdict/ — mismo criterio de separación conceptual que ya usa este repo entre
 * scheduled-analysis y weekly-reports (ver doc-comment de ScheduledAnalysisModule): el
 * diagnóstico semanal es un concepto propio, con su propia tabla/provider/promptVersion, aunque
 * lo consuma ScheduledAnalysisRunnerService. Preparado para que PR 16D (admin) lo importe
 * directamente sin pasar por scheduled-analysis.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WeeklyTechnicalVerdict])],
  providers: [
    WeeklyTechnicalVerdictService,
    DeterministicWeeklyTechnicalVerdictGenerator,
    ClaudeWeeklyTechnicalVerdictGenerator,
  ],
  exports: [WeeklyTechnicalVerdictService],
})
export class WeeklyTechnicalVerdictModule {}
