/**
 * DEPLOY-AWS-1: la landing productiva vive en S3/CloudFront y puede
 * responder desde más de un origin (apex + www, o el dominio de CloudFront
 * mientras no haya dominio propio todavía). CORS_ORIGIN admite una lista
 * separada por comas; si no está seteada, se mantiene el comportamiento
 * previo (single-origin vía FRONTEND_URL) por compatibilidad con dev local.
 */
export function resolveCorsOrigins(
  corsOrigin: string | undefined,
  frontendUrl: string | undefined,
): string | string[] {
  const origins = (corsOrigin ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length > 0) {
    return origins;
  }

  return frontendUrl?.trim() || 'http://localhost:4200';
}
