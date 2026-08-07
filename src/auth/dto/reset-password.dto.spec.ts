import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ResetPasswordDto } from './reset-password.dto';

describe('ResetPasswordDto', () => {
  const validPayload = {
    token: 'a'.repeat(64),
    password: 'newpassword123',
  };

  it('acepta un payload válido', async () => {
    const instance = plainToInstance(ResetPasswordDto, validPayload);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza password corta', async () => {
    const instance = plainToInstance(ResetPasswordDto, { ...validPayload, password: '123' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });

  it('rechaza token ausente', async () => {
    const { token: _token, ...rest } = validPayload;
    const instance = plainToInstance(ResetPasswordDto, rest);
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'token')).toBe(true);
  });
});
