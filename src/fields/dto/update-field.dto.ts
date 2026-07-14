import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateFieldDto } from './create-field.dto';

/**
 * Excluye `lots` y `boundaryGeojson` a propósito: este endpoint solo edita
 * metadata general del campo, nunca la geometría/lista de lotes.
 */
export class UpdateFieldDto extends PartialType(
  OmitType(CreateFieldDto, ['lots', 'boundaryGeojson'] as const),
) {}
