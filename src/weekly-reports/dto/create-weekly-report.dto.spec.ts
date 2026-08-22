// PaginationQueryDto-style DTOs de este repo usan @Type(() => Number) (class-transformer), que
// necesita reflect-metadata explícito en specs que no pasan por @nestjs/testing — este DTO no
// usa @Type, pero se mantiene el import por consistencia con el resto de los *.dto.spec.ts.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateWeeklyReportDto } from './create-weekly-report.dto';

describe('CreateWeeklyReportDto', () => {
  const validate2 = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(CreateWeeklyReportDto, {
      campaignStart: '2025-10-01',
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload mínimo válido (solo campaignStart)', async () => {
    const errors = await validate2({});
    expect(errors).toHaveLength(0);
  });

  it('acepta indices=NDVI,NDMI sin includeNdreExperimental', async () => {
    const errors = await validate2({ indices: ['NDVI', 'NDMI'] });
    expect(errors).toHaveLength(0);
  });

  it('acepta indices con NDRE a nivel DTO (la regla cruzada con includeNdreExperimental vive en el service)', async () => {
    const errors = await validate2({ indices: ['NDVI', 'NDRE'], includeNdreExperimental: true });
    expect(errors).toHaveLength(0);
  });

  it('rechaza un índice desconocido', async () => {
    const errors = await validate2({ indices: ['NDVI', 'NOT_AN_INDEX'] });
    expect(errors.some((error) => error.property === 'indices')).toBe(true);
  });

  it('rechaza indices vacío', async () => {
    const errors = await validate2({ indices: [] });
    expect(errors.some((error) => error.property === 'indices')).toBe(true);
  });

  it('rechaza campaignStart ausente', async () => {
    const instance = plainToInstance(CreateWeeklyReportDto, {});
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'campaignStart')).toBe(true);
  });

  it('rechaza campaignStart con formato inválido', async () => {
    const errors = await validate2({ campaignStart: 'no-es-fecha' });
    expect(errors.some((error) => error.property === 'campaignStart')).toBe(true);
  });

  it('rechaza includeNdreExperimental no booleano', async () => {
    const errors = await validate2({ includeNdreExperimental: 'yes' });
    expect(errors.some((error) => error.property === 'includeNdreExperimental')).toBe(true);
  });
});
