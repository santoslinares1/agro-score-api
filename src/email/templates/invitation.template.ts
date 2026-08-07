import { escapeHtml } from '../email.util';

export interface InvitationEmailParams {
  invitationUrl: string;
  expiresAt: Date;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/**
 * ADMIN-3: HTML inline (sin CSS externo, sin <style> en <head>) a propósito
 * — el email tiene que verse razonable en clientes que ignoran <style>
 * (Outlook, Gmail en algunos casos). Mismo criterio visual que
 * contact.service.ts (paleta de marca AgroScore: verde oscuro #14532d,
 * texto #1f2937).
 */
export function buildInvitationEmail(params: InvitationEmailParams): EmailContent {
  const { invitationUrl, expiresAt } = params;
  const expiresAtLabel = expiresAt.toLocaleString('es-AR');
  const safeUrl = escapeHtml(invitationUrl);

  const subject = 'Te invitaron a AgroScore';

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 480px;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Te invitaron a AgroScore</h1>
      <p>Hola,</p>
      <p>Te invitaron a crear tu cuenta en AgroScore, la plataforma de diagnóstico productivo con evidencia satelital.</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}"
           style="display: inline-block; background-color: #14532d; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 999px; font-weight: bold;">
          Aceptar invitación
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">
        Si el botón no funciona, copiá y pegá este link en tu navegador:<br />
        <a href="${safeUrl}" style="color: #14532d; word-break: break-all;">${safeUrl}</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">Este link vence el ${escapeHtml(expiresAtLabel)}.</p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        Si no esperabas este email, podés ignorarlo — nadie más puede crear una cuenta con tu email sin este link.
      </p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        AgroScore — Diagnóstico productivo con evidencia satelital.
      </p>
    </div>
  `.trim();

  const text = [
    'Te invitaron a AgroScore',
    '',
    'Hola,',
    '',
    'Te invitaron a crear tu cuenta en AgroScore, la plataforma de diagnóstico productivo con evidencia satelital.',
    '',
    'Aceptá tu invitación en este link:',
    invitationUrl,
    '',
    `Este link vence el ${expiresAtLabel}.`,
    '',
    'Si no esperabas este email, podés ignorarlo — nadie más puede crear una cuenta con tu email sin este link.',
  ].join('\n');

  return { subject, html, text };
}
