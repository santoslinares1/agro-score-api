import { Injectable } from '@nestjs/common';

import { EmailService } from '../email/email.service';
import { CreateContactDto } from './dto/create-contact.dto';

export interface ContactResult {
  ok: boolean;
  message: string;
}

const SEND_SUCCESS_MESSAGE = 'Consulta enviada correctamente';
const SEND_FAILURE_MESSAGE = 'No pudimos enviar la consulta en este momento';

/**
 * SMTP-MIGRATION-1: ya no arma ni manda el mail acá — delega en
 * EmailService.sendContactInquiry (SMTP centralizado, ver docs/email-configuration.md). Este
 * servicio solo traduce el EmailSendResult a la respuesta pública { ok, message } que ya
 * consumía el frontend.
 */
@Injectable()
export class ContactService {
  constructor(private readonly emailService: EmailService) {}

  async sendContactRequest(dto: CreateContactDto): Promise<ContactResult> {
    const result = await this.emailService.sendContactInquiry(dto);

    if (!result.sent) {
      return { ok: false, message: SEND_FAILURE_MESSAGE };
    }

    return { ok: true, message: SEND_SUCCESS_MESSAGE };
  }
}
