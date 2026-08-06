// ListAnalysisQueryDto hereda de PaginationQueryDto, que usa
// @Type(() => Number) (class-transformer) — ese decorador llama a
// Reflect.getMetadata en tiempo de definición de la clase. En la app real
// esto ya está polyfillado (main.ts importa reflect-metadata, y cualquier
// spec que pase por @nestjs/testing lo hereda transitivamente), pero este
// spec valida el DTO "puro" sin pasar por Nest, así que necesita el import
// explícito.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ListAnalysisQueryDto } from './list-analysis-query.dto';

describe('ListAnalysisQueryDto — filtros ADMIN-2', () => {
  it('acepta todos los filtros nuevos combinados', async () => {
    const instance = plainToInstance(ListAnalysisQueryDto, {
      status: 'Error',
      fieldId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      from: '2026-01-01',
      to: '2026-02-01',
      onlyFailed: 'true',
      onlyUnreviewed: 'false',
    });

    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it('interpreta onlyFailed=false como boolean false, no truthy', async () => {
    const instance = plainToInstance(ListAnalysisQueryDto, { onlyFailed: 'false' });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.onlyFailed).toBe(false);
  });

  it('rechaza fieldId que no es UUID', async () => {
    const instance = plainToInstance(ListAnalysisQueryDto, { fieldId: 'no-es-uuid' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'fieldId')).toBe(true);
  });

  it('rechaza from que no es una fecha válida', async () => {
    const instance = plainToInstance(ListAnalysisQueryDto, { from: 'no-es-fecha' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'from')).toBe(true);
  });

  it('rechaza status fuera del union conocido', async () => {
    const instance = plainToInstance(ListAnalysisQueryDto, { status: 'Pendiente' });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });
});
