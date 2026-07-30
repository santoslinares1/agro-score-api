import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';

import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let jwtService: jest.Mocked<JwtService>;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
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
      ],
    }).compile();

    service = module.get(AuthService);
    usersService = module.get(UsersService);
    jwtService = module.get(JwtService);
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
});
