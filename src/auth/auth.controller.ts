import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthenticatedUser } from './jwt.strategy';

// SEC-002 (AUTH-POLICY-1): `POST /auth/register` fue eliminado — el registro
// público quedó cerrado por decisión de producto (onboarding invitation-only
// en producción). El alta válida de una cuenta nueva pasa exclusivamente por
// `POST /auth/accept-invitation` (token emitido desde Admin, ver más abajo) o
// por creación administrativa (`POST /admin/users`,
// `POST /admin/access-requests/:id/create-user`). Ver docs/admin-backend.md
// y docs/audits/access-request-flow.md (deuda AUTH-POLICY-1, ahora resuelta).
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // SEC-003: 5 requests/minuto por IP — evita fuerza bruta de credenciales.
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

  // SEC-003: logout autenticado — revoca TODOS los JWT emitidos antes para
  // este usuario (ver AuthService.logout). `userId` se deriva exclusivamente
  // de `req.user.sub` (poblado por JwtStrategy tras validar firma,
  // expiración, isActive y tokenVersion) — nunca de body/query/path. Sin
  // ThrottlerGuard, mismo criterio que /auth/me y /auth/revoke-other-sessions:
  // no verifica ninguna password, no hay superficie de fuerza bruta que
  // limitar acá (un atacante ya necesitaría un JWT robado).
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Req() req: Request & { user: AuthenticatedUser }) {
    return this.authService.logout(req.user.sub, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
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
