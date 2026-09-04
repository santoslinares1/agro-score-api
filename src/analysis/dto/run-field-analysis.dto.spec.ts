import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_ANALYSIS_CLOUDINESS } from '../analysis-constraints';
import { RunFieldAnalysisDto } from './run-field-analysis.dto';

describe('RunFieldAnalysisDto', () => {
  const validPayload = {
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    maxCloudiness: 30,
  };

  const validateWith = async (overrides: Partial<Record<string, unknown>>) => {
    const instance = plainToInstance(RunFieldAnalysisDto, {
      ...validPayload,
      ...overrides,
    });
    return validate(instance);
  };

  it('acepta un payload válido', async () => {
    const errors = await validateWith({});
    expect(errors).toHaveLength(0);
  });

  // OPS-2 (RISK-004): el tope efectivo es MAX_ANALYSIS_CLOUDINESS (lo que el Worker acepta hoy
  // por default), no 100 — un valor por encima creaba un Analysis=Procesando que el Worker
  // siempre terminaba rechazando.
  it(`acepta maxCloudiness = MAX_ANALYSIS_CLOUDINESS (${MAX_ANALYSIS_CLOUDINESS})`, async () => {
    const errors = await validateWith({ maxCloudiness: MAX_ANALYSIS_CLOUDINESS });
    expect(errors).toHaveLength(0);
  });

  it(`rechaza maxCloudiness = MAX_ANALYSIS_CLOUDINESS + 1 (${MAX_ANALYSIS_CLOUDINESS + 1})`, async () => {
    const errors = await validateWith({ maxCloudiness: MAX_ANALYSIS_CLOUDINESS + 1 });
    expect(errors.some((error) => error.property === 'maxCloudiness')).toBe(true);
  });

  it('rechaza maxCloudiness negativo', async () => {
    const errors = await validateWith({ maxCloudiness: -1 });
    expect(errors.some((error) => error.property === 'maxCloudiness')).toBe(true);
  });
});
