import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

import { CONTACT_PROFILE_LABELS } from './contact-profile.enum';
import { CreateContactDto } from './dto/create-contact.dto';

export interface ContactResult {
  ok: boolean;
  message: string;
}

interface ContactMail {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
}

const SEND_SUCCESS_MESSAGE = 'Consulta enviada correctamente';
const SEND_FAILURE_MESSAGE = 'No pudimos enviar la consulta en este momento';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Header injection defense: los headers de email terminan en un \r\n, así que un
// valor de usuario con saltos de línea podría inyectar headers/destinatarios extra.
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private resendClient: Resend | null = null;

  constructor(private readonly config: ConfigService) {}

  async sendContactRequest(dto: CreateContactDto): Promise<ContactResult> {
    const mail = this.buildMail(dto);

    if (this.isDryRun()) {
      this.logger.log('[Contact] Dry run email');
      this.logger.log(
        `[Contact] to=${mail.to} from=${mail.from} replyTo=${mail.replyTo}`,
      );
      this.logger.log(`[Contact] subject=${mail.subject}`);
      this.logger.log(`[Contact] text=\n${mail.text}`);
      return { ok: true, message: SEND_SUCCESS_MESSAGE };
    }

    try {
      const resend = this.getResendClient();
      const { error } = await resend.emails.send({
        to: mail.to,
        from: mail.from,
        replyTo: mail.replyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });

      if (error) {
        this.logger.error(`[Contact] Resend error: ${error.message}`);
        return { ok: false, message: SEND_FAILURE_MESSAGE };
      }

      return { ok: true, message: SEND_SUCCESS_MESSAGE };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`[Contact] Failed to send email: ${reason}`);
      return { ok: false, message: SEND_FAILURE_MESSAGE };
    }
  }

  private isDryRun(): boolean {
    return this.config.get<string>('CONTACT_EMAIL_DRY_RUN') !== 'false';
  }

  private getResendClient(): Resend {
    if (this.resendClient) {
      return this.resendClient;
    }

    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      throw new Error(
        'RESEND_API_KEY no está configurada (requerida cuando CONTACT_EMAIL_DRY_RUN=false)',
      );
    }

    this.resendClient = new Resend(apiKey);
    return this.resendClient;
  }

  private buildMail(dto: CreateContactDto): ContactMail {
    const name = dto.name.trim();
    const email = dto.email.trim();
    const companyOrField = dto.companyOrField.trim();
    const estimatedSurface = dto.estimatedSurface.trim();
    const message = dto.message.trim();
    const profileLabel = CONTACT_PROFILE_LABELS[dto.profile];

    const to = this.config.get<string>('CONTACT_TO_EMAIL') ?? '';
    const from = this.config.get<string>('CONTACT_FROM_EMAIL') ?? '';
    const submittedAt = new Date().toLocaleString('es-AR');

    const subject = sanitizeHeaderValue(
      `Nueva consulta desde AgroScore — ${profileLabel} — ${companyOrField}`,
    );

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

    return {
      to,
      from,
      replyTo: sanitizeHeaderValue(email),
      subject,
      html,
      text,
    };
  }
}
