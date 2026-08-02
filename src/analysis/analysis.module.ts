import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';
import { FieldsModule } from 'src/fields/fields.module';
import { ReportPdfService } from './report-pdf/report-pdf.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Analysis]),
    PythonWorkerModule,
    FieldsModule,
  ],
  controllers: [AnalysisController],
  providers: [AnalysisService, ReportPdfService],
})
export class AnalysisModule {}
