import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

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
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
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

  // SEC-003: POST /contact es público — debe quedar atado a ThrottlerGuard
  // con un límite explícito para mitigar spam/flood básico.
  it('POST /contact tiene ThrottlerGuard con límite de 3 req/min', () => {
    const create = (controller as unknown as Record<string, () => unknown>)
      .create;

    const guards = Reflect.getMetadata(GUARDS_METADATA, create) as
      | unknown[]
      | undefined;
    expect(guards).toContain(ThrottlerGuard);

    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', create)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', create)).toBe(60_000);
  });
});
