import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AccessRequestProfile } from './access-request-profile.enum';
import { AccessRequestController } from './access-request.controller';
import { AccessRequestService } from './access-request.service';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';

describe('AccessRequestController', () => {
  let controller: AccessRequestController;
  let accessRequestService: jest.Mocked<
    Pick<AccessRequestService, 'sendAccessRequest'>
  >;

  const dto: CreateAccessRequestDto = {
    name: 'Santos Linares',
    email: 'santos9linares@gmail.com',
    organization: 'Campo La Esperanza',
    profile: AccessRequestProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message: 'Quiero probar AgroScore para diagnosticar lotes internos.',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }]),
      ],
      controllers: [AccessRequestController],
      providers: [
        {
          provide: AccessRequestService,
          useValue: { sendAccessRequest: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(AccessRequestController);
    accessRequestService = module.get(AccessRequestService);
  });

  it('delega en AccessRequestService.sendAccessRequest con el DTO recibido', async () => {
    accessRequestService.sendAccessRequest.mockResolvedValue({
      ok: true,
      message: 'Solicitud enviada correctamente',
    });

    const result = await controller.create(dto);

    expect(accessRequestService.sendAccessRequest).toHaveBeenCalledWith(dto);
    expect(result).toEqual({
      ok: true,
      message: 'Solicitud enviada correctamente',
    });
  });

  it('propaga la respuesta de error genérico del service', async () => {
    accessRequestService.sendAccessRequest.mockResolvedValue({
      ok: false,
      message: 'No pudimos enviar la solicitud en este momento',
    });

    const result = await controller.create(dto);

    expect(result).toEqual({
      ok: false,
      message: 'No pudimos enviar la solicitud en este momento',
    });
  });

  // ACCESS-REQUEST-1: POST /access-request es público — debe quedar atado a
  // ThrottlerGuard con un límite explícito para mitigar spam/flood básico.
  it('POST /access-request tiene ThrottlerGuard con límite de 3 req/min', () => {
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
