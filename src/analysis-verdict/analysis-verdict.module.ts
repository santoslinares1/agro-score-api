import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalysisVerdictService } from './analysis-verdict.service';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';
import { ClaudeTechnicalVerdictGenerator } from './generators/claude-technical-verdict.generator';
import { DeterministicTechnicalVerdictGenerator } from './generators/deterministic-technical-verdict.generator';

@Module({
  imports: [TypeOrmModule.forFeature([AnalysisTechnicalVerdict])],
  providers: [
    AnalysisVerdictService,
    DeterministicTechnicalVerdictGenerator,
    ClaudeTechnicalVerdictGenerator,
  ],
  exports: [AnalysisVerdictService],
})
export class AnalysisVerdictModule {}
