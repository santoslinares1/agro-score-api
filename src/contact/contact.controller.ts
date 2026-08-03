import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateContactDto) {
    return this.contactService.sendContactRequest(dto);
  }
}
