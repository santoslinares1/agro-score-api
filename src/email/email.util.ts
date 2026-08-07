// ADMIN-3: copiado a propósito de contact.service.ts en vez de extraído a un
// util compartido — evita tocar el flujo de /contact (ya funcionando en
// producción) por una deduplicación cosmética de ~10 líneas. Si en el futuro
// se necesita un tercer consumidor, ahí sí vale la pena extraerlo de verdad.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Header injection defense: los headers de email terminan en un \r\n, así que un
// valor de usuario con saltos de línea podría inyectar headers/destinatarios extra.
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
