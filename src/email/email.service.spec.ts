import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { EmailService } from './email.service';

interface SentEmailCall {
  to: string;
  from: string;
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

const invitationParams = {
  invitationUrl: 'https://agroscorelatam.com/accept-invitation?token=super-secreto-no-debe-loguearse',
  expiresAt: new Date('2026-08-14T00:00:00Z'),
};

const resetParams = {
  resetUrl: 'https://agroscorelatam.com/reset-password?token=otro-secreto-no-debe-loguearse',
  expiresAt: new Date('2026-08-07T02:00:00Z'),
};

describe('EmailService', () => {
  let service: EmailService;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const buildService = async (envOverrides: Record<string, string | undefined> = {}) => {
    const env: Record<string, string | undefined> = {
      EMAIL_FROM: 'AgroScore <no-reply@agroscorelatam.com>',
      EMAIL_DRY_RUN: 'true',
      RESEND_API_KEY: undefined,
      ...envOverrides,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      ],
    }).compile();

    return module.get(EmailService);
  };

  beforeEach(() => {
    sendMock.mockReset();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('dry-run', () => {
    it('no llama a Resend y devuelve sent/dryRun correctos', async () => {
      service = await buildService({ EMAIL_DRY_RUN: 'true' });

      const result = await service.sendInvitationEmail(
        'invitado@example.com',
        invitationParams,
      );

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: true, provider: 'resend', dryRun: true });
    });

    it('nunca loguea el link/token completo — solo destinatario/remitente/asunto', async () => {
      service = await buildService({ EMAIL_DRY_RUN: 'true' });

      await service.sendInvitationEmail('invitado@example.com', invitationParams);

      const loggedText = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(loggedText).toContain('invitado@example.com');
      expect(loggedText).not.toContain('super-secreto-no-debe-loguearse');
    });

    it('no requiere RESEND_API_KEY', async () => {
      service = await buildService({ EMAIL_DRY_RUN: 'true', RESEND_API_KEY: undefined });

      await expect(
        service.sendPasswordResetEmail('user@example.com', resetParams),
      ).resolves.toMatchObject({ sent: true, dryRun: true });
    });

    it('default dry-run=true si ni EMAIL_DRY_RUN ni CONTACT_EMAIL_DRY_RUN están seteadas', async () => {
      service = await buildService({ EMAIL_DRY_RUN: undefined });

      const result = await service.sendInvitationEmail('invitado@example.com', invitationParams);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result.dryRun).toBe(true);
    });

    it('cae a CONTACT_EMAIL_DRY_RUN si EMAIL_DRY_RUN no está seteada', async () => {
      service = await buildService({ EMAIL_DRY_RUN: undefined, CONTACT_EMAIL_DRY_RUN: 'false' });
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });

      const result = await service.sendInvitationEmail('invitado@example.com', {
        ...invitationParams,
      });

      // RESEND_API_KEY sigue sin estar seteada acá, así que igual falla al
      // intentar mandar de verdad — lo importante es que *intentó* (no dry-run).
      expect(result.dryRun).toBe(false);
    });
  });

  describe('modo real', () => {
    it('manda con to/from/subject/html/text y devuelve messageId', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      service = await buildService({ EMAIL_DRY_RUN: 'false', RESEND_API_KEY: 're_test_key' });

      const result = await service.sendInvitationEmail('invitado@example.com', invitationParams);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = lastSentEmail();
      expect(call.to).toBe('invitado@example.com');
      expect(call.from).toBe('AgroScore <no-reply@agroscorelatam.com>');
      expect(call.subject).toBe('Te invitaron a AgroScore');
      expect(call.html).toContain(invitationParams.invitationUrl);
      expect(call.text).toContain(invitationParams.invitationUrl);
      expect(result).toEqual({
        sent: true,
        provider: 'resend',
        dryRun: false,
        messageId: 'email-1',
      });
    });

    it('sendPasswordResetEmail usa el subject/contenido del template de reset', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-2' }, error: null });
      service = await buildService({ EMAIL_DRY_RUN: 'false', RESEND_API_KEY: 're_test_key' });

      await service.sendPasswordResetEmail('user@example.com', resetParams);

      const call = lastSentEmail();
      expect(call.subject).toBe('Restablecé tu contraseña de AgroScore');
      expect(call.html).toContain(resetParams.resetUrl);
    });

    it('si falta RESEND_API_KEY devuelve sent:false sin lanzar', async () => {
      service = await buildService({ EMAIL_DRY_RUN: 'false', RESEND_API_KEY: undefined });

      const result = await service.sendInvitationEmail('invitado@example.com', invitationParams);

      expect(sendMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: false, dryRun: false });
    });

    it('un error de Resend se refleja en sent:false sin lanzar', async () => {
      sendMock.mockResolvedValue({ data: null, error: { message: 'Resend down' } });
      service = await buildService({ EMAIL_DRY_RUN: 'false', RESEND_API_KEY: 're_test_key' });

      const result = await service.sendInvitationEmail('invitado@example.com', invitationParams);

      expect(result).toEqual({ sent: false, provider: 'resend', dryRun: false });
    });

    it('EMAIL_FROM tiene prioridad; sin ella cae a CONTACT_FROM_EMAIL', async () => {
      sendMock.mockResolvedValue({ data: { id: 'email-3' }, error: null });
      service = await buildService({
        EMAIL_DRY_RUN: 'false',
        RESEND_API_KEY: 're_test_key',
        EMAIL_FROM: undefined,
        CONTACT_FROM_EMAIL: 'AgroScore <onboarding@resend.dev>',
      });

      await service.sendInvitationEmail('invitado@example.com', invitationParams);

      expect(lastSentEmail().from).toBe('AgroScore <onboarding@resend.dev>');
    });
  });
});
