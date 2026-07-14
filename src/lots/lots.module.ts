import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lot } from './entities/lot.entity';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lot])],
  controllers: [LotsController],
  providers: [LotsService],
  exports: [LotsService],
})
export class LotsModule {}
