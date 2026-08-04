import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessRequestProfile } from './access-request-profile.enum';
import { AccessRequestService } from './access-request.service';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';
import { AccessRequest } from './entities/access-request.entity';

interface SentEmailCall {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
}

interface SentEmailResult {
  data: { id: string } | null;
  error: { message: string } | null;
}

const sendMock = jest.fn<Promise<SentEmailResult>, [SentEmailCall]>();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

function lastSentEmail(): SentEmailCall {
  return sendMock.mock.calls[0][0];
}

const accessRequestRepositoryMock = {
  create: jest.fn((data: Partial<AccessRequest>) => data),
  save: jest.fn((data: Partial<AccessRequest>) =>
    Promise.resolve({ id: 'access-request-1', ...data }),
  ),
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

  const buildService = async (
    envOverrides: Record<string, string | undefined> = {},
  ) => {
    const env: Record<string, string | undefined> = {
      CONTACT_TO_EMAIL: 'agroscorelatam@gmail.com',
      CONTACT_FROM_EMAIL: 'AgroScore <onboarding@resend.dev>',
      CONTACT_EMAIL_DRY_RUN: 'true',
      RESEND_API_KEY: undefined,
      ...envOverrides,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccessRequestService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
        {
          provide: getRepositoryToken(AccessRequest),
          useValue: accessRequestRepositoryMock,
        },
      ],
    }).compile();

    return module.get(AccessRequestService);
  };

  beforeEach(() => {
    sendMock.mockReset();
    accessRequestRepositoryMock.create.mockClear();
    accessRequestRepositoryMock.save.mockClear();
  });

  it('persiste la solicitud en DB antes de intentar el envío de mail (ADMIN-1)', async () => {
    service = await buildService({ CONTACT_EMAIL_DRY_RUN: 'true' });

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

  describe('dry-run', () => {
    it('no llama a Resend y devuelve ok', async () => {
      service = await buildService({ CONTACT_EMAIL_DRY_RUN: 'true' });

      const result = await service.sendAccessRequest(dto);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        message: 'Solicitud enviada correctamente',
      });
    });

    it('no requiere RESEND_API_KEY', async () => {
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'true',
        RESEND_API_KEY: undefined,
      });

      await expect(service.sendAccessRequest(dto)).resolves.toEqual({
        ok: true,
        message: 'Solicitud enviada correctamente',
      });
    });
  });

  describe('modo real', () => {
    it('construye el mail con to/from/replyTo/subject/html/text correctos', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const result = await service.sendAccessRequest(dto);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = lastSentEmail();
      expect(call.to).toBe('agroscorelatam@gmail.com');
      expect(call.from).toBe('AgroScore <onboarding@resend.dev>');
      expect(call.replyTo).toBe('santos9linares@gmail.com');
      expect(call.subject).toBe('Solicitud de acceso — AgroScore');
      expect(typeof call.html).toBe('string');
      expect(typeof call.text).toBe('string');
      expect(call.html.length).toBeGreaterThan(0);
      expect(call.text.length).toBeGreaterThan(0);
      expect(result).toEqual({
        ok: true,
        message: 'Solicitud enviada correctamente',
      });
    });

    it('nunca usa el email del usuario como from', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      await service.sendAccessRequest(dto);

      const call = lastSentEmail();
      expect(call.from).not.toBe(dto.email.trim());
      expect(call.from).toBe('AgroScore <onboarding@resend.dev>');
    });

    it('usa valores por defecto cuando estimatedSurface y message son opcionales y faltan', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const { estimatedSurface, message, ...rest } = dto;
      await service.sendAccessRequest(rest as CreateAccessRequestDto);

      const call = lastSentEmail();
      expect(call.text).toContain('No especificada');
      expect(call.text).toContain('Sin mensaje adicional');
    });

    it('escapa HTML en los campos del usuario (protección XSS)', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const malicious: CreateAccessRequestDto = {
        ...dto,
        message: '<script>alert(1)</script> mensaje malicioso',
      };
      await service.sendAccessRequest(malicious);

      const call = lastSentEmail();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    it('quita saltos de línea del replyTo (protección header injection)', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const withNewlines: CreateAccessRequestDto = {
        ...dto,
        email: 'santos9linares@gmail.com\r\nBcc: attacker@evil.com',
      };
      await service.sendAccessRequest(withNewlines);

      const call = lastSentEmail();
      expect(call.replyTo).not.toMatch(/[\r\n]/);
    });

    it('si falta RESEND_API_KEY devuelve error controlado sin llamar a Resend', async () => {
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: undefined,
      });

      const result = await service.sendAccessRequest(dto);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        message: 'No pudimos enviar la solicitud en este momento',
      });
    });

    it('convierte un error de Resend en una respuesta genérica sin exponer detalles', async () => {
      sendMock.mockResolvedValue({
        data: null,
        error: { message: 'Resend down: internal detail not for clients' },
      });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const result = await service.sendAccessRequest(dto);

      expect(result).toEqual({
        ok: false,
        message: 'No pudimos enviar la solicitud en este momento',
      });
      expect(result.message).not.toContain('internal detail');
    });
  });
});
