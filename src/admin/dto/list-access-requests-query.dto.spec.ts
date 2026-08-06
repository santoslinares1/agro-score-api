// Ver comentario en list-analysis-query.dto.spec.ts: PaginationQueryDto usa
// @Type(() => Number), que necesita reflect-metadata importado explícito en
// specs que no pasan por @nestjs/testing.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListAccessRequestsQueryDto } from './list-access-requests-query.dto';

describe('ListAccessRequestsQueryDto — status ampliado (ADMIN-2)', () => {
  it.each(['new', 'contacted', 'interested', 'discarded', 'converted'])(
    'acepta status=%s',
    async (status) => {
      const instance = plainToInstance(ListAccessRequestsQueryDto, { status });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it('rechaza un status fuera del union conocido', async () => {
    const instance = plainToInstance(ListAccessRequestsQueryDto, { status: 'won' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('acepta search + page + limit combinados con status', async () => {
    const instance = plainToInstance(ListAccessRequestsQueryDto, {
      status: 'interested',
      search: 'campo la esperanza',
      page: '2',
      limit: '10',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
