import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateLotDto } from './dto/create-lot.dto';
import { UpdateLotDto } from './dto/update-lot.dto';
import { LotsService } from './lots.service';

@Controller('lots')
export class LotsController {
  constructor(private readonly lotsService: LotsService) {}

  @Post()
  create(@Body() createLotDto: CreateLotDto) {
    return this.lotsService.create(createLotDto);
  }

  @Get()
  findAll() {
    return this.lotsService.findAll();
  }

  @Get(':id/pipeline-input')
  getPipelineInput(@Param('id', ParseUUIDPipe) id: string) {
    return this.lotsService.getPipelineInput(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.lotsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateLotDto: UpdateLotDto,
  ) {
    return this.lotsService.update(id, updateLotDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.lotsService.remove(id);
  }
}
