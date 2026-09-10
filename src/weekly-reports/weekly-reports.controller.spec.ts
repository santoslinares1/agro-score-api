import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
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
      // SEC-008: create ahora lleva @UseGuards(JwtAuthGuard, UserComputeThrottlerGuard) — ver el
      // mismo comentario en analysis.controller.spec.ts.
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 20 },
          { name: 'compute', ttl: 600_000, limit: 10 },
        ]),
      ],
      controllers: [WeeklyReportsController],
      providers: [
        UserComputeThrottlerGuard,
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

  describe('SEC-008: rate limiting por usuario en create', () => {
    it('lleva UserComputeThrottlerGuard además de JwtAuthGuard', () => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (controller as any).create,
      ) as unknown[] | undefined;

      expect(guards).toContain(UserComputeThrottlerGuard);
    });

    it('usa el throttler "compute" (10 req / 10 min) — mismo bucket que analysis/run-now, no el "default"', () => {
      const handler = (controller as any).create;

      expect(Reflect.getMetadata('THROTTLER:LIMITcompute', handler)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLcompute', handler)).toBe(600_000);
      expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handler)).toBe(true);
    });
  });
});
