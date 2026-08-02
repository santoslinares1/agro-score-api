import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { CreateFieldDto, CreateFieldLotDto } from './dto/create-field.dto';
import { Field } from './entities/field.entity';
import { FieldLot } from './entities/field-lot.entity';
import { FieldsService } from './fields.service';

describe('FieldsService', () => {
  let service: FieldsService;
  let fieldRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let fieldLotRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
  };

  const validGeojson = {
    type: 'Polygon',
    coordinates: [
      [
        [-64.1, -31.4],
        [-64.0, -31.4],
        [-64.0, -31.3],
        [-64.1, -31.4],
      ],
    ],
  };

  const buildField = (overrides: Partial<Field> = {}): Field =>
    ({
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo A',
      totalAreaHa: 10,
      lots: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      maxCloudiness: 30,
      ...overrides,
    }) as Field;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FieldsService,
        {
          provide: getRepositoryToken(Field),
          useValue: {
            create: jest.fn((data) => data),
            save: jest.fn((data) => Promise.resolve(data)),
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(FieldLot),
          useValue: {
            create: jest.fn((data) => data),
            save: jest.fn((data) => Promise.resolve(data)),
            findOne: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(FieldsService);
    fieldRepository = module.get(getRepositoryToken(Field));
    fieldLotRepository = module.get(getRepositoryToken(FieldLot));
  });

  describe('create', () => {
    const dto: CreateFieldDto = {
      name: 'Campo A',
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      maxCloudiness: 30,
      lots: [{ name: 'lote_1', geojson: {}, areaHa: 10 }],
    } as CreateFieldDto;

    it('asigna el userId recibido por parámetro, nunca uno del body', async () => {
      await service.create(dto, 'user-A');

      expect(fieldRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-A' }),
      );
    });

    it('ignora cualquier userId que venga colado en el dto', async () => {
      const dtoWithSpoofedUserId = { ...dto, userId: 'attacker-id' } as CreateFieldDto;

      await service.create(dtoWithSpoofedUserId, 'user-A');

      const createArg = fieldRepository.create.mock.calls[0][0];
      expect(createArg.userId).toBe('user-A');
    });
  });

  describe('findAll', () => {
    it('filtra por el userId recibido', async () => {
      fieldRepository.find.mockResolvedValue([]);

      await service.findAll('user-A');

      expect(fieldRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-A' } }),
      );
    });
  });

  describe('findOne', () => {
    it('devuelve el campo si es del usuario', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      const result = await service.findOne('field-1', 'user-A');

      expect(result.id).toBe('field-1');
    });

    it('lanza NotFoundException si el campo es de otro usuario', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(service.findOne('field-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('lanza NotFoundException si el campo no existe', async () => {
      fieldRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('lanza NotFoundException si el campo es ajeno, sin llegar a actualizar', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.update('field-1', { name: 'Hackeado' }, 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(fieldRepository.update).not.toHaveBeenCalled();
    });

    it('actualiza si el campo es propio', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await service.update('field-1', { name: 'Nuevo nombre' }, 'user-A');

      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { name: 'Nuevo nombre' });
    });
  });

  describe('updateLot', () => {
    it('lanza NotFoundException si el field es ajeno, sin tocar field_lots', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.updateLot('field-1', 'lot-1', { notes: 'x' }, 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(fieldLotRepository.findOne).not.toHaveBeenCalled();
      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('actualiza el lote si el field es propio y el lote le pertenece', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', notes: 'x' });

      const result = await service.updateLot('field-1', 'lot-1', { notes: 'x' }, 'user-A');

      expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', { notes: 'x' });
      expect(result.notes).toBe('x');
    });

    it('lanza NotFoundException si el lote no pertenece a ese field', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'other-field' });

      await expect(
        service.updateLot('field-1', 'lot-1', { notes: 'x' }, 'user-A'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('actualiza la geometría cuando el geojson es válido', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', geojson: validGeojson });

      const result = await service.updateLot(
        'field-1',
        'lot-1',
        { geojson: validGeojson },
        'user-A',
      );

      expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', { geojson: validGeojson });
      expect(result.geojson).toEqual(validGeojson);
    });

    it('rechaza geometría inválida sin llegar a persistir', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot(
          'field-1',
          'lot-1',
          { geojson: { type: 'Polygon', coordinates: [[[1, 2]]] } },
          'user-A',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('recalcula totalAreaHa cuando cambia areaHa', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', areaHa: 55 });
      fieldLotRepository.find.mockResolvedValueOnce([{ areaHa: 55 }, { areaHa: 20 }]);

      await service.updateLot('field-1', 'lot-1', { areaHa: 55 }, 'user-A');

      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { totalAreaHa: 75 });
    });
  });

  describe('createLot', () => {
    const dto: CreateFieldLotDto = {
      name: 'lote_nuevo',
      geojson: validGeojson,
      areaHa: 30,
    } as CreateFieldLotDto;

    it('lanza NotFoundException si el field es ajeno, sin tocar field_lots', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(service.createLot('field-1', dto, 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('crea el lote si el field es propio y recalcula totalAreaHa', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.find
        .mockResolvedValueOnce([{ displayOrder: 1 }, { displayOrder: 2 }])
        .mockResolvedValueOnce([{ areaHa: 10 }, { areaHa: 20 }, { areaHa: 30 }]);

      const result = await service.createLot('field-1', dto, 'user-A');

      expect(fieldLotRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: 'field-1', name: 'lote_nuevo', displayOrder: 3 }),
      );
      expect(fieldLotRepository.save).toHaveBeenCalled();
      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { totalAreaHa: 60 });
      expect(result.name).toBe('lote_nuevo');
    });

    it('rechaza geometría inválida sin crear el lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot('field-1', { ...dto, geojson: { type: 'Point' } }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('removeLot', () => {
    it('lanza NotFoundException si el field es ajeno, sin borrar nada', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(service.removeLot('field-1', 'lot-1', 'user-B')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(fieldLotRepository.delete).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el lote no pertenece a ese field', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'other-field' });

      await expect(service.removeLot('field-1', 'lot-1', 'user-A')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(fieldLotRepository.delete).not.toHaveBeenCalled();
    });

    it('elimina el lote propio y recalcula totalAreaHa', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });
      fieldLotRepository.find.mockResolvedValueOnce([{ areaHa: 15 }]);

      const result = await service.removeLot('field-1', 'lot-1', 'user-A');

      expect(fieldLotRepository.delete).toHaveBeenCalledWith('lot-1');
      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { totalAreaHa: 15 });
      expect(result).toEqual({ success: true });
    });
  });
});
