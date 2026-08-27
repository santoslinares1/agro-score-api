import { escapeHtml } from '../email.util';
import type { EmailContent } from './invitation.template';
import { CONTACT_PROFILE_LABELS } from '../../contact/contact-profile.enum';
import type { CreateContactDto } from '../../contact/dto/create-contact.dto';

/**
 * SMTP-MIGRATION-1: extraído de contact.service.ts (antes armaba y mandaba el mail en el mismo
 * servicio, con su propio cliente Resend). Ahora ContactService solo delega el armado+envío en
 * EmailService.sendContactInquiry, que usa este builder. Mismo contenido/estructura que antes,
 * solo movido de lugar.
 */
export function buildContactInquiryEmail(dto: CreateContactDto): EmailContent {
  const name = dto.name.trim();
  const email = dto.email.trim();
  const companyOrField = dto.companyOrField.trim();
  const estimatedSurface = dto.estimatedSurface.trim();
  const message = dto.message.trim();
  const profileLabel = CONTACT_PROFILE_LABELS[dto.profile];
  const submittedAt = new Date().toLocaleString('es-AR');

  const subject = `Nueva consulta desde AgroScore — ${profileLabel} — ${companyOrField}`;

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Nueva consulta desde AgroScore</h1>
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
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Empresa / Campo</td>
            <td style="padding: 6px 0;">${escapeHtml(companyOrField)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Perfil</td>
            <td style="padding: 6px 0;">${escapeHtml(profileLabel)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 12px 6px 0; font-weight: bold; vertical-align: top;">Superficie estimada</td>
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
            <td style="padding: 6px 0;">Landing pública</td>
          </tr>
        </tbody>
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        AgroScore — Diagnóstico productivo con evidencia satelital.
      </p>
    </div>
  `.trim();

  const text = [
    'Nueva consulta desde AgroScore',
    '',
    `Nombre: ${name}`,
    `Email: ${email}`,
    `Empresa / Campo: ${companyOrField}`,
    `Perfil: ${profileLabel}`,
    `Superficie estimada: ${estimatedSurface}`,
    'Mensaje:',
    message,
    '',
    `Fecha/hora: ${submittedAt}`,
    'Origen: Landing pública',
  ].join('\n');

  return { subject, html, text };
}
