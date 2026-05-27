import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LotsModule } from '../lots/lots.module';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Analysis]), LotsModule, PythonWorkerModule],
  controllers: [AnalysisController],
  providers: [AnalysisService],
})
export class AnalysisModule {}