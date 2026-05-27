import { Test, TestingModule } from '@nestjs/testing';
import { LotsService } from './lots.service';

describe('LotsService', () => {
  let service: LotsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LotsService],
    }).compile();

    service = module.get<LotsService>(LotsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
