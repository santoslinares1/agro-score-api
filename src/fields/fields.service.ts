import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateFieldDto, CreateFieldLotDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { UpdateFieldLotDto } from './dto/update-field-lot.dto';
import { Field } from './entities/field.entity';
import { FieldLot } from './entities/field-lot.entity';

/**
 * Resultado de clasificar el geojson de un lote contra el contrato geométrico soportado (ver
 * FieldsService.validateLotGeojson). `reason` distingue el tipo de incompatibilidad solo para
 * elegir el mensaje público correcto — nunca se expone el valor de `reason` tal cual al usuario.
 */
type LotGeometryValidation =
  | { valid: true }
  | { valid: false; reason: 'multipart' | 'holes' | 'invalid' };

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
    this.assertValidDateRange(dto.startDate, dto.endDate);

    // GEOMETRY-2 (RISK-001/RISK-002): valida CADA lote antes de construir/persistir cualquier
    // cosa — un Field con un solo lote incompatible no debe quedar parcialmente creado.
    dto.lots.forEach((lot) => this.validateLotGeojson(lot.geojson));

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
    // Lanza NotFoundException si el campo no existe o no es del usuario, antes de validar nada
    // más — un usuario sin acceso no debe recibir información distinta sobre este recurso según
    // el contenido del PATCH.
    const field = await this.findOne(id, userId);

    // RISK-052: un PATCH puede traer una sola fecha (o ninguna). Validar contra el DTO a secas
    // sería incorrecto acá (a diferencia de create(), donde ambas siempre llegan juntas) — hay
    // que resolver el PAR RESULTANTE combinando lo que llega con lo ya persistido, y solo si el
    // DTO efectivamente toca alguna de las dos fechas. Un PATCH que no las toca (p.ej. solo
    // `name`) nunca debe bloquearse por un rango histórico ya inválido.
    if (dto.startDate !== undefined || dto.endDate !== undefined) {
      const effectiveStartDate = dto.startDate ?? field.startDate;
      const effectiveEndDate = dto.endDate ?? field.endDate;
      this.assertValidDateRange(effectiveStartDate, effectiveEndDate);
    }

    await this.fieldRepository.update(id, dto);

    return this.findOne(id, userId);
  }

  /**
   * RISK-052: Field.startDate/Field.endDate representan un rango temporal real, no un instante
   * puntual — misma invariante que DEC-037 ya estableció para Analysis
   * (AnalysisService.runFieldAnalysis), extendida acá a su origen. Mismo mensaje textual a
   * propósito, para no introducir una segunda redacción de la misma regla de negocio.
   */
  private assertValidDateRange(startDate: string, endDate: string): void {
    if (new Date(startDate) >= new Date(endDate)) {
      throw new BadRequestException(
        'La fecha de inicio debe ser estrictamente anterior a la fecha de fin.',
      );
    }
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
   * GEOMETRY-2 (RISK-001/RISK-002, piloto): valida que el geojson de un lote pueda convertirse
   * FIELMENTE al contrato del Worker (PythonWorkerService.extractPolygonCoordinates /
   * LotInput.coordinates = un único ring plano), sin descartar silenciosamente ninguna parte de
   * la geometría. Único punto de entrada usado por create()/createLot()/updateLot() — no hay una
   * regla independiente por endpoint.
   *
   * Contrato soportado para el piloto:
   *   - Polygon bare con exactamente 1 ring (sin holes)
   *   - Feature<Polygon> con exactamente 1 ring
   *   - FeatureCollection con exactamente 1 Feature<Polygon> de 1 ring
   * Todo lo demás (MultiPolygon, GeometryCollection, FeatureCollection vacía o con 2+ features,
   * Polygon/Feature<Polygon> con 2+ rings, Point/LineString/etc.) se rechaza explícitamente en
   * vez de normalizarse/recortarse — jamás se elige "la primera" feature/ring en silencio.
   */
  private validateLotGeojson(geojson: unknown): void {
    const result = this.classifyLotGeometry(geojson);

    if (result.valid) {
      return;
    }

    if (result.reason === 'multipart') {
      throw new BadRequestException(
        'El polígono del lote no es válido: AgroScore admite por ahora un solo polígono continuo por lote.',
      );
    }

    if (result.reason === 'holes') {
      throw new BadRequestException(
        'El lote contiene áreas internas excluidas que AgroScore todavía no soporta. Usá por ahora un único contorno continuo.',
      );
    }

    throw new BadRequestException('El polígono del lote no es válido.');
  }

  private classifyLotGeometry(geojson: unknown): LotGeometryValidation {
    const value = geojson as
      | { type?: string; geometry?: unknown; features?: unknown[] }
      | null;

    if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
      return { valid: false, reason: 'invalid' };
    }

    if (value.type === 'Feature') {
      return this.classifyPolygonGeometry(value.geometry);
    }

    if (value.type === 'FeatureCollection') {
      const features = Array.isArray(value.features) ? value.features : [];

      // Nunca elegir "la primera" feature en silencio: 0 o 2+ features es un shape ambiguo/vacío
      // para representar UN FieldLot (distinto del importador de Web, que sí puede convertir una
      // FeatureCollection con varias features en varios LOTES separados — ver geojson-import.ts).
      if (features.length !== 1) {
        return { valid: false, reason: 'multipart' };
      }

      const feature = features[0] as { type?: string; geometry?: unknown } | null;

      if (!feature || feature.type !== 'Feature') {
        return { valid: false, reason: 'invalid' };
      }

      return this.classifyPolygonGeometry(feature.geometry);
    }

    // Geometría suelta (Polygon/MultiPolygon/GeometryCollection/Point/etc., sin wrapper).
    return this.classifyPolygonGeometry(value);
  }

  private classifyPolygonGeometry(geometry: unknown): LotGeometryValidation {
    const value = geometry as { type?: string; coordinates?: unknown } | null;

    if (!value || typeof value !== 'object') {
      return { valid: false, reason: 'invalid' };
    }

    if (value.type === 'MultiPolygon') {
      return { valid: false, reason: 'multipart' };
    }

    if (value.type !== 'Polygon') {
      // GeometryCollection, Point, MultiPoint, LineString, MultiLineString, etc. — ninguno se
      // puede representar fielmente como LotInput.coordinates.
      return { valid: false, reason: 'invalid' };
    }

    const rings = value.coordinates as unknown[];

    if (!Array.isArray(rings) || rings.length === 0) {
      return { valid: false, reason: 'invalid' };
    }

    // extractPolygonCoordinates() solo toma coordinates[0] — un Polygon con 2+ rings (holes)
    // perdería el resto de la geometría en silencio si se aceptara acá.
    if (rings.length > 1) {
      return { valid: false, reason: 'holes' };
    }

    if (!this.isValidRing(rings[0])) {
      return { valid: false, reason: 'invalid' };
    }

    return { valid: true };
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
          typeof point[1] === 'number' &&
          point[0] >= -180 &&
          point[0] <= 180 &&
          point[1] >= -90 &&
          point[1] <= 90,
      )
    );
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
