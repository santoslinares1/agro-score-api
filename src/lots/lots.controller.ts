import {
  Controller,
  Delete,
  Get,
  GoneException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

const LEGACY_LOTS_MESSAGE =
  'El flujo legacy de lotes individuales fue reemplazado por campos multi-lote. Usá /fields.';

/**
 * AUTH-5: el modelo `Lot` top-level no tiene relación con Field/User, así
 * que no hay forma de validar ownership acá. En vez de mantener dos
 * modelos de datos paralelos (uno con ownership real, otro sin él), se
 * deprecan los seis endpoints: exigen sesión (JwtAuthGuard) y devuelven
 * 410 Gone antes de leer o escribir nada — ni siquiera consultan si el id
 * existe, no hay riesgo de filtrar datos de terceros.
 */
@UseGuards(JwtAuthGuard)
@Controller('lots')
export class LotsController {
  @Post()
  create(): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }

  @Get()
  findAll(): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }

  @Get(':id/pipeline-input')
  getPipelineInput(@Param('id', ParseUUIDPipe) _id: string): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) _id: string): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) _id: string): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) _id: string): never {
    throw new GoneException(LEGACY_LOTS_MESSAGE);
  }
}
