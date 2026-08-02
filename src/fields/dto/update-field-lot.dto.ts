import { PartialType } from '@nestjs/mapped-types';
import { CreateFieldLotDto } from './create-field.dto';

/**
 * Incluye `geojson` (GEOMETRY-1): permite tanto editar metadata como
 * reemplazar la geometría completa de un lote existente desde el mismo
 * endpoint. La forma del polígono se valida en FieldsService, no acá, porque
 * `@Allow()` no impone ninguna estructura.
 */
export class UpdateFieldLotDto extends PartialType(CreateFieldLotDto) {}
