import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Transporter } from 'nodemailer';

import type { CreateAccessRequestDto } from '../access-request/dto/create-access-request.dto';
import type { CreateContactDto } from '../contact/dto/create-contact.dto';
import { sanitizeHeaderValue } from './email.util';
import {
  InvitationEmailParams,
  buildInvitationEmail,
} from './templates/invitation.template';
import {
  PasswordResetEmailParams,
  buildPasswordResetEmail,
} from './templates/password-reset.template';
import { buildAccessRequestEmail } from './templates/access-request-notification.template';
import { buildContactInquiryEmail } from './templates/contact-inquiry.template';
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

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

interface OutgoingMail {
  to: string;
  from: string;
  replyTo?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

/**
 * SMTP-MIGRATION-1: servicio de email centralizado del backend — reemplaza a Resend (y a los tres
 * clientes independientes que existían antes: este mismo servicio, AccessRequestService y
 * ContactService, cada uno con su propia instancia del SDK) por un único transporte SMTP
 * (nodemailer) contra Google Workspace. Ver docs/email-configuration.md para la arquitectura
 * completa (cuenta real vs. alias vs. grupos) y el mapping de variables viejas → nuevas.
 *
 * Arquitectura de remitentes (fija, no configurable por el caller):
 * - autenticación SMTP: SMTP_USER (slinares@agroscorelatam.com, cuenta real de Google Workspace)
 * - remitente visible: MAIL_FROM (no-reply@agroscorelatam.com, alias autorizado de SMTP_USER)
 * - reply-to default: MAIL_REPLY_TO (contacto@agroscorelatam.com, grupo — nunca SMTP_USER)
 * - destinatario de solicitudes/consultas: CONTACT_EMAIL (contacto@agroscorelatam.com, grupo)
 * - bcc de reportes automáticos: REPORTS_BCC_EMAIL (reportes@agroscorelatam.com, grupo, opcional)
 *
 * contacto@ y reportes@ son grupos de Google, no cuentas — nunca se usan como SMTP_USER/SMTP_PASS
 * en ningún punto de este archivo (ver docs/email-configuration.md, sección "Nota Google
 * Workspace").
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter<SMTPTransport.SentMessageInfo> | null = null;

  constructor(private readonly config: ConfigService) {}

  async sendInvitationEmail(
    to: string,
    params: InvitationEmailParams,
  ): Promise<EmailSendResult> {
    const content = buildInvitationEmail(params);
    return this.dispatch(
      {
        to,
        from: this.getMailFrom(),
        replyTo: this.getMailReplyTo(),
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      '[Invitation]',
    );
  }

  async sendPasswordResetEmail(
    to: string,
    params: PasswordResetEmailParams,
  ): Promise<EmailSendResult> {
    const content = buildPasswordResetEmail(params);
    return this.dispatch(
      {
        to,
        from: this.getMailFrom(),
        replyTo: this.getMailReplyTo(),
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      '[PasswordReset]',
    );
  }

  /** Fase 4A: aviso de análisis semanal automático disponible — ver
   * scheduled-analysis/scheduled-analysis-runner.service.ts. Único flujo que agrega bcc
   * (REPORTS_BCC_EMAIL) — el grupo reportes@ archiva una copia de cada reporte enviado sin ser
   * una cuenta SMTP real. Si REPORTS_BCC_EMAIL no está configurada, se manda igual sin bcc. */
  async sendScheduledAnalysisEmail(
    to: string,
    params: ScheduledAnalysisEmailParams,
  ): Promise<EmailSendResult> {
    const content = buildScheduledAnalysisEmail(params);
    return this.dispatch(
      {
        to,
        from: this.getMailFrom(),
        replyTo: this.getMailReplyTo(),
        bcc: this.getReportsBcc(),
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      '[ScheduledAnalysis]',
    );
  }

  /**
   * SMTP-MIGRATION-1: reemplaza el envío que antes vivía en AccessRequestService (cliente Resend
   * propio). `to` siempre es CONTACT_EMAIL (el grupo contacto@) — nunca SMTP_USER ni un valor que
   * venga del payload del cliente. `replyTo` es el email del solicitante; si por algún motivo
   * llega vacío/inválido (el DTO ya lo valida con @IsEmail, esto es defensivo), cae a
   * MAIL_REPLY_TO.
   */
  async sendAccessRequestNotification(
    dto: CreateAccessRequestDto,
  ): Promise<EmailSendResult> {
    const content = buildAccessRequestEmail(dto);
    const requesterEmail = sanitizeHeaderValue(dto.email?.trim() ?? '');

    return this.dispatch(
      {
        to: this.getContactEmail(),
        from: this.getMailFrom(),
        replyTo: requesterEmail || this.getMailReplyTo(),
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      '[AccessRequest]',
    );
  }

  /**
   * SMTP-MIGRATION-1: reemplaza el envío que antes vivía en ContactService (cliente Resend
   * propio). Mismo criterio que sendAccessRequestNotification: `to` siempre CONTACT_EMAIL,
   * `replyTo` el email del consultante.
   */
  async sendContactInquiry(dto: CreateContactDto): Promise<EmailSendResult> {
    const content = buildContactInquiryEmail(dto);
    const requesterEmail = sanitizeHeaderValue(dto.email?.trim() ?? '');

    return this.dispatch(
      {
        to: this.getContactEmail(),
        from: this.getMailFrom(),
        replyTo: requesterEmail || this.getMailReplyTo(),
        subject: content.subject,
        html: content.html,
        text: content.text,
      },
      '[Contact]',
    );
  }

  private async dispatch(
    mail: OutgoingMail,
    logPrefix: string,
  ): Promise<EmailSendResult> {
    const provider = this.getProvider();
    const dryRun = this.isDryRun();

    // Dry-run: nunca loguea el link/token completo (viaja en el HTML/text del
    // email, no acá) — solo destinatario, remitente, reply-to/bcc y asunto.
    if (dryRun) {
      this.logger.log(`${logPrefix} Dry run email`);
      this.logger.log(
        `${logPrefix} to=${mail.to} from=${mail.from}` +
          (mail.replyTo ? ` replyTo=${mail.replyTo}` : '') +
          (mail.bcc ? ` bcc=${mail.bcc}` : ''),
      );
      this.logger.log(`${logPrefix} subject=${mail.subject}`);
      return { sent: true, provider, dryRun: true };
    }

    if (!mail.from) {
      this.logger.error(
        `${logPrefix} MAIL_FROM no está configurada (requerida para envío real)`,
      );
      return { sent: false, provider, dryRun: false };
    }

    if (!mail.to) {
      this.logger.error(
        `${logPrefix} No hay destinatario configurado para este envío`,
      );
      return { sent: false, provider, dryRun: false };
    }

    try {
      const transporter = this.getTransporter();
      const info = await transporter.sendMail({
        to: sanitizeHeaderValue(mail.to),
        from: mail.from,
        ...(mail.replyTo ? { replyTo: sanitizeHeaderValue(mail.replyTo) } : {}),
        ...(mail.bcc ? { bcc: sanitizeHeaderValue(mail.bcc) } : {}),
        subject: sanitizeHeaderValue(mail.subject),
        html: mail.html,
        text: mail.text,
        ...(mail.attachments?.length
          ? {
              attachments: mail.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
              })),
            }
          : {}),
      });

      return { sent: true, provider, dryRun: false, messageId: info.messageId };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`${logPrefix} Failed to send email: ${reason}`);
      return { sent: false, provider, dryRun: false };
    }
  }

  private isDryRun(): boolean {
    // MAIL_DRY_RUN es el nombre nuevo; EMAIL_DRY_RUN/CONTACT_EMAIL_DRY_RUN se mantienen como
    // fallback para no romper un .env real que todavía no migró (ver docs/email-configuration.md,
    // tabla de mapping). Default true si ninguna está seteada — nunca manda un email real por
    // accidente en un entorno mal configurado.
    for (const key of [
      'MAIL_DRY_RUN',
      'EMAIL_DRY_RUN',
      'CONTACT_EMAIL_DRY_RUN',
    ]) {
      const value = this.config.get<string>(key);
      if (value !== undefined && value !== '') {
        return value !== 'false';
      }
    }

    return true;
  }

  private getProvider(): string {
    return (
      this.config.get<string>('MAIL_PROVIDER') ||
      this.config.get<string>('EMAIL_PROVIDER') ||
      'smtp'
    );
  }

  private getMailFrom(): string {
    return (
      this.config.get<string>('MAIL_FROM') ||
      this.config.get<string>('EMAIL_FROM') ||
      this.config.get<string>('CONTACT_FROM_EMAIL') ||
      ''
    );
  }

  private getMailReplyTo(): string | undefined {
    return this.config.get<string>('MAIL_REPLY_TO') || undefined;
  }

  private getContactEmail(): string {
    return (
      this.config.get<string>('CONTACT_EMAIL') ||
      this.config.get<string>('CONTACT_TO_EMAIL') ||
      ''
    );
  }

  private getReportsBcc(): string | undefined {
    return this.config.get<string>('REPORTS_BCC_EMAIL') || undefined;
  }

  /**
   * Cliente SMTP lazy (mismo patrón que tenía el viejo getResendClient): no se construye ni se
   * valida configuración en el constructor, así que el boot de la app nunca falla por env vars de
   * mail faltantes — el error (si falta algo) sale recién acá, dentro de dispatch(), en el primer
   * intento de envío real, y queda contenido por el try/catch de dispatch (nunca lanza hacia el
   * caller, se refleja en sent:false). Nunca loguea SMTP_PASS, ni siquiera en el mensaje de error.
   */
  private getTransporter(): Transporter<SMTPTransport.SentMessageInfo> {
    if (this.transporter) {
      return this.transporter;
    }

    const host = this.config.get<string>('SMTP_HOST');
    const port = this.config.get<string>('SMTP_PORT');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    const missing = [
      !host && 'SMTP_HOST',
      !port && 'SMTP_PORT',
      !user && 'SMTP_USER',
      !pass && 'SMTP_PASS',
    ].filter((name): name is string => Boolean(name));

    if (missing.length > 0) {
      throw new Error(
        `Configuración SMTP incompleta: falta ${missing.join(', ')} (requerida cuando MAIL_DRY_RUN=false)`,
      );
    }

    const secureRaw = this.config.get<string>('SMTP_SECURE');
    const secure =
      secureRaw === undefined || secureRaw === ''
        ? true
        : secureRaw !== 'false';

    this.transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure,
      auth: { user, pass },
    });

    return this.transporter;
  }
}
