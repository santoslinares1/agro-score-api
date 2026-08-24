import {
  computeNextRunAt,
  DEFAULT_SCHEDULE_TIMEZONE,
  resolveScheduledForDate,
  resolveTimezoneOffsetMinutes,
} from './schedule-time.util';

const CORDOBA_OFFSET_MIN = -180;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function localWeekday(date: Date, offsetMinutes: number): number {
  return new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE).getUTCDay();
}

function localHourMinute(date: Date, offsetMinutes: number): { hour: number; minute: number } {
  const local = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

describe('schedule-time.util', () => {
  const schedule = { dayOfWeek: 1, hour: 9, minute: 0, timezone: DEFAULT_SCHEDULE_TIMEZONE };

  describe('computeNextRunAt', () => {
    it('devuelve un instante cuyo día/hora local coincide con el schedule (lunes 9:00 Córdoba)', () => {
      const from = new Date('2026-03-10T15:23:00Z');
      const next = computeNextRunAt(from, schedule);

      expect(localWeekday(next, CORDOBA_OFFSET_MIN)).toBe(1);
      expect(localHourMinute(next, CORDOBA_OFFSET_MIN)).toEqual({ hour: 9, minute: 0 });
    });

    it('siempre devuelve un instante estrictamente posterior a from', () => {
      const from = new Date('2026-03-10T15:23:00Z');
      expect(computeNextRunAt(from, schedule).getTime()).toBeGreaterThan(from.getTime());
    });

    it('nunca queda a más de 7 días de from', () => {
      const from = new Date('2026-03-10T15:23:00Z');
      const next = computeNextRunAt(from, schedule);
      expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(7 * MS_PER_DAY);
    });

    it('si from cae exactamente en el instante objetivo, salta a la semana siguiente (no repite el mismo tick)', () => {
      const first = computeNextRunAt(new Date('2026-03-10T15:23:00Z'), schedule);
      const second = computeNextRunAt(first, schedule);
      expect(second.getTime() - first.getTime()).toBe(7 * MS_PER_DAY);
    });

    it('encadenar resultados avanza de a exactamente 7 días cada vez', () => {
      let current = computeNextRunAt(new Date('2026-01-01T00:00:00Z'), schedule);

      for (let i = 0; i < 4; i++) {
        const next = computeNextRunAt(current, schedule);
        expect(next.getTime() - current.getTime()).toBe(7 * MS_PER_DAY);
        current = next;
      }
    });

    it('tira un error claro para una timezone no soportada (sin librería de tz, ver docstring)', () => {
      expect(() =>
        computeNextRunAt(new Date(), { ...schedule, timezone: 'Europe/Madrid' }),
      ).toThrow(/no soportada/);
    });
  });

  describe('resolveScheduledForDate', () => {
    const arbitrary = new Date('2026-03-12T22:10:00Z');

    it('devuelve una fecha cuyo día de semana local coincide con dayOfWeek', () => {
      const result = resolveScheduledForDate(arbitrary, schedule);
      const resultAtNoonUtc = new Date(`${result}T12:00:00Z`);
      expect(resultAtNoonUtc.getUTCDay()).toBe(schedule.dayOfWeek);
    });

    it('agrupa cualquier momento dentro de la misma semana calendario bajo el mismo scheduledFor', () => {
      const anchor = resolveScheduledForDate(arbitrary, schedule);
      const anchorAsDate = new Date(`${anchor}T00:00:00Z`);

      // +6 días sigue perteneciendo a la misma semana calendario que el anchor.
      const sameWeekLater = new Date(anchorAsDate.getTime() + 6 * MS_PER_DAY + 3 * 60 * 60 * 1000);
      expect(resolveScheduledForDate(sameWeekLater, schedule)).toBe(anchor);
    });

    it('la semana siguiente da un scheduledFor distinto (7 días después)', () => {
      const anchor = resolveScheduledForDate(arbitrary, schedule);
      const anchorAsDate = new Date(`${anchor}T00:00:00Z`);

      const nextWeek = new Date(anchorAsDate.getTime() + 7 * MS_PER_DAY + 3 * 60 * 60 * 1000);
      const nextAnchor = resolveScheduledForDate(nextWeek, schedule);

      expect(nextAnchor).not.toBe(anchor);
      expect(new Date(`${nextAnchor}T00:00:00Z`).getTime() - anchorAsDate.getTime()).toBe(7 * MS_PER_DAY);
    });
  });

  describe('resolveTimezoneOffsetMinutes', () => {
    it('resuelve las zonas soportadas', () => {
      expect(resolveTimezoneOffsetMinutes('America/Argentina/Cordoba')).toBe(-180);
      expect(resolveTimezoneOffsetMinutes('UTC')).toBe(0);
    });

    it('tira un error claro para una zona no soportada', () => {
      expect(() => resolveTimezoneOffsetMinutes('Asia/Tokyo')).toThrow(/no soportada/);
    });
  });
});
