import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';
import { Lot } from './entities/lot.entity';

export type PipelineInput = {
  lotId: string;
  name: string;
  location: string;
  geojson: any;
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  areaHa: number;
};

@Injectable()
export class LotsService {
  constructor(
    @InjectRepository(Lot)
    private readonly lotsRepository: Repository<Lot>,
  ) {}

  async create(createLotDto: CreateLotDto): Promise<Lot> {
    const lot = this.lotsRepository.create({
      ...createLotDto,
      areaHa: this.estimateAreaHa(createLotDto.geojson),
      status: 'Sin análisis',
      score: 0,
    });

    return this.lotsRepository.save(lot);
  }

  async findAll(): Promise<Lot[]> {
    return this.lotsRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findOne(id: string): Promise<Lot> {
    const lot = await this.lotsRepository.findOne({
      where: { id },
    });

    if (!lot) {
      throw new NotFoundException('Lote no encontrado.');
    }

    return lot;
  }

  async update(id: string, updateLotDto: UpdateLotDto): Promise<Lot> {
    const lot = await this.findOne(id);

    Object.assign(lot, updateLotDto);

    return this.lotsRepository.save(lot);
  }

  async getPipelineInput(id: string): Promise<PipelineInput> {
    const lot = await this.findOne(id);

    if (!lot.geojson) {
      throw new NotFoundException('El lote no tiene GeoJSON cargado.');
    }

    return {
      lotId: lot.id,
      name: lot.name,
      location: lot.location,
      geojson: lot.geojson,
      startDate: lot.startDate,
      endDate: lot.endDate,
      maxCloudiness: lot.maxCloudiness,
      areaHa: lot.areaHa,
    };
  }

  async remove(id: string): Promise<void> {
    const lot = await this.findOne(id);
    await this.lotsRepository.remove(lot);
  }

  async markAsProcessing(id: string, analysisId: string): Promise<Lot> {
    const lot = await this.findOne(id);

    lot.status = 'Procesando';
    lot.lastAnalysisId = analysisId;
    lot.lastAnalysisStatus = 'Procesando';

    return this.lotsRepository.save(lot);
  }

  async markAsFinished(
    id: string,
    analysisId: string,
    score: number,
  ): Promise<Lot> {
    const lot = await this.findOne(id);

    lot.status = 'Finalizado';
    lot.lastAnalysisId = analysisId;
    lot.lastAnalysisStatus = 'Finalizado';
    lot.score = score;

    return this.lotsRepository.save(lot);
  }

  async markAsError(id: string, analysisId: string): Promise<Lot> {
    const lot = await this.findOne(id);

    lot.status = 'Sin análisis';
    lot.lastAnalysisId = analysisId;
    lot.lastAnalysisStatus = 'Error';

    return this.lotsRepository.save(lot);
  }

  private estimateAreaHa(geojson?: any): number {
    const coordinates = geojson?.geometry?.coordinates?.[0];

    if (!coordinates || coordinates.length < 3) {
      return 0;
    }

    return Math.floor(80 + Math.random() * 240);
  }
}
