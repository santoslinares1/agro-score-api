import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListScheduledAnalysisQueryDto } from './list-scheduled-analysis-query.dto';

describe('ListScheduledAnalysisQueryDto — fieldId/userId/enabled (Admin PR 2)', () => {
  it('acepta fieldId y userId como UUID', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      fieldId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza fieldId que no es UUID', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      fieldId: 'no-es-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'fieldId')).toBe(true);
  });

  it('rechaza userId que no es UUID', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      userId: 'no-es-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'userId')).toBe(true);
  });

  it('interpreta enabled=false como boolean false, no truthy', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      enabled: 'false',
    });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.enabled).toBe(false);
  });

  it('interpreta enabled=true como boolean true', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      enabled: 'true',
    });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.enabled).toBe(true);
  });

  it('rechaza un enabled que no sea un booleano válido', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      enabled: 'maybe',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'enabled')).toBe(true);
  });

  it('acepta fieldId/userId/enabled ausentes', async () => {
    const instance = plainToInstance(ListScheduledAnalysisQueryDto, {
      page: '1',
      limit: '20',
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });
});
