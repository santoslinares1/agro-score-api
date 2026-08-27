import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { AccessRequestProfile } from '../access-request/access-request-profile.enum';
import { CreateAccessRequestDto } from '../access-request/dto/create-access-request.dto';
import { ContactProfile } from '../contact/contact-profile.enum';
import { CreateContactDto } from '../contact/dto/create-contact.dto';
import { EmailService } from './email.service';

interface SentMailCall {
  to: string;
  from: string;
  replyTo?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: unknown[];
}

const sendMailMock = jest.fn<Promise<{ messageId: string }>, [SentMailCall]>();
const createTransportMock = jest.fn(() => ({ sendMail: sendMailMock }));

// nodemailer es un módulo CJS plano (module.exports.createTransport = ...), sin __esModule — se
// mockea con la misma forma para que el interop de esModuleInterop lo resuelva igual que en
// runtime real.
jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => createTransportMock(...args),
}));

function lastSentMail(): SentMailCall {
  return sendMailMock.mock.calls[sendMailMock.mock.calls.length - 1][0];
}

const invitationParams = {
  invitationUrl:
    'https://agroscorelatam.com/accept-invitation?token=super-secreto-no-debe-loguearse',
  expiresAt: new Date('2026-08-14T00:00:00Z'),
};

const resetParams = {
  resetUrl:
    'https://agroscorelatam.com/reset-password?token=otro-secreto-no-debe-loguearse',
  expiresAt: new Date('2026-08-07T02:00:00Z'),
};

const scheduledAnalysisParams = {
  userName: 'Santos',
  fieldName: 'Campo La Esperanza',
  weekStart: '2026-08-10',
  weekEnd: '2026-08-16',
  analysisUrl: 'https://agroscorelatam.com/app/analysis/1',
  reportUrl: 'https://agroscorelatam.com/app/analysis/1/report',
  dataQualityStatus: 'sufficient' as const,
  hasRgbImage: true,
  hasNdviImage: true,
  hasNdmiImage: true,
  hasImageSeries: true,
  summary: ['NDVI subió 0.05 respecto de la semana anterior.'],
};

const accessRequestDto: CreateAccessRequestDto = {
  name: 'Santos Linares',
  email: 'santos9linares@gmail.com',
  organization: 'Campo La Esperanza',
  profile: AccessRequestProfile.PRODUCER,
  estimatedSurface: '120 ha',
  message: 'Quiero probar AgroScore.',
};

const contactDto: CreateContactDto = {
  name: 'Santos Linares',
  email: 'santos9linares@gmail.com',
  companyOrField: 'Campo La Esperanza',
  profile: ContactProfile.PRODUCER,
  estimatedSurface: '120 ha',
  message:
    'Quiero evaluar AgroScore para analizar lotes internos y generar reportes.',
};

const SMTP_ENV = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'slinares@agroscorelatam.com',
  SMTP_PASS: 'app-password-secreta-no-debe-loguearse',
};

describe('EmailService', () => {
  let service: EmailService;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const buildService = async (
    envOverrides: Record<string, string | undefined> = {},
  ) => {
    const env: Record<string, string | undefined> = {
      MAIL_FROM: 'no-reply@agroscorelatam.com',
      MAIL_REPLY_TO: 'contacto@agroscorelatam.com',
      CONTACT_EMAIL: 'contacto@agroscorelatam.com',
      MAIL_DRY_RUN: 'true',
      ...envOverrides,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();

    return module.get(EmailService);
  };

  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('dry-run', () => {
    it('no llama al transporte SMTP y devuelve sent/dryRun correctos', async () => {
      service = await buildService({ MAIL_DRY_RUN: 'true' });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: true, provider: 'smtp', dryRun: true });
    });

    it('nunca loguea el link/token completo — solo destinatario/remitente/asunto', async () => {
      service = await buildService({ MAIL_DRY_RUN: 'true' });

      await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      const loggedText = (logSpy.mock.calls as unknown[][])
        .map((call) => String(call[0]))
        .join('\n');
      expect(loggedText).toContain('invitado@example.com');
      expect(loggedText).not.toContain('super-secreto-no-debe-loguearse');
    });

    it('no requiere config SMTP', async () => {
      service = await buildService({
        MAIL_DRY_RUN: 'true',
        SMTP_PASS: undefined,
      });

      await expect(
        service.sendPasswordResetEmail('user@example.com', resetParams),
      ).resolves.toMatchObject({ sent: true, dryRun: true });
    });

    it('default dry-run=true si ninguna variable de dry-run está seteada', async () => {
      service = await buildService({ MAIL_DRY_RUN: undefined });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
    });

    it('cae a EMAIL_DRY_RUN y luego a CONTACT_EMAIL_DRY_RUN si MAIL_DRY_RUN no está seteada', async () => {
      service = await buildService({
        MAIL_DRY_RUN: undefined,
        EMAIL_DRY_RUN: undefined,
        CONTACT_EMAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
      });
      sendMailMock.mockResolvedValue({ messageId: 'email-1' });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(result.dryRun).toBe(false);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('modo real — transacción (invitación/reset)', () => {
    it('manda con to/from/replyTo/subject/html/text y devuelve messageId', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'email-1' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const call = lastSentMail();
      expect(call.to).toBe('invitado@example.com');
      expect(call.from).toBe('no-reply@agroscorelatam.com');
      expect(call.replyTo).toBe('contacto@agroscorelatam.com');
      expect(call.subject).toBe('Te invitaron a AgroScore');
      expect(call.html).toContain(invitationParams.invitationUrl);
      expect(call.text).toContain(invitationParams.invitationUrl);
      expect(result).toEqual({
        sent: true,
        provider: 'smtp',
        dryRun: false,
        messageId: 'email-1',
      });
    });

    it('sendPasswordResetEmail usa MAIL_FROM y MAIL_REPLY_TO', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'email-2' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendPasswordResetEmail('user@example.com', resetParams);

      const call = lastSentMail();
      expect(call.subject).toBe('Restablecé tu contraseña de AgroScore');
      expect(call.html).toContain(resetParams.resetUrl);
      expect(call.from).toBe('no-reply@agroscorelatam.com');
      expect(call.replyTo).toBe('contacto@agroscorelatam.com');
    });

    it('si falta config SMTP devuelve sent:false sin lanzar, y no loguea SMTP_PASS', async () => {
      service = await buildService({
        MAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
        SMTP_PASS: undefined,
      });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(sendMailMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: false, dryRun: false });
      const loggedErrors = (errorSpy.mock.calls as unknown[][])
        .map((call) => String(call[0]))
        .join('\n');
      expect(loggedErrors).toContain('SMTP_PASS');
      expect(loggedErrors).not.toContain(SMTP_ENV.SMTP_PASS);
    });

    it('un error del transporte SMTP se refleja en sent:false sin lanzar', async () => {
      sendMailMock.mockRejectedValue(new Error('SMTP connection refused'));
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(result).toEqual({ sent: false, provider: 'smtp', dryRun: false });
    });

    it('MAIL_FROM tiene prioridad; sin ella cae a EMAIL_FROM y luego a CONTACT_FROM_EMAIL', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'email-3' });
      service = await buildService({
        MAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
        MAIL_FROM: undefined,
        CONTACT_FROM_EMAIL: 'AgroScore <onboarding@old-provider.dev>',
      });

      await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(lastSentMail().from).toBe(
        'AgroScore <onboarding@old-provider.dev>',
      );
    });

    it('la autenticación SMTP siempre usa SMTP_USER, nunca CONTACT_EMAIL ni REPORTS_BCC_EMAIL', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'email-4' });
      service = await buildService({
        MAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
        CONTACT_EMAIL: 'contacto@agroscorelatam.com',
        REPORTS_BCC_EMAIL: 'reportes@agroscorelatam.com',
      });

      await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: {
            user: 'slinares@agroscorelatam.com',
            pass: SMTP_ENV.SMTP_PASS,
          },
        }),
      );
    });
  });

  describe('reporte semanal automático', () => {
    it('usa MAIL_FROM como from', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'report-1' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendScheduledAnalysisEmail(
        'user@example.com',
        scheduledAnalysisParams,
      );

      expect(lastSentMail().from).toBe('no-reply@agroscorelatam.com');
    });

    it('usa MAIL_REPLY_TO como reply-to', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'report-2' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendScheduledAnalysisEmail(
        'user@example.com',
        scheduledAnalysisParams,
      );

      expect(lastSentMail().replyTo).toBe('contacto@agroscorelatam.com');
    });

    it('agrega REPORTS_BCC_EMAIL como bcc si está configurado', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'report-3' });
      service = await buildService({
        MAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
        REPORTS_BCC_EMAIL: 'reportes@agroscorelatam.com',
      });

      await service.sendScheduledAnalysisEmail(
        'user@example.com',
        scheduledAnalysisParams,
      );

      expect(lastSentMail().bcc).toBe('reportes@agroscorelatam.com');
    });

    it('no agrega bcc si REPORTS_BCC_EMAIL está vacío/no configurado', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'report-4' });
      service = await buildService({
        MAIL_DRY_RUN: 'false',
        ...SMTP_ENV,
        REPORTS_BCC_EMAIL: undefined,
      });

      const result = await service.sendScheduledAnalysisEmail(
        'user@example.com',
        scheduledAnalysisParams,
      );

      expect(lastSentMail().bcc).toBeUndefined();
      expect(result.sent).toBe(true);
    });
  });

  describe('sendAccessRequestNotification', () => {
    it('envía a CONTACT_EMAIL, no a SMTP_USER', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-1' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification(accessRequestDto);

      const call = lastSentMail();
      expect(call.to).toBe('contacto@agroscorelatam.com');
      expect(call.to).not.toBe(SMTP_ENV.SMTP_USER);
    });

    it('usa MAIL_FROM como from', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-2' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification(accessRequestDto);

      expect(lastSentMail().from).toBe('no-reply@agroscorelatam.com');
    });

    it('usa el email del solicitante como reply-to cuando existe', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-3' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification(accessRequestDto);

      expect(lastSentMail().replyTo).toBe('santos9linares@gmail.com');
    });

    it('cae a MAIL_REPLY_TO si el solicitante no tiene email válido', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-4' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification({
        ...accessRequestDto,
        email: '',
      });

      expect(lastSentMail().replyTo).toBe('contacto@agroscorelatam.com');
    });

    it('escapa HTML en los campos del usuario (protección XSS)', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-5' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification({
        ...accessRequestDto,
        message: '<script>alert(1)</script>',
      });

      const call = lastSentMail();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    it('quita saltos de línea del reply-to del solicitante (protección header injection)', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-6' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification({
        ...accessRequestDto,
        email: 'santos9linares@gmail.com\r\nBcc: attacker@evil.com',
      });

      expect(lastSentMail().replyTo).not.toMatch(/[\r\n]/);
    });

    it('usa valores por defecto cuando estimatedSurface y message faltan', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-7' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      const rest: CreateAccessRequestDto = {
        ...accessRequestDto,
        estimatedSurface: undefined,
        message: undefined,
      };
      await service.sendAccessRequestNotification(rest);

      const call = lastSentMail();
      expect(call.text).toContain('No especificada');
      expect(call.text).toContain('Sin mensaje adicional');
    });

    it('nunca usa el subject dinámico — es fijo y no depende de input de usuario', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'access-8' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendAccessRequestNotification(accessRequestDto);

      expect(lastSentMail().subject).toBe(
        'Nueva solicitud de acceso · AgroScore',
      );
    });
  });

  describe('sendContactInquiry', () => {
    it('envía a CONTACT_EMAIL, no a SMTP_USER', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'contact-1' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendContactInquiry(contactDto);

      const call = lastSentMail();
      expect(call.to).toBe('contacto@agroscorelatam.com');
      expect(call.to).not.toBe(SMTP_ENV.SMTP_USER);
    });

    it('usa el email del consultante como reply-to', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'contact-2' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendContactInquiry(contactDto);

      expect(lastSentMail().replyTo).toBe('santos9linares@gmail.com');
    });

    it('escapa HTML en los campos del usuario (protección XSS)', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'contact-3' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendContactInquiry({
        ...contactDto,
        message:
          '<script>alert(1)</script> mensaje malicioso pero suficientemente largo',
      });

      const call = lastSentMail();
      expect(call.html).not.toContain('<script>');
      expect(call.html).toContain('&lt;script&gt;');
    });

    it('quita saltos de línea del subject (protección header injection)', async () => {
      sendMailMock.mockResolvedValue({ messageId: 'contact-4' });
      service = await buildService({ MAIL_DRY_RUN: 'false', ...SMTP_ENV });

      await service.sendContactInquiry({
        ...contactDto,
        companyOrField: 'Campo\r\nBcc: attacker@evil.com',
      });

      expect(lastSentMail().subject).not.toMatch(/[\r\n]/);
    });
  });
});
