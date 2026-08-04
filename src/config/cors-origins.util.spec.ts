import { resolveCorsOrigins } from './cors-origins.util';

describe('resolveCorsOrigins', () => {
  it('sin CORS_ORIGIN ni FRONTEND_URL, cae a localhost:4200 (dev)', () => {
    expect(resolveCorsOrigins(undefined, undefined)).toBe(
      'http://localhost:4200',
    );
  });

  it('sin CORS_ORIGIN, usa FRONTEND_URL como single-origin (compat dev)', () => {
    expect(resolveCorsOrigins(undefined, 'http://localhost:4200')).toBe(
      'http://localhost:4200',
    );
  });

  it('con CORS_ORIGIN de un solo origin, devuelve array de un elemento', () => {
    expect(resolveCorsOrigins('https://agroscorelatam.com', undefined)).toEqual(
      ['https://agroscorelatam.com'],
    );
  });

  it('con CORS_ORIGIN de varios origins separados por coma, devuelve array trimeado', () => {
    expect(
      resolveCorsOrigins(
        'https://agroscorelatam.com, https://www.agroscorelatam.com',
        undefined,
      ),
    ).toEqual([
      'https://agroscorelatam.com',
      'https://www.agroscorelatam.com',
    ]);
  });

  it('CORS_ORIGIN tiene prioridad sobre FRONTEND_URL si ambas están seteadas', () => {
    expect(
      resolveCorsOrigins(
        'https://agroscorelatam.com',
        'http://localhost:4200',
      ),
    ).toEqual(['https://agroscorelatam.com']);
  });

  it('CORS_ORIGIN vacía o solo comas se ignora y cae a FRONTEND_URL', () => {
    expect(resolveCorsOrigins('', 'http://localhost:4200')).toBe(
      'http://localhost:4200',
    );
    expect(resolveCorsOrigins(' , , ', 'http://localhost:4200')).toBe(
      'http://localhost:4200',
    );
  });
});
