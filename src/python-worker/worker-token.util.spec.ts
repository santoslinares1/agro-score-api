import { ConfigService } from '@nestjs/config';

import { getRequiredWorkerToken } from './worker-token.util';

function configWith(value: string | undefined): ConfigService {
  return {
    get: () => value,
  } as unknown as ConfigService;
}

describe('getRequiredWorkerToken', () => {
  it('devuelve el token cuando está configurado', () => {
    expect(getRequiredWorkerToken(configWith('un-token-largo-y-random'))).toBe(
      'un-token-largo-y-random',
    );
  });

  it('recorta espacios alrededor del valor', () => {
    expect(getRequiredWorkerToken(configWith('  con-espacios  '))).toBe(
      'con-espacios',
    );
  });

  it('falla si WORKER_INTERNAL_TOKEN no está seteada', () => {
    expect(() => getRequiredWorkerToken(configWith(undefined))).toThrow(
      /WORKER_INTERNAL_TOKEN no está configurada/,
    );
  });

  it('falla si WORKER_INTERNAL_TOKEN está vacía', () => {
    expect(() => getRequiredWorkerToken(configWith(''))).toThrow(
      /WORKER_INTERNAL_TOKEN no está configurada/,
    );
  });

  it('falla si WORKER_INTERNAL_TOKEN son solo espacios', () => {
    expect(() => getRequiredWorkerToken(configWith('   '))).toThrow(
      /WORKER_INTERNAL_TOKEN no está configurada/,
    );
  });

  it('el mensaje de error no incluye ningún valor de token', () => {
    try {
      getRequiredWorkerToken(configWith(undefined));
      fail('debería haber lanzado');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('dev-token');
      expect(message).not.toMatch(/[a-zA-Z0-9]{16,}/);
    }
  });
});
