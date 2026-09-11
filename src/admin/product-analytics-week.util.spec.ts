import {
  endOfDayInstant,
  localTimeInstant,
  resolveCalendarWeek,
  resolveCalendarWeekFromDateOnly,
  resolveLastCompleteCalendarWeek,
  shiftCalendarWeek,
  startOfDayInstant,
} from './product-analytics-week.util';

describe('product-analytics-week.util', () => {
  describe('resolveCalendarWeek', () => {
    it('un martes cae en la semana lunes-domingo que lo contiene', () => {
      // 2026-09-08 es martes.
      const result = resolveCalendarWeek(
        new Date('2026-09-08T15:00:00Z'),
        'UTC',
      );
      expect(result).toEqual({
        weekStart: '2026-09-07',
        weekEnd: '2026-09-13',
      });
    });

    it('un lunes es el propio weekStart de su semana', () => {
      const result = resolveCalendarWeek(
        new Date('2026-09-07T00:00:01Z'),
        'UTC',
      );
      expect(result).toEqual({
        weekStart: '2026-09-07',
        weekEnd: '2026-09-13',
      });
    });

    it('un domingo es el propio weekEnd de su semana (no la semana siguiente)', () => {
      const result = resolveCalendarWeek(
        new Date('2026-09-13T23:59:59Z'),
        'UTC',
      );
      expect(result).toEqual({
        weekStart: '2026-09-07',
        weekEnd: '2026-09-13',
      });
    });

    it('aplica el offset de timezone antes de resolver el día calendario (America/Argentina/Cordoba, UTC-3)', () => {
      // 2026-09-07T01:30:00Z es lunes en UTC, pero 2026-09-06 22:30 en Cordoba (domingo todavía).
      const result = resolveCalendarWeek(
        new Date('2026-09-07T01:30:00Z'),
        'America/Argentina/Cordoba',
      );
      expect(result).toEqual({
        weekStart: '2026-08-31',
        weekEnd: '2026-09-06',
      });
    });
  });

  describe('resolveCalendarWeekFromDateOnly', () => {
    it('resuelve la semana lunes-domingo de una fecha de calendario, sin conversión de timezone', () => {
      // 2026-09-08 es martes.
      expect(resolveCalendarWeekFromDateOnly('2026-09-08')).toEqual({
        weekStart: '2026-09-07',
        weekEnd: '2026-09-13',
      });
    });

    it('un lunes NO se corre a la semana anterior (a diferencia de pasar T00:00:00Z por resolveCalendarWeek con timezone UTC-3, que sí cruzaría medianoche)', () => {
      // 2026-09-07 es lunes. resolveCalendarWeek(new Date('2026-09-07T00:00:00Z'), 'America/Argentina/Cordoba')
      // interpretaría esto como 2026-09-06 21:00 local (domingo) — ver el test de resolveCalendarWeek
      // más arriba con offset. Esta función nunca pasa por esa conversión.
      expect(resolveCalendarWeekFromDateOnly('2026-09-07')).toEqual({
        weekStart: '2026-09-07',
        weekEnd: '2026-09-13',
      });
    });
  });

  describe('shiftCalendarWeek', () => {
    it('+1 avanza exactamente 7 días manteniendo lunes-domingo', () => {
      const week = { weekStart: '2026-09-07', weekEnd: '2026-09-13' };
      expect(shiftCalendarWeek(week, 1)).toEqual({
        weekStart: '2026-09-14',
        weekEnd: '2026-09-20',
      });
    });

    it('-1 retrocede exactamente 7 días', () => {
      const week = { weekStart: '2026-09-07', weekEnd: '2026-09-13' };
      expect(shiftCalendarWeek(week, -1)).toEqual({
        weekStart: '2026-08-31',
        weekEnd: '2026-09-06',
      });
    });
  });

  describe('resolveLastCompleteCalendarWeek', () => {
    it('nunca devuelve la semana en curso — un martes devuelve la semana anterior completa', () => {
      const result = resolveLastCompleteCalendarWeek(
        new Date('2026-09-08T15:00:00Z'),
        'UTC',
      );
      expect(result).toEqual({
        weekStart: '2026-08-31',
        weekEnd: '2026-09-06',
      });
    });
  });

  describe('endOfDayInstant', () => {
    it('convierte un día calendario a su instante 23:59:59.999 en la timezone dada (UTC)', () => {
      const instant = endOfDayInstant('2026-09-13', 'UTC');
      expect(instant.toISOString()).toBe('2026-09-13T23:59:59.999Z');
    });

    it('aplica el offset correcto para America/Argentina/Cordoba (UTC-3): el fin de día local ocurre 3h más tarde en UTC', () => {
      const instant = endOfDayInstant(
        '2026-09-13',
        'America/Argentina/Cordoba',
      );
      // 23:59:59.999 local (UTC-3) == 2026-09-14T02:59:59.999Z
      expect(instant.toISOString()).toBe('2026-09-14T02:59:59.999Z');
    });

    it('rechaza una fecha que no sea YYYY-MM-DD', () => {
      expect(() => endOfDayInstant('2026/09/13', 'UTC')).toThrow();
    });
  });

  describe('startOfDayInstant', () => {
    it('convierte un día calendario a su instante 00:00:00.000 en la timezone dada (UTC)', () => {
      const instant = startOfDayInstant('2026-09-07', 'UTC');
      expect(instant.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    });

    it('aplica el offset correcto para America/Argentina/Cordoba (UTC-3)', () => {
      const instant = startOfDayInstant(
        '2026-09-07',
        'America/Argentina/Cordoba',
      );
      expect(instant.toISOString()).toBe('2026-09-07T03:00:00.000Z');
    });

    it('es siempre anterior al endOfDayInstant del mismo día', () => {
      const start = startOfDayInstant(
        '2026-09-07',
        'America/Argentina/Cordoba',
      );
      const end = endOfDayInstant('2026-09-07', 'America/Argentina/Cordoba');
      expect(start.getTime()).toBeLessThan(end.getTime());
    });
  });

  describe('localTimeInstant', () => {
    it('convierte una hora local arbitraria (no solo 00:00/23:59) a su instante UTC (UTC)', () => {
      const instant = localTimeInstant('2026-09-07', 9, 0, 'UTC');
      expect(instant.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    });

    it('aplica el offset correcto para America/Argentina/Cordoba (UTC-3) — lunes 09:00 local = 12:00 UTC', () => {
      const instant = localTimeInstant(
        '2026-09-07',
        9,
        0,
        'America/Argentina/Cordoba',
      );
      expect(instant.toISOString()).toBe('2026-09-07T12:00:00.000Z');
    });

    it('coincide con startOfDayInstant/endOfDayInstant en sus extremos (0:00 y 23:59)', () => {
      expect(
        localTimeInstant(
          '2026-09-07',
          0,
          0,
          'America/Argentina/Cordoba',
        ).getTime(),
      ).toBe(
        startOfDayInstant('2026-09-07', 'America/Argentina/Cordoba').getTime(),
      );
      // endOfDayInstant usa 23:59:59.999, localTimeInstant siempre :00.000 — comparar solo el
      // minuto 23:59 (sin milisegundos) para no acoplar los dos contratos innecesariamente.
      const viaLocalTime = localTimeInstant(
        '2026-09-07',
        23,
        59,
        'America/Argentina/Cordoba',
      );
      const viaEndOfDay = endOfDayInstant(
        '2026-09-07',
        'America/Argentina/Cordoba',
      );
      expect(viaEndOfDay.getTime() - viaLocalTime.getTime()).toBe(59_999);
    });

    it('rechaza una fecha que no sea YYYY-MM-DD', () => {
      expect(() => localTimeInstant('2026/09/07', 9, 0, 'UTC')).toThrow();
    });

    it('rechaza una hora fuera de 0-23', () => {
      expect(() => localTimeInstant('2026-09-07', 24, 0, 'UTC')).toThrow();
      expect(() => localTimeInstant('2026-09-07', -1, 0, 'UTC')).toThrow();
    });

    it('rechaza un minuto fuera de 0-59', () => {
      expect(() => localTimeInstant('2026-09-07', 9, 60, 'UTC')).toThrow();
      expect(() => localTimeInstant('2026-09-07', 9, -1, 'UTC')).toThrow();
    });
  });
});
