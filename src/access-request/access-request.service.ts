import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Resend } from 'resend';
import { Repository } from 'typeorm';

import { ACCESS_REQUEST_PROFILE_LABELS } from './access-request-profile.enum';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { AccessRequest } from './entities/access-request.entity';

export interface AccessRequestResult {
  ok: boolean;
  message: string;
}

interface AccessRequestMail {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
}

const SEND_SUCCESS_MESSAGE = 'Solicitud enviada correctamente';
const SEND_FAILURE_MESSAGE = 'No pudimos enviar la solicitud en este momento';
const NOT_SPECIFIED = 'No especificada';
const NO_MESSAGE = 'Sin mensaje adicional';

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
export class AccessRequestService {
  private readonly logger = new Logger(AccessRequestService.name);
  private resendClient: Resend | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
  ) {}

  async sendAccessRequest(
    dto: CreateAccessRequestDto,
  ): Promise<AccessRequestResult> {
    // ADMIN-1: persiste primero — así la solicitud queda visible en
    // /admin/access-requests aunque el envío de mail (Resend) falle después.
    // No se persiste dentro del try/catch de envío: si guardar en DB falla,
    // preferimos que el request entero falle con 500 antes que devolver un
    // falso "enviado" que después no aparece en ningún lado.
    await this.accessRequestRepository.save(
      this.accessRequestRepository.create({
        name: dto.name.trim(),
        email: dto.email.trim(),
        organization: dto.organization.trim(),
        profile: dto.profile,
        estimatedSurface: dto.estimatedSurface?.trim() || undefined,
        message: dto.message?.trim() || undefined,
      }),
    );

    const mail = this.buildMail(dto);

    if (this.isDryRun()) {
      this.logger.log('[AccessRequest] Dry run email');
      this.logger.log(
        `[AccessRequest] to=${mail.to} from=${mail.from} replyTo=${mail.replyTo}`,
      );
      this.logger.log(`[AccessRequest] subject=${mail.subject}`);
      this.logger.log(`[AccessRequest] text=\n${mail.text}`);
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
        this.logger.error(`[AccessRequest] Resend error: ${error.message}`);
        return { ok: false, message: SEND_FAILURE_MESSAGE };
      }

      return { ok: true, message: SEND_SUCCESS_MESSAGE };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`[AccessRequest] Failed to send email: ${reason}`);
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

  private buildMail(dto: CreateAccessRequestDto): AccessRequestMail {
    const name = dto.name.trim();
    const email = dto.email.trim();
    const organization = dto.organization.trim();
    const estimatedSurface = dto.estimatedSurface?.trim() || NOT_SPECIFIED;
    const message = dto.message?.trim() || NO_MESSAGE;
    const profileLabel = ACCESS_REQUEST_PROFILE_LABELS[dto.profile];

    const to = this.config.get<string>('CONTACT_TO_EMAIL') ?? '';
    const from = this.config.get<string>('CONTACT_FROM_EMAIL') ?? '';
    const submittedAt = new Date().toLocaleString('es-AR');

    const subject = sanitizeHeaderValue('Solicitud de acceso — AgroScore');

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
