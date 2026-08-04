/**
 * SEC-004: SSL configurable para la conexión a Postgres/RDS. Off por
 * default (compatible con el Postgres de Docker local, que no habla TLS),
 * se activa explícito con DATABASE_SSL=true en producción.
 *
 * Función pura (sin ConfigService) para poder compartirla entre
 * app.module.ts (bootstrap de Nest) y data-source.ts (CLI de migraciones,
 * que corre fuera del ciclo de vida de Nest y lee process.env directo).
 */
export function resolveDatabaseSsl(
  databaseSsl: string | undefined,
  databaseSslRejectUnauthorized: string | undefined,
): false | { rejectUnauthorized: boolean } {
  if (databaseSsl !== 'true') {
    return false;
  }

  return {
    // Default seguro: valida el certificado salvo que se lo desactive
    // explícito (útil como paso transitorio con certificados propios).
    rejectUnauthorized: databaseSslRejectUnauthorized !== 'false',
  };
}
