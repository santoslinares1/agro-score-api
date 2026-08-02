import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateFieldDto, CreateFieldLotDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { UpdateFieldLotDto } from './dto/update-field-lot.dto';
import { Field } from './entities/field.entity';
import { FieldLot } from './entities/field-lot.entity';

export type FieldPipelineInput = {
  fieldId: string;
  name: string;
  location?: string;
  totalAreaHa: number;
  lots: Array<{
    id: string;
    name: string;
    geojson: unknown;
    areaHa: number;
    includeInProductivityClassification: boolean;
  }>;
};

@Injectable()
export class FieldsService {
  constructor(
    @InjectRepository(Field)
    private readonly fieldRepository: Repository<Field>,

    @InjectRepository(FieldLot)
    private readonly fieldLotRepository: Repository<FieldLot>,
  ) {}

  async create(dto: CreateFieldDto, userId: string): Promise<Field> {
    const lots = dto.lots.map((lot, index) =>
      this.fieldLotRepository.create({
        name: lot.name,
        geojson: lot.geojson,
        areaHa: lot.areaHa ?? 0,
        displayOrder: lot.displayOrder ?? index + 1,
        includeInProductivityClassification:
          lot.includeInProductivityClassification ?? true,
        notes: lot.notes,
      }),
    );

    const totalAreaHa = lots.reduce(
      (acc, lot) => acc + Number(lot.areaHa || 0),
      0,
    );

    const field = this.fieldRepository.create({
      userId,
      name: dto.name,
      ownerName: dto.ownerName,
      location: dto.location,
      province: dto.province,
      country: dto.country,
      boundaryGeojson: dto.boundaryGeojson,
      startDate: dto.startDate,
      endDate: dto.endDate,
      maxCloudiness: dto.maxCloudiness,
      totalAreaHa,
      lots,
    });

    return this.fieldRepository.save(field);
  }

  async findAll(userId: string): Promise<Field[]> {
    return this.fieldRepository.find({
      where: { userId },
      relations: {
        lots: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findOne(id: string, userId: string): Promise<Field> {
    const field = await this.fieldRepository.findOne({
      where: { id },
      relations: {
        lots: true,
      },
    });

    if (!field || field.userId !== userId) {
      throw new NotFoundException('Campo no encontrado.');
    }

    field.lots = [...field.lots].sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );

    return field;
  }

  /**
   * Variante interna sin chequeo de ownership, para uso de otros servicios
   * (p.ej. AnalysisService) que ya validaron el ownership por su cuenta.
   */
  async findByIdOrFail(id: string): Promise<Field> {
    const field = await this.fieldRepository.findOne({
      where: { id },
      relations: { lots: true },
    });

    if (!field) {
      throw new NotFoundException('Campo no encontrado.');
    }

    field.lots = [...field.lots].sort(
      (a, b) => a.displayOrder - b.displayOrder,
    );

    return field;
  }

  /**
   * Edita solo metadata general del campo. A propósito no toca `lots`: ese
   * array se gestiona con `updateLot` lote por lote, nunca reemplazando todo
   * desde acá.
   */
  async update(id: string, dto: UpdateFieldDto, userId: string): Promise<Field> {
    await this.findOne(id, userId);

    await this.fieldRepository.update(id, dto);

    return this.findOne(id, userId);
  }

  /**
   * Edita metadata de un FieldLot puntual (nombre, superficie de referencia,
   * inclusión en clasificación productiva, notas, orden). Desde GEOMETRY-1
   * también acepta `geojson`, para reemplazar la geometría completa del lote
   * (redibujo, no edición fina de vértices).
   */
  async updateLot(
    fieldId: string,
    lotId: string,
    dto: UpdateFieldLotDto,
    userId: string,
  ): Promise<FieldLot> {
    await this.findOne(fieldId, userId);

    const lot = await this.fieldLotRepository.findOne({
      where: { id: lotId },
    });

    if (!lot || lot.fieldId !== fieldId) {
      throw new NotFoundException(
        'El lote no existe o no pertenece a este campo.',
      );
    }

    if (dto.geojson !== undefined) {
      this.validateLotGeojson(dto.geojson);
    }

    // `geojson` es `unknown` en la entidad (jsonb sin tipar) — TypeORM no
    // logra inferir el QueryDeepPartialEntity para ese campo desde el DTO.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.fieldLotRepository.update(lotId, dto as any);

    if (dto.areaHa !== undefined) {
      await this.recalculateTotalAreaHa(fieldId);
    }

    const updatedLot = await this.fieldLotRepository.findOne({
      where: { id: lotId },
    });

    if (!updatedLot) {
      throw new NotFoundException('El lote no existe o no pertenece a este campo.');
    }

    return updatedLot;
  }

  /**
   * Agrega un lote interno nuevo a un campo existente (GEOMETRY-1). No
   * reemplaza `create()`: ese sigue siendo el alta de campo+lotes iniciales.
   */
  async createLot(
    fieldId: string,
    dto: CreateFieldLotDto,
    userId: string,
  ): Promise<FieldLot> {
    await this.findOne(fieldId, userId);

    this.validateLotGeojson(dto.geojson);

    const existingLots = await this.fieldLotRepository.find({
      where: { fieldId },
    });

    const nextDisplayOrder =
      existingLots.reduce((max, lot) => Math.max(max, lot.displayOrder ?? 0), 0) + 1;

    const lot = this.fieldLotRepository.create({
      fieldId,
      name: dto.name,
      geojson: dto.geojson,
      areaHa: dto.areaHa ?? 0,
      displayOrder: dto.displayOrder ?? nextDisplayOrder,
      includeInProductivityClassification:
        dto.includeInProductivityClassification ?? true,
      notes: dto.notes,
    });

    const savedLot = await this.fieldLotRepository.save(lot);

    await this.recalculateTotalAreaHa(fieldId);

    return savedLot;
  }

  /**
   * Elimina físicamente un lote interno (GEOMETRY-1). Es seguro: los
   * análisis ya generados guardan su propia copia de `fieldLots`/`zones` en
   * `resultJson` y no tienen una relación de base de datos hacia
   * `field_lots` (Analysis.lotId es un campo histórico de texto libre, sin
   * FK), así que borrar un lote no afecta diagnósticos ya calculados.
   */
  async removeLot(
    fieldId: string,
    lotId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.findOne(fieldId, userId);

    const lot = await this.fieldLotRepository.findOne({
      where: { id: lotId },
    });

    if (!lot || lot.fieldId !== fieldId) {
      throw new NotFoundException(
        'El lote no existe o no pertenece a este campo.',
      );
    }

    await this.fieldLotRepository.delete(lotId);
    await this.recalculateTotalAreaHa(fieldId);

    return { success: true };
  }

  /**
   * Valida mínimamente la forma del polígono: Polygon/MultiPolygon (bare o
   * envueltos en Feature/FeatureCollection), con al menos un anillo de 3
   * vértices distintos (4 posiciones contando el cierre). `@Allow()` en el
   * DTO no valida estructura, así que este chequeo corre en el service antes
   * de persistir.
   */
  private validateLotGeojson(geojson: unknown): void {
    if (!this.isValidGeojsonGeometry(geojson)) {
      throw new BadRequestException('El polígono del lote no es válido.');
    }
  }

  private isValidRing(ring: unknown): boolean {
    return (
      Array.isArray(ring) &&
      ring.length >= 4 &&
      ring.every(
        (point) =>
          Array.isArray(point) &&
          point.length >= 2 &&
          typeof point[0] === 'number' &&
          typeof point[1] === 'number',
      )
    );
  }

  private isValidPolygonGeometry(geometry: unknown): boolean {
    const value = geometry as { type?: string; coordinates?: unknown } | null;

    if (!value || typeof value !== 'object') {
      return false;
    }

    if (value.type === 'Polygon') {
      const coordinates = value.coordinates as unknown[];
      return Array.isArray(coordinates) && coordinates.length > 0 && this.isValidRing(coordinates[0]);
    }

    if (value.type === 'MultiPolygon') {
      const coordinates = value.coordinates as unknown[];
      return (
        Array.isArray(coordinates) &&
        coordinates.length > 0 &&
        coordinates.every(
          (polygon) => Array.isArray(polygon) && polygon.length > 0 && this.isValidRing(polygon[0]),
        )
      );
    }

    return false;
  }

  private isValidGeojsonGeometry(geojson: unknown): boolean {
    const value = geojson as { type?: string; geometry?: unknown; features?: unknown[] } | null;

    if (!value || typeof value !== 'object') {
      return false;
    }

    if (value.type === 'Feature') {
      return this.isValidPolygonGeometry(value.geometry);
    }

    if (value.type === 'FeatureCollection') {
      return (
        Array.isArray(value.features) &&
        value.features.length > 0 &&
        value.features.every((feature) =>
          this.isValidPolygonGeometry((feature as { geometry?: unknown })?.geometry),
        )
      );
    }

    return this.isValidPolygonGeometry(value);
  }

  /**
   * `Field.totalAreaHa` se calcula al crear el campo sumando la superficie de
   * referencia de cada lote; si se edita esa superficie después, la
   * recalculamos para que el total no quede desactualizado/falso.
   */
  private async recalculateTotalAreaHa(fieldId: string): Promise<void> {
    const lots = await this.fieldLotRepository.find({ where: { fieldId } });
    const totalAreaHa = lots.reduce(
      (acc, lot) => acc + Number(lot.areaHa || 0),
      0,
    );

    await this.fieldRepository.update(fieldId, { totalAreaHa });
  }

  async getPipelineInput(id: string): Promise<FieldPipelineInput> {
    const field = await this.findByIdOrFail(id);

    if (!field.lots?.length) {
      throw new NotFoundException('El campo no tiene lotes internos cargados.');
    }

    return {
      fieldId: field.id,
      name: field.name,
      location: field.location,
      totalAreaHa: field.totalAreaHa,
      lots: field.lots.map((lot) => ({
        id: lot.id,
        name: lot.name,
        geojson: lot.geojson,
        areaHa: lot.areaHa,
        includeInProductivityClassification:
          lot.includeInProductivityClassification,
      })),
    };
  }
}
