import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // DEPLOY-AWS-1: healthcheck liviano para Docker/Nginx/monitoreo — no toca
  // DB ni worker, solo confirma que el proceso Node está vivo y respondiendo.
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
