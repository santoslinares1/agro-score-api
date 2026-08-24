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
  // Fase 4A (scheduled-analysis): el scheduler reutiliza AnalysisService.runFieldAnalysis/findOne
  // tal cual (mismo pipeline manual, sin duplicar lógica) — antes no se exportaba porque nada
  // fuera de este módulo lo necesitaba. No cambia ningún comportamiento del análisis manual.
  exports: [AnalysisService],
})
export class AnalysisModule {}
