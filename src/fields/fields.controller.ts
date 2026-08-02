import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateFieldDto, CreateFieldLotDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { UpdateFieldLotDto } from './dto/update-field-lot.dto';
import { FieldsService } from './fields.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@UseGuards(JwtAuthGuard)
@Controller('fields')
export class FieldsController {
  constructor(private readonly fieldsService: FieldsService) {}

  @Post()
  create(@Body() dto: CreateFieldDto, @Req() req: AuthenticatedRequest) {
    return this.fieldsService.create(dto, req.user.sub);
  }

  @Get()
  findAll(@Req() req: AuthenticatedRequest) {
    return this.fieldsService.findAll(req.user.sub);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fieldsService.findOne(id, req.user.sub);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFieldDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fieldsService.update(id, dto, req.user.sub);
  }

  @Patch(':fieldId/lots/:lotId')
  updateLot(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: UpdateFieldLotDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fieldsService.updateLot(fieldId, lotId, dto, req.user.sub);
  }

  @Post(':fieldId/lots')
  createLot(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: CreateFieldLotDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fieldsService.createLot(fieldId, dto, req.user.sub);
  }

  @Delete(':fieldId/lots/:lotId')
  removeLot(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.fieldsService.removeLot(fieldId, lotId, req.user.sub);
  }
}
