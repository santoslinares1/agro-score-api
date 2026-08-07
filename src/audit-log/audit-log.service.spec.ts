import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from './audit-log.service';
import { AdminAuditLog } from './entities/admin-audit-log.entity';

// ADMIN-2: red de seguridad explícita pedida por la consigna — "no guardar
// secretos, passwords, tokens ni hashes en before/after", sin importar qué
// le pase el caller.
describe('AuditLogService — sanitize (ADMIN-2)', () => {
  let service: AuditLogService;
  let repo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = { create: jest.fn((v: unknown) => v), save: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: getRepositoryToken(AdminAuditLog), useValue: repo },
      ],
    }).compile();

    service = module.get(AuditLogService);
  });

  it('omite passwordHash/token/tokenHash en objetos planos', async () => {
    await service.record({
      actor: { actorUserId: 'admin-1' },
      action: 'admin.user.created',
      targetType: 'user',
      targetId: 'user-1',
      after: {
        email: 'a@b.com',
        passwordHash: 'super-secreto',
        tokenHash: 'otro-secreto',
        password: 'texto-plano',
      },
    });

    const saved = repo.create.mock.calls[0][0];
    expect(saved.after).toEqual({ email: 'a@b.com' });
  });

  it('omite claims sensibles anidadas dentro de objetos/arrays', async () => {
    await service.record({
      actor: { actorUserId: 'admin-1' },
      action: 'admin.invitation.created',
      targetType: 'invitation',
      targetId: 'invitation-1',
      after: {
        email: 'a@b.com',
        nested: { token: 'secreto-anidado', role: 'admin' },
        list: [{ resetToken: 'otro-anidado', id: 1 }],
      },
    });

    const saved = repo.create.mock.calls[0][0];
    expect(saved.after).toEqual({
      email: 'a@b.com',
      nested: { role: 'admin' },
      list: [{ id: 1 }],
    });
  });

  it('guarda null en vez de undefined/objeto vacío cuando no hay before/after', async () => {
    await service.record({
      actor: { actorUserId: 'admin-1' },
      action: 'admin.password_reset.created',
      targetType: 'user',
      targetId: 'user-1',
    });

    const saved = repo.create.mock.calls[0][0];
    expect(saved.before).toBeNull();
    expect(saved.after).toBeNull();
  });

  it('persiste actor/action/target/ip/userAgent tal cual', async () => {
    await service.record({
      actor: { actorUserId: 'admin-1', ip: '10.0.0.1', userAgent: 'jest-agent' },
      action: 'admin.user.deactivated',
      targetType: 'user',
      targetId: 'user-2',
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin-1',
        action: 'admin.user.deactivated',
        targetType: 'user',
        targetId: 'user-2',
        ip: '10.0.0.1',
        userAgent: 'jest-agent',
      }),
    );
    expect(repo.save).toHaveBeenCalled();
  });
});
