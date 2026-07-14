import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateFieldLotDto } from './create-field.dto';

/**
 * Excluye `geojson` a propósito: en esta fase no se permite redibujar/editar
 * la geometría de un lote desde este endpoint, solo su metadata.
 */
export class UpdateFieldLotDto extends PartialType(
  OmitType(CreateFieldLotDto, ['geojson'] as const),
) {}
