import { Controller, Get, Header } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  @Header('Cache-Control', 'no-store')
  getHealth() {
    return { status: 'ok', service: 'tsms-api' };
  }
}
