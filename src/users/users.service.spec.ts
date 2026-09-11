import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { In, Not } from 'typeorm';

import { User } from './user.entity';
import { UserRole } from './user-role.enum';
import { UsersService } from './users.service';

// F03: única cobertura unitaria agregada para UsersService en esta ficha — deliberadamente
// acotada al parámetro `manager` nuevo de updatePassword(), no un test suite general del
// servicio (fuera de alcance de esta corrección, ver entrega).
describe('UsersService.updatePassword — participación opcional en una transacción externa (F03)', () => {
  let service: UsersService;
  let usersRepository: { update: jest.Mock };

  beforeEach(async () => {
    usersRepository = { update: jest.fn().mockResolvedValue({ affected: 1 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('sin manager: usa el repositorio propio inyectado — comportamiento idéntico al de antes de F03 (regresión de changePassword)', async () => {
    const result = await service.updatePassword('user-1', 'hash-nuevo');

    expect(usersRepository.update).toHaveBeenCalledWith('user-1', {
      passwordHash: 'hash-nuevo',
      tokenVersion: expect.any(Function),
    });
    expect(result).toEqual({ affected: 1 });

    // La misma UPDATE atómica de siempre: password + tokenVersion en una sola sentencia.
    const [, changes] = usersRepository.update.mock.calls[0] as [
      string,
      { tokenVersion: () => string },
    ];
    expect(changes.tokenVersion()).toBe('"tokenVersion" + 1');
  });

  it('con manager: usa manager.getRepository(User) en vez del repositorio propio — la escritura queda dentro de la transacción del caller', async () => {
    const managerUserRepo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const fakeManager = {
      getRepository: jest.fn().mockReturnValue(managerUserRepo),
    };

    const result = await service.updatePassword(
      'user-1',
      'hash-nuevo',
      fakeManager as never,
    );

    expect(fakeManager.getRepository).toHaveBeenCalledWith(User);
    expect(managerUserRepo.update).toHaveBeenCalledWith('user-1', {
      passwordHash: 'hash-nuevo',
      tokenVersion: expect.any(Function),
    });
    expect(result).toEqual({ affected: 1 });

    // El repositorio "propio" (no transaccional) nunca se toca cuando se pasa un manager — si
    // esto fallara, la escritura estaría viviendo fuera de la transacción del caller sin que
    // nadie lo note.
    expect(usersRepository.update).not.toHaveBeenCalled();
  });

  it('propaga affected: 0 tal cual (ningún usuario matcheó el id) — el caller decide qué hacer', async () => {
    usersRepository.update.mockResolvedValue({ affected: 0 });

    const result = await service.updatePassword('id-inexistente', 'hash-nuevo');

    expect(result).toEqual({ affected: 0 });
  });
});

// KPIs P0 (auditoría de KPIs + Decision 1/2): listEligibleProducers() es la única fuente de la
// cohorte de activation/time-to-value — cobertura acotada a ese método, mismo criterio de alcance
// que el describe de F03 de arriba.
describe('UsersService.listEligibleProducers (KPIs P0)', () => {
  let service: UsersService;
  let usersRepository: { find: jest.Mock };

  beforeEach(async () => {
    usersRepository = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('excluye roles administrativos (owner/admin) vía NOT IN, nunca lista todos los usuarios', async () => {
    await service.listEligibleProducers();

    expect(usersRepository.find).toHaveBeenCalledWith({
      where: { role: Not(In([UserRole.OWNER, UserRole.ADMIN])) },
      select: { id: true, createdAt: true },
    });
  });

  it('no filtra por isActive — una cuenta desactivada conserva su historia de activación', async () => {
    await service.listEligibleProducers();

    const [args] = usersRepository.find.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).not.toHaveProperty('isActive');
  });

  it('devuelve exactamente lo que el repositorio resuelve (id/createdAt), sin transformar', async () => {
    const rows = [{ id: 'u1', createdAt: new Date('2026-01-01') }];
    usersRepository.find.mockResolvedValue(rows);

    const result = await service.listEligibleProducers();

    expect(result).toBe(rows);
  });
});
