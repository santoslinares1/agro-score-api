import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateAccessRequestDto } from './update-access-request.dto';

describe('UpdateAccessRequestDto', () => {
  it('acepta un payload vacío (todos los campos son opcionales)', async () => {
    const instance = plainToInstance(UpdateAccessRequestDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it.each(['new', 'contacted', 'interested', 'discarded', 'converted'])(
    'acepta status=%s',
    async (status) => {
      const instance = plainToInstance(UpdateAccessRequestDto, { status });
      const errors = await validate(instance);
      expect(errors).toHaveLength(0);
    },
  );

  it('rechaza un status fuera del enum', async () => {
    const instance = plainToInstance(UpdateAccessRequestDto, { status: 'won' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('rechaza assignedToUserId que no es UUID', async () => {
    const instance = plainToInstance(UpdateAccessRequestDto, {
      assignedToUserId: 'no-es-un-uuid',
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'assignedToUserId')).toBe(true);
  });

  it('rechaza internalNotes demasiado largo', async () => {
    const instance = plainToInstance(UpdateAccessRequestDto, {
      internalNotes: 'a'.repeat(4001),
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'internalNotes')).toBe(true);
  });
});
