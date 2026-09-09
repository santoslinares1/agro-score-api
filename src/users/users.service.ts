import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Not, Repository, UpdateResult } from 'typeorm';

import { User } from './user.entity';
import { UserRole } from './user-role.enum';

// PROFILE-SEC-1: tokenVersion se excluye del shape público igual que
// passwordHash — es un detalle interno de invalidación de JWT, no algo que
// el frontend necesite leer.
export type PublicUser = Omit<User, 'passwordHash' | 'tokenVersion'>;

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
   * Admin PR 7: resolución batched de actores de auditoría para el detalle de usuario (una sola
   * consulta IN, nunca un findById por fila) — ver AdminService.getAuditLogsForUser. `ids` vacío
   * evita un `IN ()` inválido (mismo criterio que getTechnicalVerdictsByAnalysisId en AdminService).
   */
  async findByIds(ids: string[]): Promise<User[]> {
    if (!ids.length) {
      return [];
    }

    return this.usersRepository.find({ where: { id: In(ids) } });
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
   * ValidationPipe global de un DTO admin no puede colarlo por error).
   *
   * PROFILE-SEC-1: además incrementa `tokenVersion` atómicamente en la misma
   * UPDATE — cualquier cambio real de password (reset por token o cambio
   * autenticado desde /app/profile) debe invalidar los JWT emitidos con la
   * password anterior. Lo llaman AuthService.resetPassword y
   * AuthService.changePassword.
   *
   * F03: `manager` opcional — cuando se pasa (AuthService.resetPassword, dentro de su propia
   * transacción con el PasswordResetToken), este UPDATE corre en ESA transacción en vez de en su
   * propia conexión implícita, para que el cambio de password y el consumo del token confirmen o
   * reviertan juntos. Sin `manager` (changePassword, y cualquier otro caller futuro), el
   * comportamiento es IDÉNTICO al de antes: una sola UPDATE atómica en su propia transacción
   * implícita de una sentencia — no hay ningún cambio observable para esos callers.
   */
  async updatePassword(
    id: string,
    passwordHash: string,
    manager?: EntityManager,
  ): Promise<UpdateResult> {
    const repository = manager
      ? manager.getRepository(User)
      : this.usersRepository;

    return repository.update(id, {
      passwordHash,
      tokenVersion: () => '"tokenVersion" + 1',
    });
  }

  /**
   * PROFILE-SEC-1: "cerrar otras sesiones" desde /app/profile — invalida
   * todo JWT emitido antes de este momento sin tocar la password. El caller
   * (AuthService.revokeOtherSessions) reemite un token fresco para que la
   * sesión actual (la que pidió la acción) siga funcionando.
   */
  async incrementTokenVersion(id: string): Promise<void> {
    await this.usersRepository.update(id, {
      tokenVersion: () => '"tokenVersion" + 1',
    });
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
    const { passwordHash: _passwordHash, tokenVersion: _tokenVersion, ...publicUser } = user;

    return publicUser;
  }
}
