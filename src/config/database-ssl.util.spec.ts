import { resolveDatabaseSsl } from './database-ssl.util';

describe('resolveDatabaseSsl', () => {
  it('devuelve false si DATABASE_SSL no está seteada (default de dev local)', () => {
    expect(resolveDatabaseSsl(undefined, undefined)).toBe(false);
  });

  it('devuelve false si DATABASE_SSL es cualquier valor distinto de "true"', () => {
    expect(resolveDatabaseSsl('false', undefined)).toBe(false);
    expect(resolveDatabaseSsl('1', undefined)).toBe(false);
    expect(resolveDatabaseSsl('', undefined)).toBe(false);
  });

  it('con DATABASE_SSL=true y sin override, valida certificado por default', () => {
    expect(resolveDatabaseSsl('true', undefined)).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('con DATABASE_SSL=true y REJECT_UNAUTHORIZED=false, desactiva la validación explícitamente', () => {
    expect(resolveDatabaseSsl('true', 'false')).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('con DATABASE_SSL=true y REJECT_UNAUTHORIZED=true, mantiene la validación', () => {
    expect(resolveDatabaseSsl('true', 'true')).toEqual({
      rejectUnauthorized: true,
    });
  });
});
