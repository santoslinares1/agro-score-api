import { BadRequestException, ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { UsersService } from '../users/users.service';
import { AdminService } from './admin.service';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@agroscorelatam.com',
    passwordHash: 'hashed',
    fullName: 'Usuario de prueba',
    companyName: undefined,
    role: UserRole.USER,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Repos que AdminService no ejercita en estos tests (fields/lots/analysis/
// access-requests) — solo necesitan existir como providers para que Nest
// arme el módulo; no se usa ningún método de ellos acá.
const noopRepo = {
  count: jest.fn(),
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
};

describe('AdminService', () => {
  let service: AdminService;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            findById: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            countActiveByRole: jest.fn(),
            toPublicUser: jest.fn((user: User) => {
              const { passwordHash: _passwordHash, ...publicUser } = user;
              return publicUser;
            }),
            findAllPaginated: jest.fn(),
            count: jest.fn(),
            countActive: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Field), useValue: { ...noopRepo } },
        { provide: getRepositoryToken(FieldLot), useValue: { ...noopRepo } },
        { provide: getRepositoryToken(Analysis), useValue: { ...noopRepo } },
        {
          provide: getRepositoryToken(AccessRequest),
          useValue: { ...noopRepo },
        },
      ],
    }).compile();

    service = module.get(AdminService);
    usersService = module.get(UsersService);
  });

  describe('createUser', () => {
    it('hashea la password y nunca devuelve passwordHash', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN }),
      );

      const result = await service.createUser({
        fullName: 'Nuevo Admin',
        email: 'nuevo@agroscorelatam.com',
        password: 'temporal123',
        role: UserRole.ADMIN,
      });

      expect(result).not.toHaveProperty('passwordHash');
      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'nuevo@agroscorelatam.com',
          role: UserRole.ADMIN,
          isActive: true,
        }),
      );
      // La password nunca viaja en texto plano al repositorio.
      const createArgs = usersService.create.mock.calls[0][0];
      expect(createArgs.passwordHash).not.toBe('temporal123');
    });

    it('rechaza un email duplicado', async () => {
      usersService.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.createUser({
          fullName: 'Dup',
          email: 'user@agroscorelatam.com',
          password: 'temporal123',
          role: UserRole.USER,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listUsers', () => {
    it('nunca devuelve passwordHash en los items', async () => {
      usersService.findAllPaginated.mockResolvedValue({
        items: [buildUser(), buildUser({ id: 'user-2' })],
        total: 2,
      });

      const result = await service.listUsers({ page: 1, limit: 20 });

      expect(result.items).toHaveLength(2);
      result.items.forEach((item) => {
        expect(item).not.toHaveProperty('passwordHash');
      });
    });
  });

  describe('protección de último owner', () => {
    it('bloquea degradar de rol al último owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(0);

      await expect(
        service.updateUser('user-1', { role: UserRole.ADMIN }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('permite degradar a un owner si hay otro owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(1);
      usersService.update.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN }),
      );

      await service.updateUser('user-1', { role: UserRole.ADMIN });

      expect(usersService.update).toHaveBeenCalled();
    });

    it('bloquea desactivar al último owner activo', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.OWNER, isActive: true }),
      );
      usersService.countActiveByRole.mockResolvedValue(0);

      await expect(service.deactivateUser('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(usersService.update).not.toHaveBeenCalled();
    });

    it('permite desactivar a un usuario que no es owner', async () => {
      usersService.findById.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN, isActive: true }),
      );
      usersService.update.mockResolvedValue(
        buildUser({ role: UserRole.ADMIN, isActive: false }),
      );

      await service.deactivateUser('user-1');

      expect(usersService.countActiveByRole).not.toHaveBeenCalled();
      expect(usersService.update).toHaveBeenCalledWith('user-1', {
        isActive: false,
      });
    });
  });
});
