import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { CreateFieldDto, CreateFieldLotDto } from './dto/create-field.dto';
import { Field } from './entities/field.entity';
import { FieldLot } from './entities/field-lot.entity';
import { MAX_GEOMETRY_COORDINATES } from './fields-constraints';
import { FieldsService } from './fields.service';
// SEC-004A: import de namespace (no solo nombrado) para poder espiar isSimpleClosedRing con
// jest.spyOn — demuestra que el límite de tamaño corta ANTES de llegar a esta función O(n²), sin
// mockear su implementación (el spy deja pasar la llamada real salvo que el test la restaure).
import * as ringTopologyUtil from './ring-topology.util';

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

  // SEC-004: fixtures topológicamente inválidas — mismo contrato estructural (Polygon de 1 ring)
  // que exteriorRing arriba, pero degeneradas a nivel de forma geométrica.
  const openRing = [
    [-64.1, -31.4],
    [-64.0, -31.4],
    [-64.0, -31.3],
    [-64.05, -31.35],
  ]; // 4 posiciones, pero el último punto NO repite el primero.
  const openRingGeojson = { type: 'Polygon', coordinates: [openRing] };

  const bowTieRing = [
    [0, 0],
    [4, 4],
    [4, 0],
    [0, 1],
    [0, 0],
  ];
  const bowTieGeojson = { type: 'Polygon', coordinates: [bowTieRing] };

  const collinearZeroAreaRing = [
    [-64.1, -31.4],
    [-64.05, -31.4],
    [-64.0, -31.4],
    [-64.1, -31.4],
  ]; // 3 vértices distintos, cerrado, pero los tres sobre la misma recta.
  const collinearZeroAreaGeojson = { type: 'Polygon', coordinates: [collinearZeroAreaRing] };

  const validRectangleRing = [
    [-64.1, -31.4],
    [-64.1, -31.3],
    [-64.0, -31.3],
    [-64.0, -31.4],
    [-64.1, -31.4],
  ];
  const validRectangleGeojson = { type: 'Polygon', coordinates: [validRectangleRing] };

  // SEC-004C: ring con una posición de 3 componentes ([lon, lat, z]) — estructuralmente un
  // triángulo cerrado válido salvo por esa única posición con elevación de más.
  const ringWithExtraDimension = [
    [-64.1, -31.4, 0],
    [-64.0, -31.4],
    [-64.0, -31.3],
    [-64.1, -31.4, 0],
  ];
  const geojsonWithExtraDimension = { type: 'Polygon', coordinates: [ringWithExtraDimension] };

  // SEC-004C: posición con un solo componente ([lon]) — menos de 2.
  const ringWithTooFewComponents = [
    [-64.1, -31.4],
    [-64.0],
    [-64.0, -31.3],
    [-64.1, -31.4],
  ];
  const geojsonWithTooFewComponents = { type: 'Polygon', coordinates: [ringWithTooFewComponents] };

  /**
   * SEC-004A: genera un polígono convexo simple con `vertexCount` vértices distintos más el
   * cierre (total = vertexCount + 1 posiciones) — nunca se auto-intersecta para ningún
   * vertexCount >= 3 (puntos sobre un círculo, en orden angular), así que sirve tanto para
   * probar el límite de tamaño como para un caso positivo genuino, sin escribir un array
   * literal enorme a mano.
   */
  const buildConvexRing = (vertexCount: number): number[][] => {
    const points = Array.from({ length: vertexCount }, (_, i) => {
      const angle = (2 * Math.PI * i) / vertexCount;
      return [Math.cos(angle) * 0.01, Math.sin(angle) * 0.01];
    });
    return [...points, points[0]];
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

  afterEach(() => {
    // SEC-004A: restaura cualquier jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing') hecho por
    // un test puntual — sin esto, un spy quedaría activo (aunque sin mockImplementation, solo
    // trackeando llamadas) para tests posteriores.
    jest.restoreAllMocks();
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

    // SEC-004: ring abierto/degenerado — mismo criterio "sin persistencia parcial" que los casos
    // de arriba (multipart/holes/rango), ahora para la política topológica nueva.
    it('rechaza un ring abierto sin cerrarlo en silencio, sin llamar a ningún repositorio', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: openRingGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldLotRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza un bow-tie (autointersección) sin llamar a ningún repositorio', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: bowTieGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldLotRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza un ring cerrado y colineal (área cero) sin llamar a ningún repositorio', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: collinearZeroAreaGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fieldLotRepository.create).not.toHaveBeenCalled();
      expect(fieldRepository.save).not.toHaveBeenCalled();
    });

    it('el mensaje de rechazo es el genérico estable, sin exponer coordenadas', async () => {
      const invalidDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: openRingGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
        'El polígono del lote no es válido.',
      );
    });

    it('acepta un rectángulo cerrado simple de 5 posiciones', async () => {
      const validDto = {
        ...dto,
        lots: [{ name: 'lote_1', geojson: validRectangleGeojson, areaHa: 10 }],
      } as CreateFieldDto;

      await service.create(validDto, 'user-A');

      expect(fieldRepository.save).toHaveBeenCalled();
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

    // SEC-004A: límite de coordenadas — evaluado ANTES de isSimpleClosedRing() (O(n²)) y antes
    // de cualquier escritura, sobre la SUMA de posiciones de todos los lotes del Field.
    describe('límite de coordenadas (SEC-004A)', () => {
      it('rechaza un único lote de 5001 posiciones, sin llamar a ningún repositorio', async () => {
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)], // vértices + cierre = 5001
        };
        const invalidDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: oversizedGeojson, areaHa: 10 }],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
          `La geometría supera el máximo permitido de ${MAX_GEOMETRY_COORDINATES} coordenadas.`,
        );
        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });

      it('rechaza 5001 posiciones distribuidas entre varios lotes, ninguno individualmente sobre el límite', async () => {
        const lot1Geojson = { type: 'Polygon', coordinates: [buildConvexRing(2999)] }; // 3000 posiciones
        const lot2Geojson = { type: 'Polygon', coordinates: [buildConvexRing(2000)] }; // 2001 posiciones — suma 5001

        const invalidDto = {
          ...dto,
          lots: [
            { name: 'lote_1', geojson: lot1Geojson, areaHa: 10 },
            { name: 'lote_2', geojson: lot2Geojson, areaHa: 10 },
          ],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
          `La geometría supera el máximo permitido de ${MAX_GEOMETRY_COORDINATES} coordenadas.`,
        );
        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });

      it('no ejecuta isSimpleClosedRing() cuando el límite de tamaño ya fue excedido', async () => {
        const spy = jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing');
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)],
        };
        const invalidDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: oversizedGeojson, areaHa: 10 }],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(spy).not.toHaveBeenCalled();
      });

      it('exactamente 5000 posiciones totales supera el control de tamaño y llega a isSimpleClosedRing()', async () => {
        const spy = jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing');
        // vertexCount 4999 + cierre = exactamente 5000 posiciones — igual al límite, no lo supera.
        const boundaryGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES - 1)],
        };
        const boundaryDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: boundaryGeojson, areaHa: 10 }],
        } as CreateFieldDto;

        await service.create(boundaryDto, 'user-A');

        expect(spy).toHaveBeenCalled();
      });

      it('acepta un polígono convexo simple de exactamente 5000 posiciones (caso positivo genuino)', async () => {
        const boundaryGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES - 1)],
        };
        const boundaryDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: boundaryGeojson, areaHa: 10 }],
        } as CreateFieldDto;

        await service.create(boundaryDto, 'user-A');

        expect(fieldRepository.save).toHaveBeenCalled();
      });

      it('varios lotes cuya suma sea exactamente 5000 pasan el control de tamaño', async () => {
        const lot1Geojson = { type: 'Polygon', coordinates: [buildConvexRing(2998)] }; // 2999 posiciones
        const lot2Geojson = { type: 'Polygon', coordinates: [buildConvexRing(2000)] }; // 2001 posiciones — suma 5000

        const boundaryDto = {
          ...dto,
          lots: [
            { name: 'lote_1', geojson: lot1Geojson, areaHa: 10 },
            { name: 'lote_2', geojson: lot2Geojson, areaHa: 10 },
          ],
        } as CreateFieldDto;

        await service.create(boundaryDto, 'user-A');

        expect(fieldRepository.save).toHaveBeenCalled();
      });

      it('un GeoJSON malformado (coordinates no es un array) no rompe el conteo y sigue recibiendo el error geométrico', async () => {
        const malformedGeojson = { type: 'Polygon', coordinates: 'no-es-un-array' };
        const invalidDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: malformedGeojson, areaHa: 10 }],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
          'El polígono del lote no es válido.',
        );
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });
    });

    // SEC-004C: cada posición exige EXACTAMENTE [lon, lat] — ni menos ni más componentes.
    describe('paridad dimensional (SEC-004C)', () => {
      it('rechaza una posición [lon, lat, z] sin llamar a ningún repositorio', async () => {
        const invalidDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: geojsonWithExtraDimension, areaHa: 10 }],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toThrow(
          'El polígono del lote no es válido.',
        );
        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });

      it('rechaza una posición con menos de dos componentes', async () => {
        const invalidDto = {
          ...dto,
          lots: [{ name: 'lote_1', geojson: geojsonWithTooFewComponents, areaHa: 10 }],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });

      it('con varios lotes, una posición tridimensional en cualquiera impide toda persistencia', async () => {
        const invalidDto = {
          ...dto,
          lots: [
            { name: 'lote_1', geojson: validGeojson, areaHa: 10 },
            { name: 'lote_2', geojson: geojsonWithExtraDimension, areaHa: 5 },
          ],
        } as CreateFieldDto;

        await expect(service.create(invalidDto, 'user-A')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.create).not.toHaveBeenCalled();
        expect(fieldRepository.save).not.toHaveBeenCalled();
      });

      it('sigue aceptando un Polygon simple con posiciones exactamente [lon, lat]', async () => {
        await service.create(dto, 'user-A');

        expect(fieldRepository.save).toHaveBeenCalled();
      });
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

    // SEC-004
    it('rechaza un ring abierto al reemplazar la geometría, sin ejecutar el update', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot('field-1', 'lot-1', { geojson: openRingGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un bow-tie al reemplazar la geometría, sin ejecutar el update', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot('field-1', 'lot-1', { geojson: bowTieGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('rechaza un ring colineal de área cero al reemplazar la geometría, sin ejecutar el update', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

      await expect(
        service.updateLot('field-1', 'lot-1', { geojson: collinearZeroAreaGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.update).not.toHaveBeenCalled();
    });

    it('acepta un rectángulo cerrado simple al reemplazar la geometría', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.findOne
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
        .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', geojson: validRectangleGeojson });

      const result = await service.updateLot(
        'field-1',
        'lot-1',
        { geojson: validRectangleGeojson },
        'user-A',
      );

      expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', {
        geojson: validRectangleGeojson,
      });
      expect(result.geojson).toEqual(validRectangleGeojson);
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

    // SEC-004A
    describe('límite de coordenadas (SEC-004A)', () => {
      it('rechaza 5001 posiciones al reemplazar geojson, sin ejecutar el update', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)],
        };

        await expect(
          service.updateLot('field-1', 'lot-1', { geojson: oversizedGeojson }, 'user-A'),
        ).rejects.toThrow(
          `La geometría supera el máximo permitido de ${MAX_GEOMETRY_COORDINATES} coordenadas.`,
        );
        expect(fieldLotRepository.update).not.toHaveBeenCalled();
      });

      it('no ejecuta isSimpleClosedRing() cuando el límite ya fue excedido', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });
        const spy = jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing');
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)],
        };

        await expect(
          service.updateLot('field-1', 'lot-1', { geojson: oversizedGeojson }, 'user-A'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(spy).not.toHaveBeenCalled();
      });

      it('acepta exactamente 5000 posiciones al reemplazar geojson', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        const boundaryGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES - 1)],
        };
        fieldLotRepository.findOne
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', geojson: boundaryGeojson });

        await service.updateLot('field-1', 'lot-1', { geojson: boundaryGeojson }, 'user-A');

        expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', {
          geojson: boundaryGeojson,
        });
      });

      it('un update sólo de metadata (sin geojson) no ejecuta isSimpleClosedRing() ni el chequeo de tamaño', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.findOne
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', notes: 'nuevo' });
        const spy = jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing');

        await service.updateLot('field-1', 'lot-1', { notes: 'nuevo' }, 'user-A');

        expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', { notes: 'nuevo' });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // SEC-004C
    describe('paridad dimensional (SEC-004C)', () => {
      it('rechaza una posición [lon, lat, z] al reemplazar la geometría, sin ejecutar el update', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.findOne.mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' });

        await expect(
          service.updateLot(
            'field-1',
            'lot-1',
            { geojson: geojsonWithExtraDimension },
            'user-A',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(fieldLotRepository.update).not.toHaveBeenCalled();
      });

      it('un update sólo de metadata sigue funcionando sin verse afectado', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.findOne
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1' })
          .mockResolvedValueOnce({ id: 'lot-1', fieldId: 'field-1', notes: 'nuevo' });

        await service.updateLot('field-1', 'lot-1', { notes: 'nuevo' }, 'user-A');

        expect(fieldLotRepository.update).toHaveBeenCalledWith('lot-1', { notes: 'nuevo' });
      });
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

    // SEC-004
    it('rechaza un ring abierto sin crear ni guardar el lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot('field-1', { ...dto, geojson: openRingGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.create).not.toHaveBeenCalled();
      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza un bow-tie sin crear ni guardar el lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot('field-1', { ...dto, geojson: bowTieGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza un ring colineal de área cero sin crear ni guardar el lote', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

      await expect(
        service.createLot('field-1', { ...dto, geojson: collinearZeroAreaGeojson }, 'user-A'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(fieldLotRepository.save).not.toHaveBeenCalled();
    });

    it('acepta un rectángulo cerrado simple', async () => {
      fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
      fieldLotRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([{ areaHa: 10 }]);

      await service.createLot('field-1', { ...dto, geojson: validRectangleGeojson }, 'user-A');

      expect(fieldLotRepository.save).toHaveBeenCalled();
    });

    // SEC-004A
    describe('límite de coordenadas (SEC-004A)', () => {
      it('rechaza 5001 posiciones sin crear ni guardar el lote', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)],
        };

        await expect(
          service.createLot('field-1', { ...dto, geojson: oversizedGeojson }, 'user-A'),
        ).rejects.toThrow(
          `La geometría supera el máximo permitido de ${MAX_GEOMETRY_COORDINATES} coordenadas.`,
        );
        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldLotRepository.save).not.toHaveBeenCalled();
      });

      it('no ejecuta isSimpleClosedRing() cuando el límite ya fue excedido', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        const spy = jest.spyOn(ringTopologyUtil, 'isSimpleClosedRing');
        const oversizedGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES)],
        };

        await expect(
          service.createLot('field-1', { ...dto, geojson: oversizedGeojson }, 'user-A'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(spy).not.toHaveBeenCalled();
      });

      it('acepta exactamente 5000 posiciones (polígono convexo simple)', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));
        fieldLotRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([{ areaHa: 10 }]);
        const boundaryGeojson = {
          type: 'Polygon',
          coordinates: [buildConvexRing(MAX_GEOMETRY_COORDINATES - 1)],
        };

        await service.createLot('field-1', { ...dto, geojson: boundaryGeojson }, 'user-A');

        expect(fieldLotRepository.save).toHaveBeenCalled();
      });
    });

    // SEC-004C
    describe('paridad dimensional (SEC-004C)', () => {
      it('rechaza una posición [lon, lat, z] sin crear ni guardar el lote', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

        await expect(
          service.createLot(
            'field-1',
            { ...dto, geojson: geojsonWithExtraDimension },
            'user-A',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(fieldLotRepository.create).not.toHaveBeenCalled();
        expect(fieldLotRepository.save).not.toHaveBeenCalled();
      });

      it('rechaza una posición con menos de dos componentes', async () => {
        fieldRepository.findOne.mockResolvedValue(buildField({ userId: 'user-A' }));

        await expect(
          service.createLot(
            'field-1',
            { ...dto, geojson: geojsonWithTooFewComponents },
            'user-A',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(fieldLotRepository.save).not.toHaveBeenCalled();
      });
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
