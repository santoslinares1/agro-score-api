import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { EmailService } from '../email/email.service';
import { AccessRequestProfile } from './access-request-profile.enum';
import { AccessRequestService } from './access-request.service';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { AccessRequest } from './entities/access-request.entity';

const accessRequestRepositoryMock = {
  create: jest.fn((data: Partial<AccessRequest>) => data),
  save: jest.fn((data: Partial<AccessRequest>) =>
    Promise.resolve({ id: 'access-request-1', ...data }),
  ),
};

const emailServiceMock = {
  sendAccessRequestNotification: jest.fn(),
};

describe('AccessRequestService', () => {
  let service: AccessRequestService;

  const dto: CreateAccessRequestDto = {
    name: '  Santos Linares  ',
    email: '  santos9linares@gmail.com  ',
    organization: 'Campo La Esperanza',
    profile: AccessRequestProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message: 'Quiero probar AgroScore para diagnosticar lotes internos.',
  };

  beforeEach(async () => {
    accessRequestRepositoryMock.create.mockClear();
    accessRequestRepositoryMock.save.mockClear();
    emailServiceMock.sendAccessRequestNotification.mockReset();
    emailServiceMock.sendAccessRequestNotification.mockResolvedValue({
      sent: true,
      provider: 'smtp',
      dryRun: true,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessRequestService,
        { provide: EmailService, useValue: emailServiceMock },
        {
          provide: getRepositoryToken(AccessRequest),
          useValue: accessRequestRepositoryMock,
        },
      ],
    }).compile();

    service = module.get(AccessRequestService);
  });

  it('persiste la solicitud en DB antes de intentar el envío de mail (ADMIN-1)', async () => {
    await service.sendAccessRequest(dto);

    expect(accessRequestRepositoryMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Santos Linares',
        email: 'santos9linares@gmail.com',
        organization: 'Campo La Esperanza',
        profile: AccessRequestProfile.PRODUCER,
      }),
    );
  });

  it('delega el envío en EmailService.sendAccessRequestNotification con el DTO recibido', async () => {
    await service.sendAccessRequest(dto);

    expect(emailServiceMock.sendAccessRequestNotification).toHaveBeenCalledWith(
      dto,
    );
  });

  it('usa valores por defecto cuando estimatedSurface y message son opcionales y faltan', async () => {
    const rest: CreateAccessRequestDto = {
      ...dto,
      estimatedSurface: undefined,
      message: undefined,
    };
    await service.sendAccessRequest(rest);

    expect(accessRequestRepositoryMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedSurface: undefined,
        message: undefined,
      }),
    );
  });

  it('devuelve ok:true cuando EmailService reporta sent:true', async () => {
    emailServiceMock.sendAccessRequestNotification.mockResolvedValue({
      sent: true,
      provider: 'smtp',
      dryRun: false,
      messageId: 'msg-1',
    });

    const result = await service.sendAccessRequest(dto);

    expect(result).toEqual({
      ok: true,
      message: 'Solicitud enviada correctamente',
    });
  });

  it('devuelve ok:false sin exponer detalle interno cuando EmailService reporta sent:false', async () => {
    emailServiceMock.sendAccessRequestNotification.mockResolvedValue({
      sent: false,
      provider: 'smtp',
      dryRun: false,
    });

    const result = await service.sendAccessRequest(dto);

    expect(result).toEqual({
      ok: false,
      message: 'No pudimos enviar la solicitud en este momento',
    });
  });
});
