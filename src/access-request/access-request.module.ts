import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailModule } from '../email/email.module';
import { AccessRequestController } from './access-request.controller';
import { AccessRequestService } from './access-request.service';
import { AccessRequest } from './entities/access-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AccessRequest]), EmailModule],
  controllers: [AccessRequestController],
  providers: [AccessRequestService],
})
export class AccessRequestModule {}
