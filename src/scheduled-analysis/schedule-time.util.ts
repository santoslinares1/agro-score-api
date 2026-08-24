/**
 * Aritmética de fechas para el scheduler (Fase 4A). No hay librería de zonas horarias instalada
 * en el proyecto (ni date-fns/luxon/dayjs) y Argentina no observa horario de verano desde 2009
 * — así que un offset fijo en minutos es exacto para las zonas soportadas hoy, sin necesitar una
 * base de datos IANA completa. Si algún día hace falta soportar una zona con DST, esto necesita
 * una librería real; documentado acá y en el error que tira resolveTimezoneOffsetMinutes.
 */
export const SUPPORTED_TIMEZONE_OFFSETS_MINUTES: Record<string, number> = {
  'America/Argentina/Cordoba': -180,
  'America/Argentina/Buenos_Aires': -180,
  UTC: 0,
};

export const DEFAULT_SCHEDULE_TIMEZONE = 'America/Argentina/Cordoba';

export function resolveTimezoneOffsetMinutes(timezone: string): number {
  const offset = SUPPORTED_TIMEZONE_OFFSETS_MINUTES[timezone];

  if (offset === undefined) {
    throw new Error(
      `Zona horaria no soportada para scheduling: "${timezone}". Soportadas: ` +
        `${Object.keys(SUPPORTED_TIMEZONE_OFFSETS_MINUTES).join(', ')}.`,
    );
  }

  return offset;
}

export interface WeeklyScheduleTime {
  /** 0=domingo … 1=lunes … 6=sábado, igual convención que Date.getUTCDay(). */
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
}

const MS_PER_MINUTE = 60_000;

/** Desplaza `date` por el offset de la zona: el resultado, leído con los getters UTC*, da la
 * hora de pared local de esa zona (truco válido porque solo trabajamos con offsets fijos). */
function toLocal(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
}

function toUtc(localDate: Date, offsetMinutes: number): Date {
  return new Date(localDate.getTime() - offsetMinutes * MS_PER_MINUTE);
}

/**
 * Próxima ocurrencia futura (estrictamente posterior a `from`) de dayOfWeek/hour/minute en la
 * zona horaria del schedule. Si `from` cae exactamente en el instante objetivo, salta a la
 * semana siguiente (nextRunAt nunca debe quedar clavado en el mismo tick que ya se procesó).
 */
export function computeNextRunAt(from: Date, schedule: WeeklyScheduleTime): Date {
  const offset = resolveTimezoneOffsetMinutes(schedule.timezone);
  const local = toLocal(from, offset);

  const candidate = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      schedule.hour,
      schedule.minute,
      0,
      0,
    ),
  );

  let dayDiff = schedule.dayOfWeek - candidate.getUTCDay();
  if (dayDiff < 0) {
    dayDiff += 7;
  }
  candidate.setUTCDate(candidate.getUTCDate() + dayDiff);

  if (candidate.getTime() <= local.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }

  return toUtc(candidate, offset);
}

/**
 * Fecha (YYYY-MM-DD) del `dayOfWeek` de la semana calendario a la que pertenece `at`, en la zona
 * horaria del schedule — clave de dedup semanal (ScheduledAnalysisRun.scheduledFor),
 * independiente de la hora exacta en que se disparó la corrida (automática a las 9:00, o manual
 * vía "Ejecutar ahora" en cualquier momento de esa misma semana).
 */
export function resolveScheduledForDate(
  at: Date,
  schedule: Pick<WeeklyScheduleTime, 'dayOfWeek' | 'timezone'>,
): string {
  const offset = resolveTimezoneOffsetMinutes(schedule.timezone);
  const local = toLocal(at, offset);

  let dayDiff = local.getUTCDay() - schedule.dayOfWeek;
  if (dayDiff < 0) {
    dayDiff += 7;
  }

  const anchor = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  anchor.setUTCDate(anchor.getUTCDate() - dayDiff);

  return anchor.toISOString().slice(0, 10);
}
