import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { FieldAnalysisScheduleService } from './field-analysis-schedule.service';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from './entities/field-analysis-schedule-status-transition.entity';

/**
 * Gap P0 (auditoría de KPIs — "denominador histórico de campos esperados"): desde este cambio,
 * `upsert` corre dentro de `scheduleRepository.manager.transaction(...)` y hace TODAS sus
 * escrituras (schedule + transición) a través del `EntityManager` transaccional que TypeORM le
 * pasa al callback — nunca a través del repositorio inyectado top-level. El mock de
 * `scheduleRepository` de acá simula exactamente ese contrato: `manager.transaction(cb)` invoca
 * `cb(fakeManager)`, y `fakeManager.getRepository(Entity)` devuelve un doble distinto para
 * FieldAnalysisSchedule (`txScheduleRepo`) y para FieldAnalysisScheduleStatusTransition
 * (`txTransitionRepo`) — así los tests pueden distinguir "se escribió el schedule" de "se escribió
 * la transición" sin ambigüedad.
 *
 * Lo que este archivo NO puede probar con mocks (y por eso se prueba aparte, contra PostgreSQL
 * real, en test/field-analysis-schedule-transition-atomicity.e2e-spec.ts): que un fallo a mitad de
 * transacción reviva efectivamente un ROLLBACK real, y que `SELECT ... FOR UPDATE` serialice de
 * verdad dos transacciones concurrentes contra la misma fila. Acá solo se verifica la lógica de
 * decisión (create vs update, cuándo insertar transición, reintento ante unique_violation) y que
 * el error de cualquier escritura se propaga sin ser absorbido — condición necesaria para que ese
 * rollback real ocurra.
 */
describe('FieldAnalysisScheduleService', () => {
  let service: FieldAnalysisScheduleService;

  let scheduleRepository: {
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let txScheduleRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    findOneByOrFail: jest.Mock;
  };
  let txTransitionRepo: {
    insert: jest.Mock;
  };
  let fakeManager: { getRepository: jest.Mock };
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
    txScheduleRepo = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'schedule-1', ...data })),
      update: jest.fn().mockResolvedValue(undefined),
      findOneByOrFail: jest.fn(),
    };
    txTransitionRepo = {
      insert: jest.fn().mockResolvedValue(undefined),
    };
    fakeManager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === FieldAnalysisSchedule) return txScheduleRepo;
        if (entity === FieldAnalysisScheduleStatusTransition) return txTransitionRepo;
        throw new Error('Entidad inesperada en el mock de manager.getRepository().');
      }),
    };

    scheduleRepository = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((cb: (manager: unknown) => Promise<unknown>) => cb(fakeManager)),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FieldAnalysisScheduleService,
        {
          provide: getRepositoryToken(FieldAnalysisSchedule),
          useValue: scheduleRepository,
        },
        { provide: FieldsService, useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    service = module.get(FieldAnalysisScheduleService);
    fieldsService = module.get(FieldsService);
  });

  describe('upsert', () => {
    it('crea un schedule nuevo para un campo propio con defaults del MVP', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      txScheduleRepo.findOne.mockResolvedValue(null);

      const result = await service.upsert('field-1', {}, 'user-A');

      expect(fieldsService.findOne).toHaveBeenCalledWith('field-1', 'user-A');
      expect(txScheduleRepo.create).toHaveBeenCalledWith(
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

    it('rechaza un campo ajeno sin crear ni actualizar nada, y sin abrir transacción', async () => {
      fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

      await expect(service.upsert('field-1', {}, 'user-B')).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduleRepository.manager.transaction).not.toHaveBeenCalled();
      expect(txScheduleRepo.create).not.toHaveBeenCalled();
      expect(txScheduleRepo.update).not.toHaveBeenCalled();
      expect(txTransitionRepo.insert).not.toHaveBeenCalled();
    });

    it('actualiza el schedule existente en vez de crear uno nuevo (no duplica por campo)', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
      txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: false }));

      await service.upsert('field-1', { enabled: false }, 'user-A');

      expect(txScheduleRepo.create).not.toHaveBeenCalled();
      expect(txScheduleRepo.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ enabled: false, nextRunAt: null }),
      );
    });

    it('desactivar deja nextRunAt en null', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      txScheduleRepo.findOne.mockResolvedValue(null);

      await service.upsert('field-1', { enabled: false }, 'user-A');

      expect(txScheduleRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, nextRunAt: null }),
      );
    });

    it('preserva los campos no enviados del schedule existente', async () => {
      fieldsService.findOne.mockResolvedValue(buildField());
      txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ includeImageSeries: false }));
      txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ includeImageSeries: false }));

      await service.upsert('field-1', { enabled: true }, 'user-A');

      expect(txScheduleRepo.update).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ includeImageSeries: false }),
      );
    });

    describe('historial de transiciones (gap P0 — denominador histórico de campos esperados)', () => {
      it('POSITIVO: creación habilitada registra el estado inicial', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(null);

        await service.upsert('field-1', { enabled: true }, 'user-A');

        expect(txTransitionRepo.insert).toHaveBeenCalledTimes(1);
        expect(txTransitionRepo.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            scheduleId: 'schedule-1',
            fieldId: 'field-1',
            enabled: true,
            source: 'schedule_upsert',
            actorUserId: 'user-A',
            effectiveAt: expect.any(Date),
          }),
        );
      });

      it('POSITIVO: creación deshabilitada también registra el estado inicial', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(null);

        await service.upsert('field-1', { enabled: false }, 'user-A');

        expect(txTransitionRepo.insert).toHaveBeenCalledTimes(1);
        expect(txTransitionRepo.insert).toHaveBeenCalledWith(
          expect.objectContaining({ enabled: false, source: 'schedule_upsert' }),
        );
      });

      it('POSITIVO: true → false agrega exactamente una fila enabled=false (desactivación)', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: false }));

        await service.upsert('field-1', { enabled: false }, 'user-A');

        expect(txTransitionRepo.insert).toHaveBeenCalledTimes(1);
        expect(txTransitionRepo.insert).toHaveBeenCalledWith(
          expect.objectContaining({ scheduleId: 'schedule-1', enabled: false, source: 'schedule_upsert' }),
        );
      });

      it('POSITIVO: false → true agrega exactamente una fila enabled=true (reactivación)', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: false, nextRunAt: null }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true }));

        await service.upsert('field-1', { enabled: true }, 'user-A');

        expect(txTransitionRepo.insert).toHaveBeenCalledTimes(1);
        expect(txTransitionRepo.insert).toHaveBeenCalledWith(
          expect.objectContaining({ scheduleId: 'schedule-1', enabled: true, source: 'schedule_upsert' }),
        );
      });

      it('NEGATIVO: true → true (mismo estado solicitado) no agrega fila', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true }));

        await service.upsert('field-1', { enabled: true }, 'user-A');

        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('NEGATIVO: false → false (mismo estado solicitado) no agrega fila', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: false, nextRunAt: null }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: false, nextRunAt: null }));

        await service.upsert('field-1', { enabled: false }, 'user-A');

        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('NEGATIVO: enabled omitido preserva el estado existente y no agrega fila', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true, hour: 14 }));

        await service.upsert('field-1', { hour: 14 }, 'user-A');

        expect(txScheduleRepo.update).toHaveBeenCalledWith(
          'schedule-1',
          expect.objectContaining({ enabled: true, hour: 14 }),
        );
        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('NEGATIVO: un cambio de horario sin cambio de enabled no agrega fila', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true, dayOfWeek: 1 }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true, dayOfWeek: 3 }));

        await service.upsert('field-1', { enabled: true, dayOfWeek: 3 }, 'user-A');

        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('NEGATIVO: campo ajeno no toca ni el schedule ni el historial', async () => {
        fieldsService.findOne.mockRejectedValue(new NotFoundException('Campo no encontrado.'));

        await expect(service.upsert('field-1', { enabled: false }, 'user-B')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
        expect(txScheduleRepo.update).not.toHaveBeenCalled();
        expect(txScheduleRepo.create).not.toHaveBeenCalled();
      });

      it('NEGATIVO: si falla la escritura del schedule, la transición nunca se intenta (nada de huérfanos)', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        const dbError = new Error('conexión perdida a mitad de UPDATE');
        txScheduleRepo.update.mockRejectedValue(dbError);

        await expect(service.upsert('field-1', { enabled: false }, 'user-A')).rejects.toThrow(dbError);

        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('NEGATIVO: si falla la inserción de la transición, el error se propaga (para que la transacción real revierta también el schedule)', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        const dbError = new Error('conexión perdida a mitad de INSERT');
        txTransitionRepo.insert.mockRejectedValue(dbError);

        await expect(service.upsert('field-1', { enabled: false }, 'user-A')).rejects.toThrow(dbError);
      });

      it('IDEMPOTENCIA: reintento HTTP con el mismo body (o doble click) no infla el historial', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true }));

        await service.upsert('field-1', { enabled: true }, 'user-A');
        await service.upsert('field-1', { enabled: true }, 'user-A');

        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
      });

      it('CONCURRENCIA: creación concurrente del mismo campo — ante unique_violation, reintenta y converge al camino de update sin duplicar la fila inicial', async () => {
        fieldsService.findOne.mockResolvedValue(buildField());
        const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        });

        // Primer intento: pierde la carrera de creación — otra transacción ganó el INSERT del
        // fieldId entre el findOne (nada que lockear, la fila no existía) y el propio INSERT.
        scheduleRepository.manager.transaction.mockImplementationOnce(() => Promise.reject(uniqueViolation));

        // Segundo intento (reintento completo, transacción nueva): ya encuentra la fila que la
        // ganadora creó, con el mismo `enabled` que este request también pedía (default true).
        txScheduleRepo.findOne.mockResolvedValue(buildSchedule({ enabled: true }));
        txScheduleRepo.findOneByOrFail.mockResolvedValue(buildSchedule({ enabled: true }));

        const result = await service.upsert('field-1', {}, 'user-A');

        expect(scheduleRepository.manager.transaction).toHaveBeenCalledTimes(2);
        expect(txScheduleRepo.create).not.toHaveBeenCalled();
        // Mismo enabled que ya persistió la ganadora — idempotencia semántica, no se duplica la
        // fila inicial de historial.
        expect(txTransitionRepo.insert).not.toHaveBeenCalled();
        expect(result.enabled).toBe(true);
      });
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
