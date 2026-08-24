import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { FieldAnalysisScheduleService } from './field-analysis-schedule.service';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';

describe('FieldAnalysisScheduleService', () => {
  let service: FieldAnalysisScheduleService;
  let scheduleRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let fieldsService: jest.Mocked<Pick<FieldsService, 'findOne'>>;

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({ id: 'field-1', userId: 'user-A', name: 'Campo A', lots: [], ...overrides }) as Field;

  const buildSchedule = (overrides: Partial<FieldAnalysisSchedule> = {}): FieldAnalysisSchedule =>
    ({
      id: 'schedule-1',
      fieldId: 'field-1',
      userId: 'user-A',
      enabled: true,
      frequency: 'weekly',
      dayOfWeek: 1,
      hour: 9,
      minute: 0,
      timezone: 'America/Argentina/Cordoba',
      analysisScope: 'field',
      includeMapAssets: true,
      includeIndexImages: true,
      includeImageSeries: true,
      lastAnalysisId: null,
      lastRunAt: null,
      nextRunAt: new Date('2026-08-24T12:00:00Z'),
      lastStatus: null,
      lastErrorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as FieldAnalysisSchedule;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FieldAnalysisScheduleService,
        {
          provide: getRepositoryToken(FieldAnalysisSchedule),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn((data) => data),
            save: jest.fn((data) => Promise.resolve({ id: 'schedule-1', ...data })),
            update: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: FieldsService, useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    service = module.get(FieldAnalysisScheduleService);
    scheduleRepository = module.get(getRepositoryToken(FieldAnalysisSchedule));
    fieldsService = module.get(FieldsService);
  });

  describe('upsert', () => {
    it('crea un schedule nuevo para un campo propio con defaults del MVP', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(null);

      const result = await service.upsert('field-1', {}, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(scheduleRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldId: 'field-1',
          userId: 'user-A',
          enabled: true,
          dayOfWeek: 1,
          hour: 9,
          minute: 0,
          timezone: 'America/Argentina/Cordoba',
          includeMapAssets: true,
          includeIndexImages: true,
          includeImageSeries: true,
        }),
      );
      expect(result.fieldId).toBe('field-1');
    });

    it('rechaza un campo ajeno sin crear ni actualizar nada', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.upsert('field-1', {}, 'user-B')).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduleRepository.create).not.toHaveBeenCalled();
      expect(scheduleRepository.update).not.toHaveBeenCalled();
    });

    it('actualiza el schedule existente en vez de crear uno nuevo (no duplica por campo)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne
        .mockResolvedValueOnce(buildSchedule({ enabled: true }))
        .mockResolvedValueOnce(buildSchedule({ enabled: false }));

      await service.upsert('field-1', { enabled: false }, 'user-A');

      expect(scheduleRepository.create).not.toHaveBeenCalled();
      expect(scheduleRepository.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ enabled: false, nextRunAt: null }),
      );
    });

    it('desactivar deja nextRunAt en null', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(null);

      await service.upsert('field-1', { enabled: false }, 'user-A');

      expect(scheduleRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, nextRunAt: null }),
      );
    });

    it('preserva los campos no enviados del schedule existente', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne
        .mockResolvedValueOnce(buildSchedule({ includeImageSeries: false }))
        .mockResolvedValueOnce(buildSchedule({ includeImageSeries: false }));

      await service.upsert('field-1', { enabled: true }, 'user-A');

      expect(scheduleRepository.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ includeImageSeries: false }),
      );
    });
  });

  describe('get', () => {
    it('devuelve el schedule si el campo es del usuario', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(buildSchedule());

      const result = await service.get('field-1', 'user-A');

      expect(result.id).toBe('schedule-1');
    });

    it('lanza NotFoundException si el campo no tiene schedule configurado', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      scheduleRepository.findOne.mockResolvedValue(null);

      await expect(service.get('field-1', 'user-A')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propaga NotFoundException si el campo es ajeno, sin consultar el schedule', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.get('field-1', 'user-B')).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduleRepository.findOne).not.toHaveBeenCalled();
    });
  });
});
