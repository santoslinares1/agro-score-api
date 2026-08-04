import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessRequestController } from './access-request.controller';
import { AccessRequestService } from './access-request.service';
import { AccessRequest } from './entities/access-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AccessRequest])],
  controllers: [AccessRequestController],
  providers: [AccessRequestService],
})
export class AccessRequestModule {}
