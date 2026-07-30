import { GoneException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LotsController } from './lots.controller';

describe('LotsController', () => {
  let controller: LotsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LotsController],
    }).compile();

    controller = module.get<LotsController>(LotsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // AUTH-5 / CLEANUP-2: el módulo legacy `lots` no tiene entidad ni service
  // (el controller no tiene ninguna dependencia inyectada) — estructuralmente
  // no puede tocar DB ni worker. Cada endpoint debe bloquear con 410 Gone
  // para cualquier caller autenticado (el guard JwtAuthGuard filtra a los no
  // autenticados antes de llegar acá).
  describe('todos los endpoints legacy responden 410 Gone sin parámetros reales', () => {
    it('create (POST /lots)', () => {
      expect(() => controller.create()).toThrow(GoneException);
    });

    it('findAll (GET /lots)', () => {
      expect(() => controller.findAll()).toThrow(GoneException);
    });

    it('getPipelineInput (GET /lots/:id/pipeline-input)', () => {
      expect(() => controller.getPipelineInput('any-id')).toThrow(GoneException);
    });

    it('findOne (GET /lots/:id)', () => {
      expect(() => controller.findOne('any-id')).toThrow(GoneException);
    });

    it('update (PATCH /lots/:id)', () => {
      expect(() => controller.update('any-id')).toThrow(GoneException);
    });

    it('remove (DELETE /lots/:id)', () => {
      expect(() => controller.remove('any-id')).toThrow(GoneException);
    });

    it('el mensaje de error es el mismo mensaje claro para todos los endpoints', () => {
      const expectedMessage =
        'El flujo legacy de lotes individuales fue reemplazado por campos multi-lote. Usá /fields.';

      expect(() => controller.create()).toThrow(expectedMessage);
      expect(() => controller.findAll()).toThrow(expectedMessage);
      expect(() => controller.findOne('x')).toThrow(expectedMessage);
    });
  });
});
