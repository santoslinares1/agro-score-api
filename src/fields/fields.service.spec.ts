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

  // GEOMETRY-2: fixtures compartidas para el contrato geométrico del piloto (ver
  // FieldsService.validateLotGeojson). Un solo ring exterior válido en todos los casos base.
  const exteriorRing = [
    [-64.1, -31.4],
    [-64.0, -31.4],
    [-64.0, -31.3],
    [-64.1, -31.4],
  ];
  const interiorRing = [
    [-64.08, -31.38],
    [-64.06, -31.38],
    [-64.06, -31.36],
    [-64.08, -31.38],
  ];
  const polygonWithHole = { type: 'Polygon', coordinates: [exteriorRing, interiorRing] };
  const featureWithHole = { type: 'Feature', geometry: polygonWithHole };
  const multiPolygonGeojson = { type: 'MultiPolygon', coordinates: [[exteriorRing]] };
  const featureCollectionOnePolygon = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [exteriorRing] } }],
  };
  const featureCollectionTwoPolygons = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [exteriorRing] } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [exteriorRing] } },
    ],
  };
  const ringWithOutOfRangeLongitude = [
    [200, -31.4],
    [-64.0, -31.4],
    [-64.0, -31.3],
    [200, -31.4],
  ];
  const geojsonWithOutOfRangeCoordinate = { type: 'Polygon', coordinates: [ringWithOutOfRangeLongitude] };

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
    // GEOMETRY-2: create() ahora valida geometría, así que el fixture base tiene que traer un
    // Polygon de 1 ring válido (antes usaba geojson: {} porque create() no validaba nada).
    const dto: CreateFieldDto = {
      name: 'Campo A',
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      maxCloudiness: 30,
      lots: [{ name: 'lote_1', geojson: validGeojson, areaHa: 10 }],
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

    // GEOMETRY-2 (contrato geométrico del piloto): create() valida CADA lote antes de construir
    // o persistir cualquier cosa — ni fieldRepository.create ni .save deben llamarse si un solo
    // lote es incompatible, aunque el resto del Field sea válido.

    it('acepta un Polygon de exactamente 1 ring', async () => {
      await service.create(dto, 'user-A');

      expect(fieldRepository.save).toHaveBeenCalled();
    });

    it('rechaza un MultiPolygon con el mensaje público de "un solo polígono por lote"', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: multiPolygonGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
        'AgroScore admite por ahora un solo polígono continuo por lote.',
      );
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza un Polygon con hole (2+ rings) con el mensaje público de áreas internas', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: polygonWithHole, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
        'áreas internas excluidas',
      );
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('no persiste NADA si uno de varios lotes es incompatible (sin creación parcial)', async () => {
      const multiLotDto = {
        ...dto,
        lots: [
          { name: 'lote_1', geojson: validGeojson, areaHa: 10 },
          { name: 'lote_2', geojson: multiPolygonGeojson, areaHa: 5 },
        ],
      } as CreateFieldDto;

      await expect(service.create(multiLotDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldLotRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza coordenadas con longitud fuera de rango antes de persistir', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: geojsonWithOutOfRangeCoordinate, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    // RISK-052: startDate/endDate representan un rango real — igualdad e inversión se rechazan
    // antes de tocar los repositorios, ni fieldLotRepository ni fieldRepository deben llamarse.
    it('rechaza startDate === endDate antes de persistir', async () => {
      const invalidDto = { ...dto, startDate: '2024-06-01', endDate: '2024-06-01' };

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza startDate > endDate antes de persistir', async () => {
      const invalidDto = { ...dto, startDate: '2024-06-02', endDate: '2024-06-01' };

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('persiste normalmente si startDate < endDate', async () => {
      await service.create(dto, 'user-A');

      expect(fieldRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2024-01-01', endDate: '2024-06-01' }),
      );
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

    // RISK-052: el Field persistido siempre tiene startDate='2024-01-01'/endDate='2024-06-01'
    // (ver buildField) — estos tests validan el PAR RESULTANTE de combinar el PATCH con eso,
    // no solo lo que trae el DTO.

    it('rechaza un PATCH con ambas fechas inválidas entre sí', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.update('field-1', { startDate: '2024-06-01', endDate: '2024-06-01' }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fieldRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un PATCH que solo trae startDate si invalida contra el endDate ya persistido', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.update('field-1', { startDate: '2027-01-01' }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fieldRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un PATCH que solo trae endDate si invalida contra el startDate ya persistido', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.update('field-1', { endDate: '2023-12-31' }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fieldRepository.update).not.toHaveBeenCalled();
    });

    it('acepta un PATCH que solo trae startDate si sigue siendo anterior al endDate persistido', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await service.update('field-1', { startDate: '2024-02-01' }, 'user-A');

      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { startDate: '2024-02-01' });
    });

    it('acepta un PATCH que solo trae endDate si sigue siendo posterior al startDate persistido', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await service.update('field-1', { endDate: '2024-12-31' }, 'user-A');

      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { endDate: '2024-12-31' });
    });

    it('un PATCH sin fechas no se ve afectado por un rango histórico ya inválido', async () => {
      fieldRepository.findOne.mockResolvedValue(
        buildField({ userId: 'user-A', startDate: '2024-06-01', endDate: '2024-01-01' }),
      );

      await service.update('field-1', { name: 'Nuevo nombre' }, 'user-A');

      expect(fieldRepository.update).toHaveBeenCalledWith('field-1', { name: 'Nuevo nombre' });
    });

    it('resuelve ownership antes de validar fechas: un PATCH inválido de otro usuario sigue dando NotFoundException', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.update('field-1', { startDate: '2024-06-01', endDate: '2024-06-01' }, 'user-B'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fieldRepository.update).not.toHaveBeenCalled();
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

    it('rechaza MultiPolygon al reemplazar la geometría de un lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot('field-1', 'lot-1', { geojson: multiPolygonGeojson }, 'user-A'),
      ).rejects.toThrow('AgroScore admite por ahora un solo polígono continuo por lote.');

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un Polygon con hole al reemplazar la geometría de un lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot('field-1', 'lot-1', { geojson: featureWithHole }, 'user-A'),
      ).rejects.toThrow('áreas internas excluidas');

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

    it('rechaza MultiPolygon con el mensaje público de "un solo polígono por lote"', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot('field-1', { ...dto, geojson: multiPolygonGeojson }, 'user-A'),
      ).rejects.toThrow('AgroScore admite por ahora un solo polígono continuo por lote.');

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('acepta una FeatureCollection con exactamente 1 Feature<Polygon>', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([{ areaHa: 30 }]);

      await service.createLot(
        'field-1',
        { ...dto, geojson: featureCollectionOnePolygon },
        'user-A',
      );

      expect(fieldLotRepository.save).toHaveBeenCalled();
    });

    it('rechaza una FeatureCollection con 2 features Polygon, sin elegir la primera en silencio', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot(
          'field-1',
          { ...dto, geojson: featureCollectionTwoPolygons },
          'user-A',
        ),
      ).rejects.toThrow('AgroScore admite por ahora un solo polígono continuo por lote.');

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza coordenadas con latitud fuera de rango', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot(
          'field-1',
          { ...dto, geojson: geojsonWithOutOfRangeCoordinate },
          'user-A',
        ),
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
