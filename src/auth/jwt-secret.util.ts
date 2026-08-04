import { ConfigService } from '@nestjs/config';

/**
 * Resuelve JWT_SECRET desde la config. Sin fallback: si falta o está vacía,
 * falla el arranque en vez de firmar/validar tokens con un valor conocido
 * públicamente (ver SEC-002, SECOPS-AUDIT-1).
 */
export function getRequiredJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET')?.trim();

  if (!secret) {
    throw new Error(
      'JWT_SECRET no está configurada. Definí una variable de entorno JWT_SECRET ' +
        '(valor largo y aleatorio) antes de iniciar el backend — no hay valor por defecto.',
    );
  }

  return secret;
}
