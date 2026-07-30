import { Module } from '@nestjs/common';
import { LotsController } from './lots.controller';

@Module({
  controllers: [LotsController],
})
export class LotsModule {}
