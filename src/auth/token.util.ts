import { createHash, randomBytes } from 'crypto';

/**
 * ADMIN-2: helper compartido por invitaciones y password-reset. El token
 * crudo viaja una sola vez (en la respuesta HTTP en dev, o en el link que se
 * le manda al usuario) y nunca se persiste — solo se guarda `hashToken(...)`
 * en DB. Comparar en el accept-endpoint es simplemente volver a hashear el
 * token recibido y buscar por igualdad exacta del hash (no hace falta bcrypt
 * acá: son tokens aleatorios de alta entropía de un solo uso, no passwords
 * elegidas por humanos — SHA-256 alcanza y es rápido de indexar en DB).
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
