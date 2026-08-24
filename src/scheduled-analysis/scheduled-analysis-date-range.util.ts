import { DEFAULT_SCHEDULE_TIMEZONE, resolveTimezoneOffsetMinutes } from './schedule-time.util';

export type ScheduledAnalysisDateRangeSource = 'rolling_7_days';

export interface ScheduledAnalysisDateRange {
  startDate: string;
  endDate: string;
  source: ScheduledAnalysisDateRangeSource;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * Fase 4D-fix (decisión de producto): el informe semanal por email cubre exactamente la última
 * semana, no una ventana amplia de campaña — Fase 4D había usado 180 días para simplemente dejar
 * de reusar field.startDate/endDate estáticos, pero eso no coincidía con "semanal". Corregido acá
 * a 7 días.
 */
export const SCHEDULED_ANALYSIS_WINDOW_DAYS = 7;

/** Límite real del pipeline (ver PythonWorkerService) — ninguna ventana calculada acá debe
 * poder superarlo, sin importar qué windowDays se pida. */
export const SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS = 366;

/**
 * Mismo truco de offset fijo que schedule-time.util.ts (Argentina no observa horario de verano
 * desde 2009): desplaza el instante UTC por el offset de la zona y lee los componentes UTC del
 * resultado como si fueran hora de pared local. Formato YYYY-MM-DD — el que ya usan
 * Field.startDate/endDate (columnas `type: 'date'`) y el que espera
 * AnalysisService.runFieldAnalysis.
 */
function toLocalDateString(date: Date, offsetMinutes: number): string {
  const local = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
  return local.toISOString().slice(0, 10);
}

/**
 * Fase 4D-fix: ventana semanal estricta para el análisis automático de scheduled-analysis —
 * reemplaza el uso de field.startDate/endDate estáticos (que nunca avanzaban, ver auditoría
 * predeploy) para TODO trigger de esta feature, automático o "Ejecutar ahora". Función pura,
 * sin I/O: nunca toca el flujo manual (field-detail.component.ts → POST /analysis/field/:fieldId
 * sigue mandando las fechas que el usuario elige en su propio modal, sin relación con esto). No
 * garantiza que haya imagen Sentinel-2 útil dentro de esos 7 días — si no la hay, el pipeline
 * actual ya refleja esa limitación con sus propios mecanismos, esto no inventa nada.
 */
export function computeScheduledAnalysisDateRange(
  now: Date,
  options?: { timezone?: string; windowDays?: number },
): ScheduledAnalysisDateRange {
  const timezone = options?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const windowDays = options?.windowDays ?? SCHEDULED_ANALYSIS_WINDOW_DAYS;

  if (windowDays > SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS) {
    throw new Error(
      `La ventana móvil de scheduled-analysis no puede superar ${SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS} días ` +
        `(límite del worker) — se pidieron ${windowDays}.`,
    );
  }

  const offsetMinutes = resolveTimezoneOffsetMinutes(timezone);

  const endDate = toLocalDateString(now, offsetMinutes);
  const startDate = toLocalDateString(new Date(now.getTime() - windowDays * MS_PER_DAY), offsetMinutes);

  return { startDate, endDate, source: 'rolling_7_days' };
}
