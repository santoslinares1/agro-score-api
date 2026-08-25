import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalysisVerdictService } from './analysis-verdict.service';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AnalysisTechnicalVerdict])],
  providers: [AnalysisVerdictService],
  exports: [AnalysisVerdictService],
})
export class AnalysisVerdictModule {}
