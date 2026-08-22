import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FieldsModule } from '../fields/fields.module';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { WeeklyFieldReport } from './entities/weekly-field-report.entity';
import { WeeklyLotIndexObservation } from './entities/weekly-lot-index-observation.entity';
import { WeeklyReportsController } from './weekly-reports.controller';
import { WeeklyReportsService } from './weekly-reports.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WeeklyFieldReport, WeeklyLotIndexObservation]),
    FieldsModule,
    PythonWorkerModule,
  ],
  controllers: [WeeklyReportsController],
  providers: [WeeklyReportsService],
})
export class WeeklyReportsModule {}
