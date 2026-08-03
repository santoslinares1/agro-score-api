import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ContactProfile } from './contact-profile.enum';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

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
        ContactService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();

    return module.get(ContactService);
  };

  beforeEach(() => {
    sendMock.mockReset();
  });

  describe('dry-run', () => {
    it('no llama a Resend y devuelve ok', async () => {
      service = await buildService({ CONTACT_EMAIL_DRY_RUN: 'true' });

      const result = await service.sendContactRequest(dto);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: true,
        message: 'Consulta enviada correctamente',
      });
    });

    it('no requiere RESEND_API_KEY', async () => {
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'true',
        RESEND_API_KEY: undefined,
      });

      await expect(service.sendContactRequest(dto)).resolves.toEqual({
        ok: true,
        message: 'Consulta enviada correctamente',
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

      const result = await service.sendContactRequest(dto);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = lastSentEmail();
      expect(call.to).toBe('agroscorelatam@gmail.com');
      expect(call.from).toBe('AgroScore <onboarding@resend.dev>');
      expect(call.replyTo).toBe('santos9linares@gmail.com');
      expect(call.subject).toContain('Productor');
      expect(call.subject).toContain('Campo La Esperanza');
      expect(typeof call.html).toBe('string');
      expect(typeof call.text).toBe('string');
      expect(call.html.length).toBeGreaterThan(0);
      expect(call.text.length).toBeGreaterThan(0);
      expect(result).toEqual({
        ok: true,
        message: 'Consulta enviada correctamente',
      });
    });

    it('nunca usa el email del usuario como from', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      await service.sendContactRequest(dto);

      const call = lastSentEmail();
      expect(call.from).not.toBe(dto.email.trim());
      expect(call.from).toBe('AgroScore <onboarding@resend.dev>');
    });

    it('escapa HTML en los campos del usuario (protección XSS)', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const malicious: CreateContactDto = {
        ...dto,
        message:
          '<script>alert(1)</script> mensaje malicioso pero suficientemente largo',
      };
      await service.sendContactRequest(malicious);

      const call = lastSentEmail();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    it('quita saltos de línea del subject (protección header injection)', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
      });

      const withNewlines: CreateContactDto = {
        ...dto,
        companyOrField: 'Campo\r\nBcc: attacker@evil.com',
      };
      await service.sendContactRequest(withNewlines);

      const call = lastSentEmail();
      expect(call.subject).not.toMatch(/[\r\n]/);
    });

    it('si falta RESEND_API_KEY devuelve error controlado sin llamar a Resend', async () => {
      service = await buildService({
        CONTACT_EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: undefined,
      });

      const result = await service.sendContactRequest(dto);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        message: 'No pudimos enviar la consulta en este momento',
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

      const result = await service.sendContactRequest(dto);

      expect(result).toEqual({
        ok: false,
        message: 'No pudimos enviar la consulta en este momento',
      });
      expect(result.message).not.toContain('internal detail');
    });
  });
});
