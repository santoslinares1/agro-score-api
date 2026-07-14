import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PythonWorkerService } from './python-worker.service';

@Module({
  imports: [HttpModule],
  providers: [PythonWorkerService],
  exports: [PythonWorkerService],
})
export class PythonWorkerModule {}
