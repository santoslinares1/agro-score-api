// CreateFieldDto.lots usa @Type(() => CreateFieldLotDto) (validación anidada) — class-transformer
// necesita este polyfill para leer el design:type de esa propiedad vía Reflect.getMetadata. Los
// specs de otras DTOs sin @Type() (ver run-field-analysis.dto.spec.ts) no lo necesitan porque
// nunca disparan esa ruta.
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_ANALYSIS_CLOUDINESS } from '../../analysis/analysis-constraints';
import { CreateFieldDto } from './create-field.dto';

describe('CreateFieldDto', () => {
  const validPayload = {
    name: 'Campo A',
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    maxCloudiness: 30,
    lots: [{ name: 'Lote 1' }],
  };

  const validateWith = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(CreateFieldDto, {
      ...validPayload,
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload válido', async () => {
    const errors = await validateWith({});
    expect(errors).toHaveLength(0);
  });

  // OPS-2 (RISK-004): Field.maxCloudiness viaja tal cual a scheduled-analysis
  // (ScheduledAnalysisRunnerService.triggerRun usa field.maxCloudiness directo, sin volver a
  // validar), así que este DTO necesita el mismo tope que RunFieldAnalysisDto para no dejar
  // persistir un Field que rompa cada corrida semanal automática.
  it(`acepta maxCloudiness = MAX_ANALYSIS_CLOUDINESS (${MAX_ANALYSIS_CLOUDINESS})`, async () => {
    const errors = await validateWith({ maxCloudiness: MAX_ANALYSIS_CLOUDINESS });
    expect(errors).toHaveLength(0);
  });

  it(`rechaza maxCloudiness = MAX_ANALYSIS_CLOUDINESS + 1 (${MAX_ANALYSIS_CLOUDINESS + 1})`, async () => {
    const errors = await validateWith({ maxCloudiness: MAX_ANALYSIS_CLOUDINESS + 1 });
    expect(errors.some((error) => error.property === 'maxCloudiness')).toBe(true);
  });
});
