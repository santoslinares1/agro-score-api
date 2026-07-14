import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateFieldDto } from './dto/create-field.dto';
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

  async create(dto: CreateFieldDto): Promise<Field> {
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

  async findAll(): Promise<Field[]> {
    return this.fieldRepository.find({
      relations: {
        lots: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findOne(id: string): Promise<Field> {
    const field = await this.fieldRepository.findOne({
      where: { id },
      relations: {
        lots: true,
      },
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
  async update(id: string, dto: UpdateFieldDto): Promise<Field> {
    await this.findOne(id);

    await this.fieldRepository.update(id, dto);

    return this.findOne(id);
  }

  /**
   * Edita metadata de un FieldLot puntual (nombre, superficie de referencia,
   * inclusión en clasificación productiva, notas, orden). No toca geojson:
   * la geometría no se redibuja desde este endpoint todavía.
   */
  async updateLot(
    fieldId: string,
    lotId: string,
    dto: UpdateFieldLotDto,
  ): Promise<FieldLot> {
    const lot = await this.fieldLotRepository.findOne({
      where: { id: lotId },
    });

    if (!lot || lot.fieldId !== fieldId) {
      throw new NotFoundException(
        'El lote no existe o no pertenece a este campo.',
      );
    }

    await this.fieldLotRepository.update(lotId, dto);

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
    const field = await this.findOne(id);

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
