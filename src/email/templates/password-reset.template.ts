import { escapeHtml } from '../email.util';
import type { EmailContent } from './invitation.template';

export interface PasswordResetEmailParams {
  resetUrl: string;
  expiresAt: Date;
}

// ADMIN-3: mismo criterio visual que invitation.template.ts — ver comentario ahí.
export function buildPasswordResetEmail(params: PasswordResetEmailParams): EmailContent {
  const { resetUrl, expiresAt } = params;
  const expiresAtLabel = expiresAt.toLocaleString('es-AR');
  const safeUrl = escapeHtml(resetUrl);

  const subject = 'Restablecé tu contraseña de AgroScore';

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 480px;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Restablecé tu contraseña</h1>
      <p>Hola,</p>
      <p>Se generó una solicitud para restablecer tu contraseña de AgroScore.</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}"
           style="display: inline-block; background-color: #14532d; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 999px; font-weight: bold;">
          Restablecer contraseña
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">
        Si el botón no funciona, copiá y pegá este link en tu navegador:<br />
        <a href="${safeUrl}" style="color: #14532d; word-break: break-all;">${safeUrl}</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">Este link vence el ${escapeHtml(expiresAtLabel)}.</p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        Si no solicitaste esto, podés ignorarlo — tu contraseña actual sigue funcionando sin cambios.
      </p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        AgroScore — Diagnóstico productivo con evidencia satelital.
      </p>
    </div>
  `.trim();

  const text = [
    'Restablecé tu contraseña de AgroScore',
    '',
    'Hola,',
    '',
    'Se generó una solicitud para restablecer tu contraseña de AgroScore.',
    '',
    'Restablecela en este link:',
    resetUrl,
    '',
    `Este link vence el ${expiresAtLabel}.`,
    '',
    'Si no solicitaste esto, podés ignorarlo — tu contraseña actual sigue funcionando sin cambios.',
  ].join('\n');

  return { subject, html, text };
}
