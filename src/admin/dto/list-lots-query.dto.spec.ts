import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListLotsQueryDto } from './list-lots-query.dto';

describe('ListLotsQueryDto — fieldId/userId (Admin PR 2)', () => {
  it('acepta fieldId y userId como UUID', async () => {
    const instance = plainToInstance(ListLotsQueryDto, {
      fieldId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza fieldId que no es UUID', async () => {
    const instance = plainToInstance(ListLotsQueryDto, {
      fieldId: 'no-es-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'fieldId')).toBe(true);
  });

  it('rechaza userId que no es UUID', async () => {
    const instance = plainToInstance(ListLotsQueryDto, {
      userId: 'no-es-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'userId')).toBe(true);
  });

  it('acepta fieldId/userId ausentes, combinados con search/page/limit', async () => {
    const instance = plainToInstance(ListLotsQueryDto, {
      search: 'lote',
      page: '2',
      limit: '10',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
