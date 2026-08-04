import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';

import { User } from './user.entity';
import { UserRole } from './user-role.enum';

export type PublicUser = Omit<User, 'passwordHash'>;

export type ListUsersParams = {
  page: number;
  limit: number;
  search?: string;
};

export type UpdateUserFields = Partial<
  Pick<User, 'fullName' | 'email' | 'role' | 'isActive'>
>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * ADMIN-1: `role`/`isActive` son opcionales a propósito — el flujo público
   * de /auth/register no los manda nunca, así que se aplican los defaults de
   * la entidad (role='user', isActive=true). Solo AdminService los pasa
   * explícitos al crear un usuario desde el panel.
   */
  async create(data: {
    email: string;
    passwordHash: string;
    fullName: string;
    companyName?: string;
    role?: UserRole;
    isActive?: boolean;
  }): Promise<User> {
    const user = this.usersRepository.create({
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      companyName: data.companyName,
      role: data.role,
      isActive: data.isActive,
    });

    return this.usersRepository.save(user);
  }

  async findAllPaginated(
    params: ListUsersParams,
  ): Promise<{ items: User[]; total: number }> {
    const { page, limit, search } = params;

    const query = this.usersRepository
      .createQueryBuilder('user')
      .orderBy('user.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      query.where('user.email ILIKE :search OR user.fullName ILIKE :search', {
        search: `%${search}%`,
      });
    }

    const [items, total] = await query.getManyAndCount();

    return { items, total };
  }

  /**
   * ADMIN-1: valida unicidad de email (excluyendo al propio usuario) antes
   * de aplicar el update — mismo criterio de conflicto que AuthService.register.
   */
  async update(id: string, changes: UpdateUserFields): Promise<User> {
    if (changes.email) {
      const existing = await this.usersRepository.findOne({
        where: { email: changes.email, id: Not(id) },
      });

      if (existing) {
        throw new ConflictException('Ya existe una cuenta con ese email.');
      }
    }

    await this.usersRepository.update(id, changes);

    const updated = await this.findById(id);

    if (!updated) {
      throw new ConflictException('El usuario no existe.');
    }

    return updated;
  }

  /**
   * ADMIN-1: cuenta cuántos usuarios activos tienen el rol dado, excluyendo
   * opcionalmente un id — usado para la protección de "último owner" antes
   * de degradar o desactivar a alguien.
   */
  async countActiveByRole(role: UserRole, excludeId?: string): Promise<number> {
    return this.usersRepository.count({
      where: excludeId
        ? { role, isActive: true, id: Not(excludeId) }
        : { role, isActive: true },
    });
  }

  async count(): Promise<number> {
    return this.usersRepository.count();
  }

  async countActive(): Promise<number> {
    return this.usersRepository.count({ where: { isActive: true } });
  }

  toPublicUser(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...publicUser } = user;

    return publicUser;
  }
}
