import { ConfigService } from '@nestjs/config';

/**
 * Resuelve WORKER_INTERNAL_TOKEN desde la config. Sin fallback: si falta o está vacía, falla el
 * arranque en vez de mandar requests sin autenticación al worker (ver SEC-003). Mismo criterio
 * que getRequiredJwtSecret (jwt-secret.util.ts) — el secreto debe coincidir exactamente con
 * WORKER_INTERNAL_TOKEN en agro-score-worker (ver app/worker_auth.py).
 */
export function getRequiredWorkerToken(config: ConfigService): string {
  const token = config.get<string>('WORKER_INTERNAL_TOKEN')?.trim();

  if (!token) {
    throw new Error(
      'WORKER_INTERNAL_TOKEN no está configurada. Definí una variable de entorno ' +
        'WORKER_INTERNAL_TOKEN (valor largo y aleatorio, el mismo que agro-score-worker ' +
        'exige en su header X-Worker-Token — ver app/worker_auth.py) antes de iniciar el ' +
        'backend — no hay valor por defecto. Sin esto, el backend no puede autenticarse ' +
        'contra /analyze ni /weekly-report/spike del worker (SEC-003).',
    );
  }

  return token;
}
