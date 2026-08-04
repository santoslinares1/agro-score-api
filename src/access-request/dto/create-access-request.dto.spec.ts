import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AccessRequestProfile } from '../access-request-profile.enum';
import { CreateAccessRequestDto } from './create-access-request.dto';

describe('CreateAccessRequestDto', () => {
  const validPayload = {
    name: 'Santos Linares',
    email: 'santos9linares@gmail.com',
    organization: 'Campo La Esperanza',
    profile: AccessRequestProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message: 'Quiero probar AgroScore para diagnosticar lotes internos.',
  };

  const validateWith = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(CreateAccessRequestDto, {
      ...validPayload,
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload válido', async () => {
    const errors = await validateWith({});
    expect(errors).toHaveLength(0);
  });

  it('acepta un payload sin estimatedSurface ni message (opcionales)', async () => {
    const { estimatedSurface, message, ...rest } = validPayload;
    const instance = plainToInstance(CreateAccessRequestDto, rest);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza un email inválido', async () => {
    const errors = await validateWith({ email: 'no-es-un-email' });
    expect(errors.some((error) => error.property === 'email')).toBe(true);
  });

  it('rechaza un profile fuera del enum', async () => {
    const errors = await validateWith({ profile: 'ceo' });
    expect(errors.some((error) => error.property === 'profile')).toBe(true);
  });

  it('rechaza name vacío', async () => {
    const errors = await validateWith({ name: '' });
    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('rechaza organization vacío', async () => {
    const errors = await validateWith({ organization: '' });
    expect(errors.some((error) => error.property === 'organization')).toBe(
      true,
    );
  });

  it('rechaza message demasiado largo', async () => {
    const errors = await validateWith({ message: 'a'.repeat(2001) });
    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });

  it('rechaza estimatedSurface demasiado largo', async () => {
    const errors = await validateWith({ estimatedSurface: 'a'.repeat(81) });
    expect(
      errors.some((error) => error.property === 'estimatedSurface'),
    ).toBe(true);
  });
});
