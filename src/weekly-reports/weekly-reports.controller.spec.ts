import { Test, TestingModule } from '@nestjs/testing';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { WeeklyReportsController } from './weekly-reports.controller';
import { WeeklyReportsService } from './weekly-reports.service';

describe('WeeklyReportsController', () => {
  let controller: WeeklyReportsController;
  let service: jest.Mocked<
    Pick<
      WeeklyReportsService,
      'create' | 'findAll' | 'findOneWithObservations' | 'findLatestCompleted' | 'findObservations'
    >
  >;

  const user: AuthenticatedUser = { sub: 'user-A', email: 'usera@example.com', role: 'owner' };
  const req = { user } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WeeklyReportsController],
      providers: [
        {
          provide: WeeklyReportsService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findOneWithObservations: jest.fn(),
            findLatestCompleted: jest.fn(),
            findObservations: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(WeeklyReportsController);
    service = module.get(WeeklyReportsService);
  });

  it('create delega en service.create(fieldId, dto, user.sub)', () => {
    const dto = { campaignStart: '2025-10-01' } as any;
    controller.create('field-1', dto, req);
    expect(service.create).toHaveBeenCalledWith('field-1', dto, 'user-A');
  });

  it('findAll delega en service.findAll(fieldId, user.sub, query)', () => {
    const query = { status: 'completed' } as any;
    controller.findAll('field-1', query, req);
    expect(service.findAll).toHaveBeenCalledWith('field-1', 'user-A', query);
  });

  it('findLatest delega en service.findLatestCompleted(fieldId, user.sub)', () => {
    controller.findLatest('field-1', req);
    expect(service.findLatestCompleted).toHaveBeenCalledWith('field-1', 'user-A');
  });

  it('findOne delega en service.findOneWithObservations(fieldId, reportId, user.sub)', () => {
    controller.findOne('field-1', 'report-1', req);
    expect(service.findOneWithObservations).toHaveBeenCalledWith('field-1', 'report-1', 'user-A');
  });

  it('findObservations delega en service.findObservations(fieldId, user.sub, query)', () => {
    const query = { index: 'NDVI' } as any;
    controller.findObservations('field-1', query, req);
    expect(service.findObservations).toHaveBeenCalledWith('field-1', 'user-A', query);
  });
});
