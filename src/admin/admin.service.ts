import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { AccessRequest } from '../access-request/entities/access-request.entity';
import { Analysis } from '../analysis/entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldLot } from '../fields/entities/field-lot.entity';
import { User } from '../users/user.entity';
import { UserRole } from '../users/user-role.enum';
import { PublicUser, UsersService } from '../users/users.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { ListAccessRequestsQueryDto } from './dto/list-access-requests-query.dto';
import { ListAnalysisQueryDto } from './dto/list-analysis-query.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

// Mismo costo que AuthService — ver src/auth/auth.service.ts. No se
// comparte la constante entre módulos para no acoplar AdminModule a
// AuthModule por un valor tan chico; si cambia, cambia en los dos lugares.
const SALT_ROUNDS = 10;

type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  limit: number;
};

// Analysis.fieldId es un campo de texto libre histórico, sin FK real hacia
// Field (ver comentarios en analysis.service.ts) — por eso el join acá es
// manual (leftJoinAndMapOne) en vez de una relation declarada en la entidad.
type AnalysisWithField = Analysis & {
  field?: (Pick<Field, 'id' | 'name' | 'userId'> & {
    user?: Pick<User, 'id' | 'email' | 'fullName'>;
  }) | null;
};

@Injectable()
export class AdminService {
  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(Field)
    private readonly fieldRepository: Repository<Field>,
    @InjectRepository(FieldLot)
    private readonly fieldLotRepository: Repository<FieldLot>,
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    @InjectRepository(AccessRequest)
    private readonly accessRequestRepository: Repository<AccessRequest>,
  ) {}

  async getMetrics() {
    const [
      totalUsers,
      activeUsers,
      totalFields,
      totalLots,
      totalAnalysis,
      completedAnalysis,
      failedAnalysis,
      averageAnalysisDurationMs,
      latestAnalysis,
      latestAccessRequests,
    ] = await Promise.all([
      this.usersService.count(),
      this.usersService.countActive(),
      this.fieldRepository.count(),
      this.fieldLotRepository.count(),
      this.analysisRepository.count(),
      this.analysisRepository.count({ where: { status: 'Finalizado' } }),
      this.analysisRepository.count({ where: { status: 'Error' } }),
      this.getAverageAnalysisDurationMs(),
      this.analysisRepository.find({
        order: { createdAt: 'DESC' },
        take: 5,
        select: {
          id: true,
          fieldId: true,
          lotName: true,
          status: true,
          durationMs: true,
          createdAt: true,
        },
      }),
      this.accessRequestRepository.find({
        order: { createdAt: 'DESC' },
        take: 5,
      }),
    ]);

    return {
      totalUsers,
      activeUsers,
      totalFields,
      totalLots,
      totalAnalysis,
      completedAnalysis,
      failedAnalysis,
      averageAnalysisDurationMs,
      latestAnalysis,
      latestAccessRequests,
    };
  }

  private async getAverageAnalysisDurationMs(): Promise<number | null> {
    const raw = await this.analysisRepository
      .createQueryBuilder('analysis')
      .select('AVG(analysis."durationMs")', 'avg')
      .where('analysis."durationMs" IS NOT NULL')
      .getRawOne<{ avg: string | null }>();

    return raw?.avg ? Math.round(Number(raw.avg)) : null;
  }

  async listUsers(query: PaginationQueryDto): Promise<Paginated<PublicUser>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const { items, total } = await this.usersService.findAllPaginated({
      page,
      limit,
      search: query.search,
    });

    return {
      items: items.map((user) => this.usersService.toPublicUser(user)),
      total,
      page,
      limit,
    };
  }

  async createUser(dto: CreateAdminUserDto): Promise<PublicUser> {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.usersService.findByEmail(email);
    if (existing) {
      throw new ConflictException('Ya existe una cuenta con ese email.');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const user = await this.usersService.create({
      email,
      passwordHash,
      fullName: dto.fullName.trim(),
      role: dto.role,
      isActive: dto.isActive ?? true,
    });

    return this.usersService.toPublicUser(user);
  }

  async updateUser(
    id: string,
    dto: UpdateAdminUserDto,
  ): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    const removesOwner =
      target.role === UserRole.OWNER &&
      target.isActive &&
      ((dto.role !== undefined && dto.role !== UserRole.OWNER) ||
        dto.isActive === false);

    if (removesOwner) {
      await this.assertNotLastActiveOwner(id);
    }

    if (dto.email) {
      const normalizedEmail = dto.email.trim().toLowerCase();
      const existing = await this.usersService.findByEmail(normalizedEmail);

      if (existing && existing.id !== id) {
        throw new ConflictException('Ya existe una cuenta con ese email.');
      }
    }

    const updated = await this.usersService.update(id, {
      ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
      ...(dto.email !== undefined && {
        email: dto.email.trim().toLowerCase(),
      }),
      ...(dto.role !== undefined && { role: dto.role }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    });

    return this.usersService.toPublicUser(updated);
  }

  async deactivateUser(id: string): Promise<PublicUser> {
    const target = await this.usersService.findById(id);

    if (!target) {
      throw new NotFoundException('Usuario no encontrado.');
    }

    if (target.role === UserRole.OWNER && target.isActive) {
      await this.assertNotLastActiveOwner(id);
    }

    const updated = await this.usersService.update(id, { isActive: false });

    return this.usersService.toPublicUser(updated);
  }

  /**
   * Bloquea la operación si `id` es el último owner activo del sistema (ver
   * consigna: nunca dejar el sistema sin ningún owner). Cuenta owners
   * activos *distintos* de `id`, así que da igual si quien pide el cambio
   * es el propio owner u otro admin actuando sobre él.
   */
  private async assertNotLastActiveOwner(id: string): Promise<void> {
    const otherActiveOwners = await this.usersService.countActiveByRole(
      UserRole.OWNER,
      id,
    );

    if (otherActiveOwners === 0) {
      throw new BadRequestException(
        'No se puede completar la operación: dejaría el sistema sin ningún owner activo.',
      );
    }
  }

  async listFields(query: PaginationQueryDto): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.fieldRepository
      .createQueryBuilder('field')
      .leftJoinAndSelect('field.user', 'user')
      .orderBy('field.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      qb.andWhere('field.name ILIKE :search', { search: `%${query.search}%` });
    }

    const [items, total] = await qb.getManyAndCount();
    const lotsCountByFieldId = await this.countLotsByFieldId(
      items.map((field) => field.id),
    );

    return {
      items: items.map((field) => ({
        id: field.id,
        name: field.name,
        ownerId: field.userId,
        ownerEmail: field.user?.email ?? null,
        ownerFullName: field.user?.fullName ?? null,
        lotsCount: lotsCountByFieldId.get(field.id) ?? 0,
        createdAt: field.createdAt,
        updatedAt: field.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Esta versión de TypeORM no expone `loadRelationCountAndMap` en
   * SelectQueryBuilder, así que el conteo de lotes por campo se resuelve en
   * un segundo query acotado a los ids de la página actual (nunca más de
   * `limit` fields), en vez de un join que multiplicaría filas y complicaría
   * la paginación.
   */
  private async countLotsByFieldId(
    fieldIds: string[],
  ): Promise<Map<string, number>> {
    if (!fieldIds.length) {
      return new Map();
    }

    const rows = await this.fieldLotRepository
      .createQueryBuilder('lot')
      .select('lot."fieldId"', 'fieldId')
      .addSelect('COUNT(*)', 'count')
      .where('lot."fieldId" IN (:...fieldIds)', { fieldIds })
      .groupBy('lot."fieldId"')
      .getRawMany<{ fieldId: string; count: string }>();

    return new Map(rows.map((row) => [row.fieldId, Number(row.count)]));
  }

  async listLots(query: PaginationQueryDto): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.fieldLotRepository
      .createQueryBuilder('lot')
      .leftJoinAndSelect('lot.field', 'field')
      .leftJoinAndSelect('field.user', 'user')
      .orderBy('lot.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search) {
      qb.andWhere('lot.name ILIKE :search', { search: `%${query.search}%` });
    }

    const [items, total] = await qb.getManyAndCount();

    return {
      items: items.map((lot) => ({
        id: lot.id,
        name: lot.name,
        fieldId: lot.fieldId,
        fieldName: lot.field?.name ?? null,
        ownerId: lot.field?.userId ?? null,
        ownerEmail: lot.field?.user?.email ?? null,
        ownerFullName: lot.field?.user?.fullName ?? null,
        createdAt: lot.createdAt,
        updatedAt: lot.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  async listAnalysis(
    query: ListAnalysisQueryDto,
  ): Promise<Paginated<unknown>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.analysisRepository
      .createQueryBuilder('analysis')
      .leftJoinAndMapOne(
        'analysis.field',
        Field,
        'field',
        'field.id::text = analysis."fieldId"',
      )
      .leftJoinAndMapOne('field.user', User, 'user', 'user.id = field."userId"')
      .orderBy('analysis.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('analysis.status = :status', { status: query.status });
    }

    const [items, total] = (await qb.getManyAndCount()) as [
      AnalysisWithField[],
      number,
    ];

    return {
      items: items.map((analysis) => ({
        id: analysis.id,
        fieldId: analysis.fieldId,
        fieldName: analysis.field?.name ?? analysis.lotName,
        ownerId: analysis.field?.userId ?? null,
        ownerEmail: analysis.field?.user?.email ?? null,
        ownerFullName: analysis.field?.user?.fullName ?? null,
        status: analysis.status,
        startedAt: analysis.startedAt,
        completedAt: analysis.completedAt,
        failedAt: analysis.failedAt,
        durationMs: analysis.durationMs,
        errorMessage: analysis.errorMessage,
        createdAt: analysis.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  async listAccessRequests(
    query: ListAccessRequestsQueryDto,
  ): Promise<Paginated<AccessRequest>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.accessRequestRepository
      .createQueryBuilder('accessRequest')
      .orderBy('accessRequest.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('accessRequest.status = :status', { status: query.status });
    }

    if (query.search) {
      qb.andWhere(
        '(accessRequest.name ILIKE :search OR accessRequest.email ILIKE :search OR accessRequest.organization ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    const [items, total] = await qb.getManyAndCount();

    return { items, total, page, limit };
  }
}
