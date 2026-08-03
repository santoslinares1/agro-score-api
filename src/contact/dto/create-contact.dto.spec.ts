import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ContactProfile } from '../contact-profile.enum';
import { CreateContactDto } from './create-contact.dto';

describe('CreateContactDto', () => {
  const validPayload = {
    name: 'Santos Linares',
    email: 'santos9linares@gmail.com',
    companyOrField: 'Campo La Esperanza',
    profile: ContactProfile.PRODUCER,
    estimatedSurface: '120 ha',
    message:
      'Quiero evaluar AgroScore para analizar lotes internos y generar reportes técnicos.',
  };

  const validateWith = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(CreateContactDto, {
      ...validPayload,
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload válido', async () => {
    const errors = await validateWith({});
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

  it('rechaza un mensaje demasiado corto', async () => {
    const errors = await validateWith({ message: 'corto' });
    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });

  it('rechaza name vacío', async () => {
    const errors = await validateWith({ name: '' });
    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('rechaza companyOrField vacío', async () => {
    const errors = await validateWith({ companyOrField: '' });
    expect(errors.some((error) => error.property === 'companyOrField')).toBe(
      true,
    );
  });

  it('rechaza estimatedSurface vacío', async () => {
    const errors = await validateWith({ estimatedSurface: '' });
    expect(errors.some((error) => error.property === 'estimatedSurface')).toBe(
      true,
    );
  });
});
