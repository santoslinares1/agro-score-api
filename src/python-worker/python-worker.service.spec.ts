import { Test, TestingModule } from '@nestjs/testing';
import { PythonWorkerService } from './python-worker.service';

describe('PythonWorkerService', () => {
  let service: PythonWorkerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PythonWorkerService],
    }).compile();

    service = module.get<PythonWorkerService>(PythonWorkerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
