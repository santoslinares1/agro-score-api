import { ConfigService } from '@nestjs/config';

import { getRequiredJwtSecret } from './jwt-secret.util';

function configWith(value: string | undefined): ConfigService {
  return {
    get: () => value,
  } as unknown as ConfigService;
}

describe('getRequiredJwtSecret', () => {
  it('devuelve el secreto cuando está configurado', () => {
    expect(getRequiredJwtSecret(configWith('un-secreto-largo-y-random'))).toBe(
      'un-secreto-largo-y-random',
    );
  });

  it('recorta espacios alrededor del valor', () => {
    expect(getRequiredJwtSecret(configWith('  con-espacios  '))).toBe(
      'con-espacios',
    );
  });

  it('falla si JWT_SECRET no está seteada', () => {
    expect(() => getRequiredJwtSecret(configWith(undefined))).toThrow(
      /JWT_SECRET no está configurada/,
    );
  });

  it('falla si JWT_SECRET está vacía', () => {
    expect(() => getRequiredJwtSecret(configWith(''))).toThrow(
      /JWT_SECRET no está configurada/,
    );
  });

  it('falla si JWT_SECRET son solo espacios', () => {
    expect(() => getRequiredJwtSecret(configWith('   '))).toThrow(
      /JWT_SECRET no está configurada/,
    );
  });

  it('el mensaje de error no incluye ningún valor de secreto', () => {
    try {
      getRequiredJwtSecret(configWith(undefined));
      fail('debería haber lanzado');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('dev-secret');
      expect(message).not.toMatch(/[a-zA-Z0-9]{16,}/);
    }
  });
});
