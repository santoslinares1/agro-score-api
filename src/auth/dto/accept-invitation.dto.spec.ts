import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AcceptInvitationDto } from './accept-invitation.dto';

describe('AcceptInvitationDto', () => {
  const validPayload = {
    token: 'a'.repeat(64),
    password: 'password123',
    fullName: 'Invitado Test',
  };

  it('acepta un payload válido', async () => {
    const instance = plainToInstance(AcceptInvitationDto, validPayload);
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('rechaza password corta', async () => {
    const instance = plainToInstance(AcceptInvitationDto, { ...validPayload, password: '123' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'password')).toBe(true);
  });

  it('rechaza fullName vacío', async () => {
    const instance = plainToInstance(AcceptInvitationDto, { ...validPayload, fullName: '' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'fullName')).toBe(true);
  });

  it('rechaza token ausente', async () => {
    const { token: _token, ...rest } = validPayload;
    const instance = plainToInstance(AcceptInvitationDto, rest);
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'token')).toBe(true);
  });
});
