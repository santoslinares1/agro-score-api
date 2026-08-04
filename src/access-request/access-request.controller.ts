import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { AccessRequestService } from './access-request.service';
import { CreateAccessRequestDto } from './dto/create-access-request.dto';

@Controller('access-request')
export class AccessRequestController {
  constructor(private readonly accessRequestService: AccessRequestService) {}

  // ACCESS-REQUEST-1: 3 requests/minuto por IP — misma mitigación básica de
  // spam/flood que /contact para este formulario público.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateAccessRequestDto) {
    return this.accessRequestService.sendAccessRequest(dto);
  }
}
