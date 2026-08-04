import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { resolveCorsOrigins } from './config/cors-origins.util';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SEC-FIX-1: cabeceras de seguridad HTTP estándar. No interfiere con CORS
  // (son middlewares independientes) ni con el CORS_ORIGIN + credentials ni
  // con el preflight OPTIONS; crossOriginResourcePolicy default ('same-origin')
  // solo bloquea requests no-cors (ej. <img>/<script> cross-origin), no fetch/XHR
  // en modo cors como el que usa el frontend (incluida la descarga del PDF vía blob).
  app.use(helmet());

  const config = app.get(ConfigService);

  // DEPLOY-AWS-1: CORS_ORIGIN admite lista separada por comas (landing en
  // S3/CloudFront puede responder desde apex + www, o desde el dominio de
  // CloudFront mientras no haya dominio propio). Sin CORS_ORIGIN, se
  // mantiene el comportamiento previo de un solo origin vía FRONTEND_URL.
  const corsOrigins = resolveCorsOrigins(
    config.get<string>('CORS_ORIGIN'),
    config.get<string>('FRONTEND_URL'),
  );

  app.enableCors({
    origin: corsOrigins,
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

bootstrap().catch((error: Error) => {
  console.error(`[bootstrap] No se pudo iniciar el backend: ${error.message}`);
  process.exit(1);
});
