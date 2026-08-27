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
  // Admin PR 2: trazabilidad — "saltar al usuario" desde otras pantallas admin sin depender del
  // buscador de texto (ver AdminService.listUsers / ListUsersQueryDto).
  userId?: string;
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
    const { page, limit, search, userId } = params;

    const query = this.usersRepository
      .createQueryBuilder('user')
      .orderBy('user.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    // andWhere en vez de where para las dos: TypeORM trata el primer andWhere() como el WHERE
    // inicial cuando todavía no se llamó a where(), así que da igual el orden en el que estas dos
    // condiciones (opcionales, independientes) terminen apareciendo.
    if (userId) {
      query.andWhere('user.id = :userId', { userId });
    }

    if (search) {
      query.andWhere(
        '(user.email ILIKE :search OR user.fullName ILIKE :search)',
        {
          search: `%${search}%`,
        },
      );
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

  /**
   * ADMIN-3: dedicado y separado de `update()`/`UpdateUserFields` a
   * propósito — ese tipo nunca debe aceptar `passwordHash` (así el
   * ValidationPipe global de un DTO admin no puede colarlo por error). Solo
   * lo llama AuthService.resetPassword, después de validar el token de
   * reset contra la DB.
   */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.usersRepository.update(id, { passwordHash });
  }

  async count(): Promise<number> {
    return this.usersRepository.count();
  }

  async countActive(): Promise<number> {
    return this.usersRepository.count({ where: { isActive: true } });
  }

  async countCreatedSince(since: Date): Promise<number> {
    // OJO: 'user' es palabra reservada en Postgres (equivalente a
    // CURRENT_USER) — un alias `user` sin comillas seguido de una columna
    // ya entrecomillada (`user."createdAt"`) rompe el parser ("syntax error
    // at or near \".\""). El resto de los query builders del admin usan
    // alias como 'field'/'analysis'/'entity' que no chocan con esto; acá
    // hay que citar el alias a mano.
    return this.usersRepository
      .createQueryBuilder('user')
      .where('"user"."createdAt" >= :since', { since })
      .getCount();
  }

  toPublicUser(user: User): PublicUser {
    const { passwordHash: _passwordHash, ...publicUser } = user;

    return publicUser;
  }
}
