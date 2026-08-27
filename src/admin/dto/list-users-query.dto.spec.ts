import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListUsersQueryDto } from './list-users-query.dto';

describe('ListUsersQueryDto — userId (Admin PR 2)', () => {
  it('acepta userId como UUID', async () => {
    const instance = plainToInstance(ListUsersQueryDto, {
      userId: '11111111-1111-4111-8111-111111111111',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza userId que no es UUID', async () => {
    const instance = plainToInstance(ListUsersQueryDto, {
      userId: 'no-es-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'userId')).toBe(true);
  });

  it('acepta userId ausente, combinado con search/page/limit', async () => {
    const instance = plainToInstance(ListUsersQueryDto, {
      search: 'ana@example.com',
      page: '1',
      limit: '20',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
