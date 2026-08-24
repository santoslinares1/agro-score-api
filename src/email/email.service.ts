import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

import { sanitizeHeaderValue } from './email.util';
import { EmailContent, InvitationEmailParams, buildInvitationEmail } from './templates/invitation.template';
import { PasswordResetEmailParams, buildPasswordResetEmail } from './templates/password-reset.template';
import {
  ScheduledAnalysisEmailParams,
  buildScheduledAnalysisEmail,
} from './templates/scheduled-analysis-report.template';

export interface EmailSendResult {
  sent: boolean;
  provider: string;
  messageId?: string;
  dryRun: boolean;
}

/**
 * ADMIN-3: servicio de email centralizado para invitaciones y password
 * reset. Mismo proveedor (Resend) y mismo criterio general que
 * contact/contact.service.ts (dry-run por default, nunca lanza — un fallo de
 * envío se refleja en `sent: false`, no revierte lo que ya se persistió en
 * DB), pero es un servicio nuevo, no una extensión de ContactService — ver
 * la nota de "por qué no se comparte código" en email.util.ts.
 *
 * Variables de entorno: EMAIL_PROVIDER/EMAIL_FROM/EMAIL_DRY_RUN son la capa
 * nueva y tienen prioridad; si no están seteadas, cae a
 * CONTACT_EMAIL_PROVIDER/CONTACT_FROM_EMAIL/CONTACT_EMAIL_DRY_RUN (así un
 * `.env` de producción que ya tenga configurado el flujo de /contact no
 * necesita duplicar nada para que esto funcione). RESEND_API_KEY siempre se
 * comparte — un solo proveedor transaccional para todo el backend. Ver
 * docs/invitation-password-reset-email.md.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resendClient: Resend | null = null;

  constructor(private readonly config: ConfigService) {}

  async sendInvitationEmail(to: string, params: InvitationEmailParams): Promise<EmailSendResult> {
    return this.send(to, buildInvitationEmail(params), '[Invitation]');
  }

  async sendPasswordResetEmail(
    to: string,
    params: PasswordResetEmailParams,
  ): Promise<EmailSendResult> {
    return this.send(to, buildPasswordResetEmail(params), '[PasswordReset]');
  }

  /** Fase 4A: aviso de análisis semanal automático disponible — ver
   * scheduled-analysis/scheduled-analysis-runner.service.ts. */
  async sendScheduledAnalysisEmail(
    to: string,
    params: ScheduledAnalysisEmailParams,
  ): Promise<EmailSendResult> {
    return this.send(to, buildScheduledAnalysisEmail(params), '[ScheduledAnalysis]');
  }

  private async send(
    to: string,
    content: EmailContent,
    logPrefix: string,
  ): Promise<EmailSendResult> {
    const provider = this.getProvider();
    const dryRun = this.isDryRun();

    // Dry-run: nunca loguea el link/token completo (viaja en el HTML/text del
    // email, no acá) — solo destinatario, remitente y asunto, igual criterio
    // que ContactService.
    if (dryRun) {
      this.logger.log(`${logPrefix} Dry run email`);
      this.logger.log(`${logPrefix} to=${to} from=${this.getFrom()}`);
      this.logger.log(`${logPrefix} subject=${content.subject}`);
      return { sent: true, provider, dryRun: true };
    }

    try {
      const resend = this.getResendClient();
      const { data, error } = await resend.emails.send({
        to: sanitizeHeaderValue(to),
        from: this.getFrom(),
        subject: sanitizeHeaderValue(content.subject),
        html: content.html,
        text: content.text,
      });

      if (error) {
        this.logger.error(`${logPrefix} Resend error: ${error.message}`);
        return { sent: false, provider, dryRun: false };
      }

      return { sent: true, provider, dryRun: false, messageId: data?.id };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`${logPrefix} Failed to send email: ${reason}`);
      return { sent: false, provider, dryRun: false };
    }
  }

  private isDryRun(): boolean {
    const explicit = this.config.get<string>('EMAIL_DRY_RUN');
    if (explicit !== undefined && explicit !== '') {
      return explicit !== 'false';
    }

    const contactFallback = this.config.get<string>('CONTACT_EMAIL_DRY_RUN');
    if (contactFallback !== undefined && contactFallback !== '') {
      return contactFallback !== 'false';
    }

    // Ninguna de las dos variables seteada: default seguro (nunca manda un
    // email real por accidente en un entorno mal configurado).
    return true;
  }

  private getProvider(): string {
    return (
      this.config.get<string>('EMAIL_PROVIDER') ||
      this.config.get<string>('CONTACT_EMAIL_PROVIDER') ||
      'resend'
    );
  }

  private getFrom(): string {
    return (
      this.config.get<string>('EMAIL_FROM') || this.config.get<string>('CONTACT_FROM_EMAIL') || ''
    );
  }

  private getResendClient(): Resend {
    if (this.resendClient) {
      return this.resendClient;
    }

    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      throw new Error(
        'RESEND_API_KEY no está configurada (requerida cuando EMAIL_DRY_RUN=false)',
      );
    }

    this.resendClient = new Resend(apiKey);
    return this.resendClient;
  }
}
