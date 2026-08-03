import { Test, TestingModule } from '@nestjs/testing';

import { ContactProfile } from './contact-profile.enum';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

describe('ContactController', () => {
  let controller: ContactController;
  let contactService: jest.Mocked<Pick<ContactService, 'sendContactRequest'>>;

  const dto: CreateContactDto = {
    name: 'Santos Linares',
    email: 'santos9linares@gmail.com',
    companyOrField: 'Campo La Esperanza',
    profile: ContactProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message:
      'Quiero evaluar AgroScore para analizar lotes internos y generar reportes técnicos.',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContactController],
      providers: [
        {
          provide: ContactService,
          useValue: { sendContactRequest: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ContactController);
    contactService = module.get(ContactService);
  });

  it('delega en ContactService.sendContactRequest con el DTO recibido', async () => {
    contactService.sendContactRequest.mockResolvedValue({
      ok: true,
      message: 'Consulta enviada correctamente',
    });

    const result = await controller.create(dto);

    expect(contactService.sendContactRequest).toHaveBeenCalledWith(dto);
    expect(result).toEqual({
      ok: true,
      message: 'Consulta enviada correctamente',
    });
  });

  it('propaga la respuesta de error genérico del service', async () => {
    contactService.sendContactRequest.mockResolvedValue({
      ok: false,
      message: 'No pudimos enviar la consulta en este momento',
    });

    const result = await controller.create(dto);

    expect(result).toEqual({
      ok: false,
      message: 'No pudimos enviar la consulta en este momento',
    });
  });
});
