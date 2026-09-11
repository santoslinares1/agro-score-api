import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { FieldsService } from '../fields/fields.service';
import { UpsertFieldAnalysisScheduleDto } from './dto/upsert-field-analysis-schedule.dto';
import { FieldAnalysisSchedule } from './entities/field-analysis-schedule.entity';
import { FieldAnalysisScheduleStatusTransition } from './entities/field-analysis-schedule-status-transition.entity';
import { computeNextRunAt, DEFAULT_SCHEDULE_TIMEZONE } from './schedule-time.util';

const DEFAULT_DAY_OF_WEEK = 1;
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

// Solo cubre la carrera real de "crear el schedule de un mismo campo dos veces a la vez" (ver
// upsert): un puñado de reintentos alcanza porque cada uno serializa contra la ganadora anterior
// (ver comentario de isUniqueViolation más abajo) — nunca es un polling ni un backoff de red.
const MAX_CREATE_RACE_RETRIES = 3;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505',
  );
}

/**
 * CRUD de FieldAnalysisSchedule (config del seguimiento automático). No ejecuta nada — eso es
 * responsabilidad de ScheduledAnalysisRunnerService. Un campo tiene a lo sumo un schedule
 * (unique(fieldId) en la migración): "crear" acá siempre es upsert sobre esa fila.
 *
 * Gap P0 (auditoría de KPIs, "denominador histórico de campos esperados"): `enabled` vivía
 * SOLAMENTE en esa única fila mutable — reactivar/desactivar pisaba el mismo valor sin dejar
 * rastro, así que no había forma de reconstruir qué campos estuvieron habilitados en una semana
 * pasada. `upsert` es, confirmado, el ÚNICO writer de `enabled` en todo el repo (el runner y el
 * admin lo leen, nunca lo escriben — ver field-analysis-schedule-status-transition.entity.ts) así
 * que es el único lugar que necesita escribir el historial. Cada llamada ahora corre dentro de una
 * transacción que:
 *   1. toma `SELECT ... FOR UPDATE` sobre la fila existente del campo (si hay) — serializa
 *      cualquier upsert concurrente sobre el MISMO schedule contra el último estado confirmado,
 *      nunca contra una lectura stale.
 *   2. escribe el schedule (create o update) y, si el `enabled` efectivo cambió (o es la creación
 *      inicial), inserta la fila de transición — ambas escrituras se confirman o revierten juntas.
 * La única carrera que `SELECT ... FOR UPDATE` no cierra por sí sola es "crear el schedule de un
 * campo que todavía no tiene fila, dos veces a la vez" (nada que lockear todavía) — ahí el UNIQUE
 * de `fieldId` es el árbitro final: Postgres serializa el segundo INSERT contra el primero a nivel
 * de índice, y si pierde la carrera, reintenta la operación completa (ahora sí encuentra la fila y
 * toma el camino de "update", con el mismo efecto neto de idempotencia semántica).
 */
@Injectable()
export class FieldAnalysisScheduleService {
  // Sin @InjectRepository propio para FieldAnalysisScheduleStatusTransition: es append-only y su
  // ÚNICA escritura ocurre dentro de la transacción de upsertWithinTransaction, vía
  // `manager.getRepository(...)` (tiene que ser el repositorio DEL manager transaccional, nunca
  // uno inyectado por fuera — de lo contrario la escritura de la transición no compartiría la
  // transacción con la del schedule). TypeOrmModule.forFeature en el módulo ya la registra para
  // que el DataSource conozca su metadata (autoLoadEntities), que es lo único que
  // `manager.getRepository` necesita.
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

    return this.upsertWithCreateRaceRetry(fieldId, dto, userId, MAX_CREATE_RACE_RETRIES);
  }

  private async upsertWithCreateRaceRetry(
    fieldId: string,
    dto: UpsertFieldAnalysisScheduleDto,
    userId: string,
    attemptsLeft: number,
  ): Promise<FieldAnalysisSchedule> {
    try {
      return await this.scheduleRepository.manager.transaction((manager) =>
        this.upsertWithinTransaction(manager, fieldId, dto, userId),
      );
    } catch (error) {
      // La transacción completa (schedule + transición) ya revirtió sola — reintentar desde cero
      // arranca una transacción nueva que, esta vez, SÍ va a encontrar la fila que ganó la carrera
      // (ver docstring de la clase). Nunca se reintenta dentro de la misma transacción: un
      // unique_violation deja la transacción de Postgres abortada para cualquier sentencia
      // posterior, no solo para la que falló.
      if (attemptsLeft > 0 && isUniqueViolation(error)) {
        return this.upsertWithCreateRaceRetry(fieldId, dto, userId, attemptsLeft - 1);
      }
      throw error;
    }
  }

  private async upsertWithinTransaction(
    manager: EntityManager,
    fieldId: string,
    dto: UpsertFieldAnalysisScheduleDto,
    userId: string,
  ): Promise<FieldAnalysisSchedule> {
    const scheduleRepo = manager.getRepository(FieldAnalysisSchedule);
    const transitionRepo = manager.getRepository(FieldAnalysisScheduleStatusTransition);

    // pessimistic_write = SELECT ... FOR UPDATE: cualquier otro upsert concurrente sobre ESTE
    // fieldId queda bloqueado acá hasta que esta transacción confirme o revierta, y al desbloquear
    // vuelve a leer el estado YA confirmado — nunca compara contra una lectura tomada antes de que
    // la otra transacción terminara.
    const existing = await scheduleRepo.findOne({
      where: { fieldId },
      lock: { mode: 'pessimistic_write' },
    });

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

    const effectiveAt = new Date();

    if (existing) {
      // Idempotencia SEMÁNTICA, no por proximidad temporal: solo se inserta transición si el
      // `enabled` efectivo realmente cambió respecto del último estado confirmado (capturado ACÁ,
      // antes del update). Un reintento HTTP idéntico, un doble click, o un upsert que solo toca
      // horario/flags con el mismo `enabled` (u `enabled` omitido) nunca agregan fila.
      const enabledChanged = existing.enabled !== enabled;

      await scheduleRepo.update(existing.id, fields);

      if (enabledChanged) {
        await transitionRepo.insert({
          scheduleId: existing.id,
          fieldId,
          enabled,
          effectiveAt,
          source: 'schedule_upsert',
          actorUserId: userId,
        });
      }

      return scheduleRepo.findOneByOrFail({ id: existing.id });
    }

    const created = await scheduleRepo.save(
      scheduleRepo.create({
        fieldId,
        userId,
        ...fields,
      }),
    );

    // Estado inicial del schedule — SIEMPRE se registra, sin importar si nace habilitado o
    // deshabilitado (ver "Registrar" #1 del ticket).
    await transitionRepo.insert({
      scheduleId: created.id,
      fieldId,
      enabled,
      effectiveAt,
      source: 'schedule_upsert',
      actorUserId: userId,
    });

    return created;
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
