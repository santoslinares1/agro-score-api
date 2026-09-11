import {
  DEFAULT_SCHEDULE_TIMEZONE,
  resolveTimezoneOffsetMinutes,
} from '../scheduled-analysis/schedule-time.util';

/**
 * KPIs P0 (auditoría de KPIs + Decision 1/2): North Star, retención semanal y el breakdown de
 * calidad necesitan una "semana" ÚNICA y consistente para agregar entre campos — pero
 * `WeeklyAnalysisSnapshot.weekStart/weekEnd` es una ventana MÓVIL de 7 días anclada al
 * `dayOfWeek`/`hour`/`timezone` de CADA schedule (ver computeScheduledAnalysisDateRange /
 * schedule-time.util.ts), así que dos campos con schedules en días distintos nunca comparten el
 * mismo weekStart/weekEnd exacto aunque hayan corrido "la misma semana calendario".
 *
 * Esta utilidad define la semana CALENDARIO canónica (lunes a domingo, mismo timezone default que
 * ya usa el resto de scheduled-analysis — sin DST, mismo truco de offset fijo que
 * schedule-time.util.ts) que se usa SOLO para agrupar/reportar KPIs: un snapshot se atribuye a la
 * semana calendario en la que cae su `weekEnd` (el día en que efectivamente se completó esa
 * corrida), no a su propia ventana de 7 días. No reemplaza ni modifica `weekStart/weekEnd` del
 * snapshot en ningún lado — es una lectura, nunca una escritura.
 */
export interface CalendarWeek {
  /** YYYY-MM-DD, lunes de la semana. */
  weekStart: string;
  /** YYYY-MM-DD, domingo de la semana. */
  weekEnd: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDateOnly(dateOnly: string): void {
  if (!DATE_ONLY_PATTERN.test(dateOnly)) {
    throw new Error(`Fecha inválida (se esperaba YYYY-MM-DD): "${dateOnly}".`);
  }
}

/** Fecha YYYY-MM-DD interpretada como un calendario "puro" (sin hora) — mismo truco que
 * schedule-time.util.ts/scheduled-analysis-date-range.util.ts: los componentes UTC de este Date
 * se leen como si fueran la fecha de pared, nunca como un instante real. */
function parseDateOnly(dateOnly: string): Date {
  assertDateOnly(dateOnly);
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

function formatDateOnly(dateOnly: Date): string {
  return dateOnly.toISOString().slice(0, 10);
}

/** Mismo desplazamiento por offset fijo que toLocalDateString en scheduled-analysis-date-range.util.ts
 * (duplicado deliberado, chico y ya replicado en ese archivo — no se refactoriza un export
 * compartido nuevo para dos líneas de aritmética, ver el mismo patrón ahí). */
function instantToLocalDateOnly(instant: Date, offsetMinutes: number): Date {
  const local = new Date(instant.getTime() + offsetMinutes * MS_PER_MINUTE);
  return parseDateOnly(formatDateOnly(local));
}

function mondayOf(dateOnly: Date): Date {
  const dayOfWeek = dateOnly.getUTCDay(); // 0=domingo … 6=sábado
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return new Date(dateOnly.getTime() - diffToMonday * MS_PER_DAY);
}

function weekFromMonday(monday: Date): CalendarWeek {
  const sunday = new Date(monday.getTime() + 6 * MS_PER_DAY);
  return { weekStart: formatDateOnly(monday), weekEnd: formatDateOnly(sunday) };
}

/** Semana calendario (lunes-domingo) que contiene `reference`, en `timezone`. */
export function resolveCalendarWeek(
  reference: Date,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): CalendarWeek {
  const offset = resolveTimezoneOffsetMinutes(timezone);
  const localDateOnly = instantToLocalDateOnly(reference, offset);
  return weekFromMonday(mondayOf(localDateOnly));
}

/**
 * Semana calendario que contiene `dateOnly` (YYYY-MM-DD) — SIN pasar por ninguna conversión de
 * instante/timezone, a propósito: `dateOnly` ya es una fecha de calendario inequívoca (ej. el
 * `week` que manda el query param del endpoint), y convertirla primero a un instante UTC y después
 * reinterpretarla en `timezone` (como hace `resolveCalendarWeek`) puede correrla un día si el
 * offset cruza medianoche — justo el bug que esta función evita.
 */
export function resolveCalendarWeekFromDateOnly(
  dateOnly: string,
): CalendarWeek {
  return weekFromMonday(mondayOf(parseDateOnly(dateOnly)));
}

export function shiftCalendarWeek(
  week: CalendarWeek,
  weeks: number,
): CalendarWeek {
  const monday = parseDateOnly(week.weekStart);
  const shiftedMonday = new Date(monday.getTime() + weeks * 7 * MS_PER_DAY);
  return weekFromMonday(shiftedMonday);
}

/**
 * Semana calendario COMPLETA más reciente antes de `now` — nunca la semana en curso (todavía no
 * terminó, así que North Star/retención/calidad para ella estarían necesariamente incompletos).
 * Es el default cuando el caller no pide una semana explícita.
 */
export function resolveLastCompleteCalendarWeek(
  now: Date,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): CalendarWeek {
  return shiftCalendarWeek(resolveCalendarWeek(now, timezone), -1);
}

/**
 * Instante UTC real de "fin de ese día calendario" (23:59:59.999) EN `timezone` — usado para
 * reconstruir, vía field_analysis_schedule_status_transitions, el estado `enabled` efectivo de
 * cada schedule "al cierre de la semana" (ver FieldAnalysisScheduleStatusTransition, ticket
 * anterior: el estado efectivo en un instante es la transición más reciente con
 * effectiveAt <= ese instante).
 */
export function endOfDayInstant(
  dateOnly: string,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): Date {
  assertDateOnly(dateOnly);
  const offset = resolveTimezoneOffsetMinutes(timezone);
  const localEndOfDay = new Date(`${dateOnly}T23:59:59.999Z`);
  // Mismo signo que `toUtc` en schedule-time.util.ts: local - offset = UTC real.
  return new Date(localEndOfDay.getTime() - offset * MS_PER_MINUTE);
}

/** Simétrico a `endOfDayInstant` (00:00:00.000 local) — usado para verificar si TODA una semana
 * calendario cae dentro de la cobertura confiable del historial de schedules (ver
 * `coverage.scheduleHistory` en AdminProductAnalyticsDto): más conservador que chequear solo el
 * instante de evaluación (weekEnd), a propósito. */
export function startOfDayInstant(
  dateOnly: string,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): Date {
  assertDateOnly(dateOnly);
  const offset = resolveTimezoneOffsetMinutes(timezone);
  const localStartOfDay = new Date(`${dateOnly}T00:00:00.000Z`);
  return new Date(localStartOfDay.getTime() - offset * MS_PER_MINUTE);
}

/**
 * Instante UTC real de un HH:mm local específico (no solo 00:00/23:59) EN `timezone`, para
 * `dateOnly` — generalización de `endOfDayInstant`/`startOfDayInstant`. Building block genérico:
 * QUÉ hora local representa un "cutoff" de producto (ej. el lunes 09:00 de North Star, ver
 * PRODUCT_ANALYTICS_CANONICAL_CUTOFF en admin.service.ts) es una decisión del caller, no de esta
 * utilidad.
 */
export function localTimeInstant(
  dateOnly: string,
  hour: number,
  minute: number,
  timezone: string = DEFAULT_SCHEDULE_TIMEZONE,
): Date {
  assertDateOnly(dateOnly);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Hora inválida (se esperaba 0-23): ${hour}.`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Minuto inválido (se esperaba 0-59): ${minute}.`);
  }
  const offset = resolveTimezoneOffsetMinutes(timezone);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const localInstant = new Date(`${dateOnly}T${hh}:${mm}:00.000Z`);
  return new Date(localInstant.getTime() - offset * MS_PER_MINUTE);
}
