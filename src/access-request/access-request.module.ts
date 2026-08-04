import { Module } from '@nestjs/common';

import { AccessRequestController } from './access-request.controller';
import { AccessRequestService } from './access-request.service';

@Module({
  controllers: [AccessRequestController],
  providers: [AccessRequestService],
})
export class AccessRequestModule {}
