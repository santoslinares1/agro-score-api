import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EmailService } from '../email/email.service';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { AccessRequest } from './entities/access-request.entity';

export interface AccessRequestResult {
  ok: boolean;
  message: string;
}

const SEND_SUCCESS_MESSAGE = 'Solicitud enviada correctamente';
const SEND_FAILURE_MESSAGE = 'No pudimos enviar la solicitud en este momento';

/**
 * SMTP-MIGRATION-1: ya no arma ni manda el mail acá — delega en
 * EmailService.sendAccessRequestNotification (SMTP centralizado, ver
 * docs/email-configuration.md). Este servicio solo persiste el registro y traduce el
 * EmailSendResult a la respuesta pública { ok, message } que ya consumía el frontend.
 */
@Injectable()
export class AccessRequestService {
  constructor(
    private readonly emailService: EmailService,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
  ) {}

  async sendAccessRequest(
    dto: CreateAccessRequestDto,
  ): Promise<AccessRequestResult> {
    // ADMIN-1: persiste primero — así la solicitud queda visible en
    // /admin/access-requests aunque el envío de mail falle después. No se
    // persiste dentro de un try/catch de envío: si guardar en DB falla,
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

    const result = await this.emailService.sendAccessRequestNotification(dto);

    if (!result.sent) {
      return { ok: false, message: SEND_FAILURE_MESSAGE };
    }

    return { ok: true, message: SEND_SUCCESS_MESSAGE };
  }
}
