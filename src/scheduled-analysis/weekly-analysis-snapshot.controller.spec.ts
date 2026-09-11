import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AuthenticatedUser } from '../auth/jwt.strategy';
import { WeeklyAnalysisSnapshotController } from './weekly-analysis-snapshot.controller';
import { WeeklyAnalysisSnapshotService } from './weekly-analysis-snapshot.service';

describe('WeeklyAnalysisSnapshotController', () => {
  let controller: WeeklyAnalysisSnapshotController;
  let service: jest.Mocked<
    Pick<
      WeeklyAnalysisSnapshotService,
      'findByField' | 'findLatest' | 'findOne' | 'markViewed'
    >
  >;

  const user: AuthenticatedUser = { sub: 'user-A', email: 'usera@example.com', role: 'owner' };
  const req = { user } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WeeklyAnalysisSnapshotController],
      providers: [
        {
          provide: WeeklyAnalysisSnapshotService,
          useValue: {
            findByField: jest.fn(),
            findLatest: jest.fn(),
            findOne: jest.fn(),
            markViewed: jest.fn(),
          },
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

  // MEASUREMENT GAP P1-05 ("Monitoreo semanal consultado").
  describe('markViewed (MEASUREMENT GAP P1-05)', () => {
    it('delega en service.markViewed(fieldId, snapshotId, user.sub)', () => {
      controller.markViewed('field-1', 'snapshot-1', req);
      expect(service.markViewed).toHaveBeenCalledWith(
        'field-1',
        'snapshot-1',
        'user-A',
      );
    });

    it('devuelve exactamente lo que resuelve el service (respuesta mínima)', async () => {
      const response = { firstViewedAt: '2026-08-24T12:00:00.000Z' };
      service.markViewed.mockResolvedValue(response);

      const result = await controller.markViewed('field-1', 'snapshot-1', req);

      expect(result).toBe(response);
    });

    it('propaga NotFoundException del service (snapshot inexistente/ajeno) tal cual', async () => {
      service.markViewed.mockRejectedValue(
        new NotFoundException('Reporte semanal no encontrado.'),
      );

      await expect(
        controller.markViewed('field-1', 'missing-or-foreign', req),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
