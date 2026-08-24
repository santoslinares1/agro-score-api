import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FieldsService } from '../fields/fields.service';
import { UpsertFieldAnalysisScheduleDto } from './dto/upsert-field-analysis-schedule.dto';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import { computeNextRunAt, DEFAULT_SCHEDULE_TIMEZONE } from './schedule-time.util';

const DEFAULT_DAY_OF_WEEK = 1;
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

/**
 * CRUD de FieldAnalysisSchedule (config del seguimiento automático). No ejecuta nada — eso es
 * responsabilidad de ScheduledAnalysisRunnerService. Un campo tiene a lo sumo un schedule
 * (unique(fieldId) en la migración): "crear" acá siempre es upsert sobre esa fila.
 */
@Injectable()
export class FieldAnalysisScheduleService {
  constructor(
    @InjectRepository(FieldAnalysisSchedule)
    private readonly scheduleRepository: Repository<FieldAnalysisSchedule>,
    private readonly fieldsService: FieldsService,
  ) {}

  async upsert(
    fieldId: string,
    dto: UpsertFieldAnalysisScheduleDto,
    userId: string,
  ): Promise<FieldAnalysisSchedule> {
    await this.fieldsService.findOne(fieldId, userId);

    const existing = await this.scheduleRepository.findOne({ where: { fieldId } });

    const enabled = dto.enabled ?? existing?.enabled ?? true;
    const dayOfWeek = dto.dayOfWeek ?? existing?.dayOfWeek ?? DEFAULT_DAY_OF_WEEK;
    const hour = dto.hour ?? existing?.hour ?? DEFAULT_HOUR;
    const minute = dto.minute ?? existing?.minute ?? DEFAULT_MINUTE;
    const timezone = dto.timezone ?? existing?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;

    // Desactivado: nextRunAt queda en null (no solo se ignora por `enabled=false`, así no hay un
    // timestamp viejo dando vueltas). Al reactivar, se recalcula fresco desde ahora — nunca
    // resucita un valor stale de una configuración anterior.
    const nextRunAt = enabled ? computeNextRunAt(new Date(), { dayOfWeek, hour, minute, timezone }) : null;

    const fields = {
      enabled,
      dayOfWeek,
      hour,
      minute,
      timezone,
      includeMapAssets: dto.includeMapAssets ?? existing?.includeMapAssets ?? true,
      includeIndexImages: dto.includeIndexImages ?? existing?.includeIndexImages ?? true,
      includeImageSeries: dto.includeImageSeries ?? existing?.includeImageSeries ?? true,
      nextRunAt,
    };

    if (existing) {
      await this.scheduleRepository.update(existing.id, fields);
      return this.get(fieldId, userId);
    }

    const created = this.scheduleRepository.create({
      fieldId,
      userId,
      ...fields,
    });

    return this.scheduleRepository.save(created);
  }

  async get(fieldId: string, userId: string): Promise<FieldAnalysisSchedule> {
    await this.fieldsService.findOne(fieldId, userId);

    const schedule = await this.scheduleRepository.findOne({ where: { fieldId } });

    if (!schedule) {
      throw new NotFoundException('Este campo todavía no tiene seguimiento automático configurado.');
    }

    return schedule;
  }

  /** Variante interna sin ownership, para el runner (procesa por scheduleId, no por request de un
   * usuario autenticado). */
  async findByIdOrFail(id: string): Promise<FieldAnalysisSchedule> {
    const schedule = await this.scheduleRepository.findOne({ where: { id } });

    if (!schedule) {
      throw new NotFoundException('Schedule no encontrado.');
    }

    return schedule;
  }
}
