import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_ANALYSIS_CLOUDINESS } from '../../analysis/analysis-constraints';
import { UpdateFieldDto } from './update-field.dto';

/**
 * OPS-2: UpdateFieldDto es PartialType(OmitType(CreateFieldDto, ['lots', 'boundaryGeojson'])) —
 * este spec confirma que esa composición realmente hereda el @Max(MAX_ANALYSIS_CLOUDINESS) de
 * CreateFieldDto.maxCloudiness (nunca asumir que PartialType/OmitType preservan validadores sin
 * verificarlo).
 */
describe('UpdateFieldDto', () => {
  it('acepta un payload vacío (todos los campos son opcionales)', async () => {
    const instance = plainToInstance(UpdateFieldDto, {});
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it(`acepta maxCloudiness = MAX_ANALYSIS_CLOUDINESS (${MAX_ANALYSIS_CLOUDINESS})`, async () => {
    const instance = plainToInstance(UpdateFieldDto, {
      maxCloudiness: MAX_ANALYSIS_CLOUDINESS,
    });
    const errors = await validate(instance);
    expect(errors).toHaveLength(0);
  });

  it(`rechaza maxCloudiness = MAX_ANALYSIS_CLOUDINESS + 1 (${MAX_ANALYSIS_CLOUDINESS + 1})`, async () => {
    const instance = plainToInstance(UpdateFieldDto, {
      maxCloudiness: MAX_ANALYSIS_CLOUDINESS + 1,
    });
    const errors = await validate(instance);
    expect(errors.some((error) => error.property === 'maxCloudiness')).toBe(true);
  });
});
