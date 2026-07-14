import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Field } from './entities/field.entity';
import { FieldLot } from './entities/field-lot.entity';
import { FieldsController } from './fields.controller';
import { FieldsService } from './fields.service';

@Module({
  imports: [TypeOrmModule.forFeature([Field, FieldLot])],
  controllers: [FieldsController],
  providers: [FieldsService],
  exports: [FieldsService],
})
export class FieldsModule {}
