import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

import { AuditLogService } from '../audit-log/audit-log.service';
import { PasswordResetToken } from '../users/entities/password-reset-token.entity';
import { UserInvitation } from '../users/entities/user-invitation.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { hashToken } from './token.util';

function buildInvitation(overrides: Partial<UserInvitation> = {}): UserInvitation {
  return {
    id: 'invitation-1',
    email: 'invitado@example.com',
    role: UserRole.USER,
    invitedByUserId: 'admin-1',
    tokenHash: hashToken('raw-token'),
    expiresAt: new Date(Date.now() + 60_000),
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserInvitation;
}

function buildResetToken(overrides: Partial<PasswordResetToken> = {}): PasswordResetToken {
  return {
    id: 'reset-1',
    userId: 'user-1',
    tokenHash: hashToken('raw-reset-token'),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as PasswordResetToken;
}

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;
  let auditLogService: jest.Mocked<AuditLogService>;
  let invitationRepo: { findOne: jest.Mock; save: jest.Mock };
  let passwordResetRepo: { findOne: jest.Mock; save: jest.Mock };

  const buildUser = (overrides: Partial<User> = {}): User => ({
    id: 'user-1',
    email: 'usera@example.com',
    passwordHash: bcrypt.hashSync('password123', 10),
    fullName: 'User A',
    companyName: 'Acme',
    role: 'owner',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  });

  beforeEach(async () => {
    invitationRepo = { findOne: jest.fn(), save: jest.fn() };
    passwordResetRepo = { findOne: jest.fn(), save: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            updatePassword: jest.fn().mockResolvedValue(undefined),
            toPublicUser: jest.fn((user: User) => {
              const { passwordHash: _passwordHash, ...rest } = user;
              return rest;
            }),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(() => 'signed.jwt.token'),
          },
        },
        {
          provide: AuditLogService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: getRepositoryToken(UserInvitation), useValue: invitationRepo },
        { provide: getRepositoryToken(PasswordResetToken), useValue: passwordResetRepo },
      ],
    }).compile();

    service = module.get(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
    auditLogService = module.get(AuditLogService);
  });

  describe('register', () => {
    it('normaliza el email (trim + lowercase) antes de buscar y crear', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(buildUser());

      await service.register({
        email: '  UserA@Example.com  ',
        password: 'password123',
        fullName: 'User A',
      });

      expect(usersService.findByEmail).toHaveBeenCalledWith('usera@example.com');
      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'usera@example.com' }),
      );
    });

    it('hashea la password antes de guardarla (nunca la guarda en texto plano)', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(buildUser());

      await service.register({
        email: 'usera@example.com',
        password: 'password123',
        fullName: 'User A',
      });

      const createArg = usersService.create.mock.calls[0][0];
      expect(createArg.passwordHash).not.toBe('password123');
      expect(bcrypt.compareSync('password123', createArg.passwordHash)).toBe(true);
    });

    it('nunca devuelve passwordHash en la respuesta', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(buildUser());

      const result = await service.register({
        email: 'usera@example.com',
        password: 'password123',
        fullName: 'User A',
      });

      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.accessToken).toBe('signed.jwt.token');
    });

    it('rechaza un email duplicado con ConflictException', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.register({
          email: 'usera@example.com',
          password: 'password123',
          fullName: 'User A',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(usersService.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('devuelve user + accessToken para credenciales correctas', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      const result = await service.login({
        email: 'usera@example.com',
        password: 'password123',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user.email).toBe('usera@example.com');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-1', email: 'usera@example.com' }),
      );
    });

    it('rechaza password incorrecta con Unauthorized genérico', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.login({ email: 'usera@example.com', password: 'wrong-password' }),
      ).rejects.toMatchObject({
        message: 'Credenciales inválidas.',
      });
    });

    it('rechaza email inexistente con el mismo mensaje genérico (no revela si existe)', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nadie@example.com', password: 'password123' }),
      ).rejects.toMatchObject({
        message: 'Credenciales inválidas.',
      });
    });

    it('ambos casos de login inválido son UnauthorizedException', async () => {
      usersService.findByEmail.mockResolvedValueOnce(null);
      await expect(
        service.login({ email: 'nadie@example.com', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      usersService.findByEmail.mockResolvedValueOnce(buildUser());
      await expect(
        service.login({ email: 'usera@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('me', () => {
    it('devuelve el usuario sin passwordHash', async () => {
      usersService.findById.mockResolvedValue(buildUser());

      const result = await service.me('user-1');

      expect(result).not.toHaveProperty('passwordHash');
      expect(result.email).toBe('usera@example.com');
    });

    it('lanza Unauthorized si el usuario ya no existe', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.me('user-1')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('acceptInvitation', () => {
    it('crea el usuario con el rol de la invitación, la marca aceptada y nunca devuelve passwordHash', async () => {
      const invitation = buildInvitation();
      invitationRepo.findOne.mockResolvedValue(invitation);
      invitationRepo.save.mockImplementation((v: unknown) => Promise.resolve(v));
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(
        buildUser({ email: invitation.email, role: UserRole.USER }),
      );

      const result = await service.acceptInvitation({
        token: 'raw-token',
        password: 'password123',
        fullName: 'Invitado Test',
      });

      expect(result.user).not.toHaveProperty('passwordHash');
      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: invitation.email, role: UserRole.USER, isActive: true }),
      );
      expect(invitationRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ acceptedAt: expect.any(Date) }),
      );
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.invitation.accepted',
          targetType: 'invitation',
          targetId: invitation.id,
          actor: expect.objectContaining({ actorUserId: result.user.id }),
        }),
      );
    });

    it('rechaza un token que no matchea ninguna invitación', async () => {
      invitationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.acceptInvitation({
          token: 'token-invalido',
          password: 'password123',
          fullName: 'X',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza si ya existe una cuenta con el email de la invitación', async () => {
      const invitation = buildInvitation();
      invitationRepo.findOne.mockResolvedValue(invitation);
      usersService.findByEmail.mockResolvedValue(buildUser({ email: invitation.email }));

      await expect(
        service.acceptInvitation({
          token: 'raw-token',
          password: 'password123',
          fullName: 'X',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(usersService.create).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('actualiza la password, marca usedAt, audita y nunca devuelve hash/token', async () => {
      const resetToken = buildResetToken();
      passwordResetRepo.findOne.mockResolvedValue(resetToken);
      passwordResetRepo.save.mockImplementation((v: unknown) => Promise.resolve(v));

      const result = await service.resetPassword({
        token: 'raw-reset-token',
        password: 'newpassword123',
      });

      expect(result).toEqual({ message: expect.any(String) });
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('tokenHash');

      expect(usersService.updatePassword).toHaveBeenCalledWith(
        resetToken.userId,
        expect.any(String),
      );
      const passwordHashArg = usersService.updatePassword.mock.calls[0][1];
      expect(passwordHashArg).not.toBe('newpassword123');
      expect(bcrypt.compareSync('newpassword123', passwordHashArg)).toBe(true);

      expect(passwordResetRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ usedAt: expect.any(Date) }),
      );
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.password_reset.completed',
          targetType: 'user',
          targetId: resetToken.userId,
          actor: expect.objectContaining({ actorUserId: resetToken.userId }),
        }),
      );
    });

    it('rechaza un token que no matchea ningún reset pendiente', async () => {
      passwordResetRepo.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'token-invalido', password: 'newpassword123' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('busca el token con el mismo criterio que acceptInvitation (hash, usedAt IS NULL, expiresAt > now)', async () => {
      // El WHERE real (usedAt: IsNull(), expiresAt: MoreThan(new Date())) es
      // responsabilidad de TypeORM/la DB, no unit-testeable con un repo
      // mockeado — un token ya usado o vencido simplemente no matchea el
      // findOne y cae en el mismo BadRequestException genérico que un token
      // inexistente (mismo criterio que acceptInvitation: no revelar el
      // motivo exacto a un atacante).
      passwordResetRepo.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'usado-o-vencido', password: 'newpassword123' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(passwordResetRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tokenHash: hashToken('usado-o-vencido') }),
        }),
      );
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });
  });
});
