import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const frontendUrl =
    config.get<string>('FRONTEND_URL') || 'http://localhost:4200';

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
    // PDF-1: sin esto el frontend no puede leer el nombre de archivo real que manda
    // Content-Disposition en /analysis/:id/report/pdf (fetch/XHR ocultan este header en
    // requests cross-origin salvo que el servidor lo exponga explícitamente).
    exposedHeaders: ['Content-Disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
}

bootstrap();
