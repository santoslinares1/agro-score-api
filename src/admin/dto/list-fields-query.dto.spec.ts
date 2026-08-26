// Ver comentario en list-analysis-query.dto.spec.ts: PaginationQueryDto usa
// @Type(() => Number), que necesita reflect-metadata importado explícito en
// specs que no pasan por @nestjs/testing.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListFieldsQueryDto } from './list-fields-query.dto';

describe('ListFieldsQueryDto — hasAnalysis (Admin PR 1)', () => {
  it('interpreta hasAnalysis=false como boolean false, no truthy', async () => {
    const instance = plainToInstance(ListFieldsQueryDto, {
      hasAnalysis: 'false',
    });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.hasAnalysis).toBe(false);
  });

  it('interpreta hasAnalysis=true como boolean true', async () => {
    const instance = plainToInstance(ListFieldsQueryDto, {
      hasAnalysis: 'true',
    });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.hasAnalysis).toBe(true);
  });

  it('acepta que hasAnalysis venga ausente', async () => {
    const instance = plainToInstance(ListFieldsQueryDto, { search: 'campo' });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.hasAnalysis).toBeUndefined();
  });

  it('rechaza un hasAnalysis que no sea un booleano válido', async () => {
    const instance = plainToInstance(ListFieldsQueryDto, {
      hasAnalysis: 'maybe',
    });
    const errors = await validate(instance);

    expect(errors.some((error) => error.property === 'hasAnalysis')).toBe(true);
  });

  it('acepta hasAnalysis combinado con search/page/limit', async () => {
    const instance = plainToInstance(ListFieldsQueryDto, {
      hasAnalysis: 'false',
      search: 'campo',
      page: '2',
      limit: '10',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
