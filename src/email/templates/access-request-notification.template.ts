import { escapeHtml } from '../email.util';
import type { EmailContent } from './invitation.template';
import { ACCESS_REQUEST_PROFILE_LABELS } from '../../access-request/access-request-profile.enum';
import type { CreateAccessRequestDto } from '../../access-request/dto/create-access-request.dto';

const NOT_SPECIFIED = 'No especificada';
const NO_MESSAGE = 'Sin mensaje adicional';

/**
 * SMTP-MIGRATION-1: extraído de access-request.service.ts (antes armaba y mandaba el mail en el
 * mismo servicio, con su propio cliente Resend). Ahora AccessRequestService solo persiste el
 * registro y delega el armado+envío en EmailService.sendAccessRequestNotification, que usa este
 * builder. Mismo contenido/estructura que antes, solo movido de lugar.
 */
export function buildAccessRequestEmail(
  dto: CreateAccessRequestDto,
): EmailContent {
  const name = dto.name.trim();
  const email = dto.email.trim();
  const organization = dto.organization.trim();
  const estimatedSurface = dto.estimatedSurface?.trim() || NOT_SPECIFIED;
  const message = dto.message?.trim() || NO_MESSAGE;
  const profileLabel = ACCESS_REQUEST_PROFILE_LABELS[dto.profile];
  const submittedAt = new Date().toLocaleString('es-AR');

  const subject = 'Nueva solicitud de acceso · AgroScore';

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Nueva solicitud de acceso — AgroScore</h1>
      <table style="border-collapse: collapse; width: 100%; max-width: 480px;" cellpadding="0" cellspacing="0">
        <tbody>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Nombre</td>
            <td style="padding: 6px 0;">${escapeHtml(name)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Email</td>
            <td style="padding: 6px 0;">${escapeHtml(email)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Organización / Campo</td>
            <td style="padding: 6px 0;">${escapeHtml(organization)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Perfil</td>
            <td style="padding: 6px 0;">${escapeHtml(profileLabel)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Superficie estimada / cantidad de campos</td>
            <td style="padding: 6px 0;">${escapeHtml(estimatedSurface)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Mensaje</td>
            <td style="padding: 6px 0; white-space: pre-line;">${escapeHtml(message)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Fecha/hora</td>
            <td style="padding: 6px 0;">${escapeHtml(submittedAt)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Origen</td>
            <td style="padding: 6px 0;">Formulario de solicitud de acceso</td>
          </tr>
        </tbody>
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        AgroScore — Diagnóstico productivo con evidencia satelital.
      </p>
    </div>
  `.trim();

  const text = [
    'Nueva solicitud de acceso — AgroScore',
    '',
    `Nombre: ${name}`,
    `Email: ${email}`,
    `Organización / Campo: ${organization}`,
    `Perfil: ${profileLabel}`,
    `Superficie estimada / cantidad de campos: ${estimatedSurface}`,
    'Mensaje:',
    message,
    '',
    `Fecha/hora: ${submittedAt}`,
    'Origen: Formulario de solicitud de acceso',
  ].join('\n');

  return { subject, html, text };
}
