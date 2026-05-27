import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PipelineInput } from '../lots/lots.service';
import { WorkerAnalysisResult } from './types';

@Injectable()
export class PythonWorkerService {
  private readonly workerUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.workerUrl =
      this.configService.get<string>('PYTHON_WORKER_URL') ||
      'http://localhost:8000';
  }

  async runAnalysis(input: PipelineInput): Promise<WorkerAnalysisResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<WorkerAnalysisResult>(
          `${this.workerUrl}/analyze`,
          input,
          {
            timeout: 600_000,
          },
        ),
      );

      return response.data;
    } catch (error) {
      console.error('Python worker unavailable:', error);

      throw new ServiceUnavailableException(
        'No se pudo conectar con el worker Python.',
      );
    }
  }
}