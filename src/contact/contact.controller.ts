import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // SEC-003: 3 requests/minuto por IP — mitigación básica de spam/flood
  // contra el formulario público antes de tener captcha/honeytrap.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateContactDto) {
    return this.contactService.sendContactRequest(dto);
  }
}
