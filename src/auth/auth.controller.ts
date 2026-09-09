import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SEC-003: 5 requests/minuto por IP — evita fuerza bruta de credenciales
  // y flood de registros antes de exponer el backend a internet.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.me(req.user.sub);
  }

  // ADMIN-2: mismo rate limit que register/login (SEC-003) — endpoint
  // público, el token de invitación es de un solo uso pero igual conviene
  // no dejarlo abierto a fuerza bruta.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept-invitation')
  acceptInvitation(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    return this.authService.acceptInvitation(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // ADMIN-3: mismo rate limit/criterio que accept-invitation — token de un
  // solo uso, pero endpoint público igual.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('logout')
  logout() {
    return { message: 'ok' };
  }

  // PROFILE-SEC-1: verifica password actual — mismo riesgo de fuerza bruta
  // que login/reset-password (acá el atacante necesita un JWT robado, pero
  // igual conviene no dejar la verificación de password sin límite). Mismo
  // rate limit que SEC-003.
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: Request & { user: AuthenticatedUser },
  ) {
    return this.authService.changePassword(req.user.sub, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // PROFILE-SEC-1: no verifica password ni tiene superficie de fuerza
  // bruta — solo requiere una sesión autenticada válida, mismo criterio que
  // /auth/me (sin ThrottlerGuard).
  @UseGuards(JwtAuthGuard)
  @Post('revoke-other-sessions')
  revokeOtherSessions(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.revokeOtherSessions(req.user.sub, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // PROFILE-SEC-1: verifica password actual antes de desactivar — mismo
  // rate limit que change-password.
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('deactivate-account')
  deactivateAccount(
    @Body() dto: DeactivateAccountDto,
    @Req() req: Request & { user: AuthenticatedUser },
  ) {
    return this.authService.deactivateAccount(req.user.sub, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
