import { Test, TestingModule } from '@nestjs/testing';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { WeeklyAnalysisSnapshotController } from './weekly-analysis-snapshot.controller';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';

describe('WeeklyAnalysisSnapshotController', () => {
  let controller: WeeklyAnalysisSnapshotController;
  let service: jest.Mocked<Pick<WeeklyAnalysisSnapshotService, 'findByField' | 'findLatest' | 'findOne'>>;

  const user: AuthenticatedUser = { sub: 'user-A', email: 'usera@example.com', role: 'owner' };
  const req = { user } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WeeklyAnalysisSnapshotController],
      providers: [
        {
          provide: WeeklyAnalysisSnapshotService,
          useValue: { findByField: jest.fn(), findLatest: jest.fn(), findOne: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(WeeklyAnalysisSnapshotController);
    service = module.get(WeeklyAnalysisSnapshotService);
  });

  it('list delega en service.findByField(fieldId, user.sub, query)', () => {
    const query = { limit: 12 };
    controller.list('field-1', query as any, req);
    expect(service.findByField).toHaveBeenCalledWith('field-1', 'user-A', query);
  });

  it('latest delega en service.findLatest(fieldId, user.sub)', () => {
    controller.latest('field-1', req);
    expect(service.findLatest).toHaveBeenCalledWith('field-1', 'user-A');
  });

  it('findOne delega en service.findOne(fieldId, snapshotId, user.sub)', () => {
    controller.findOne('field-1', 'snapshot-1', req);
    expect(service.findOne).toHaveBeenCalledWith('field-1', 'snapshot-1', 'user-A');
  });
});
