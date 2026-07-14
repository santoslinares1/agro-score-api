import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CreateFieldDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { UpdateFieldLotDto } from './dto/update-field-lot.dto';
import { FieldsService } from './fields.service';

@Controller('fields')
export class FieldsController {
  constructor(private readonly fieldsService: FieldsService) {}

  @Post()
  create(@Body() dto: CreateFieldDto) {
    return this.fieldsService.create(dto);
  }

  @Get()
  findAll() {
    return this.fieldsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.fieldsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFieldDto) {
    return this.fieldsService.update(id, dto);
  }

  @Patch(':fieldId/lots/:lotId')
  updateLot(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateFieldLotDto,
  ) {
    return this.fieldsService.updateLot(fieldId, lotId, dto);
  }
}
