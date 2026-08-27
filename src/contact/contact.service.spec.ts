import { Test, TestingModule } from '@nestjs/testing';

import { EmailService } from '../email/email.service';
import { ContactProfile } from './contact-profile.enum';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

const emailServiceMock = {
  sendContactInquiry: jest.fn(),
};

describe('ContactService', () => {
  let service: ContactService;

  const dto: CreateContactDto = {
    name: '  Santos Linares  ',
    email: '  santos9linares@gmail.com  ',
    companyOrField: 'Campo La Esperanza',
    profile: ContactProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message:
      'Quiero evaluar AgroScore para analizar lotes internos y generar reportes técnicos.',
  };

  beforeEach(async () => {
    emailServiceMock.sendContactInquiry.mockReset();
    emailServiceMock.sendContactInquiry.mockResolvedValue({
      sent: true,
      provider: 'smtp',
      dryRun: true,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: EmailService, useValue: emailServiceMock },
      ],
    }).compile();

    service = module.get(ContactService);
  });

  it('delega el envío en EmailService.sendContactInquiry con el DTO recibido', async () => {
    await service.sendContactRequest(dto);

    expect(emailServiceMock.sendContactInquiry).toHaveBeenCalledWith(dto);
  });

  it('devuelve ok:true cuando EmailService reporta sent:true', async () => {
    emailServiceMock.sendContactInquiry.mockResolvedValue({
      sent: true,
      provider: 'smtp',
      dryRun: false,
      messageId: 'msg-1',
    });

    const result = await service.sendContactRequest(dto);

    expect(result).toEqual({
      ok: true,
      message: 'Consulta enviada correctamente',
    });
  });

  it('devuelve ok:false sin exponer detalle interno cuando EmailService reporta sent:false', async () => {
    emailServiceMock.sendContactInquiry.mockResolvedValue({
      sent: false,
      provider: 'smtp',
      dryRun: false,
    });

    const result = await service.sendContactRequest(dto);

    expect(result).toEqual({
      ok: false,
      message: 'No pudimos enviar la consulta en este momento',
    });
  });
});
