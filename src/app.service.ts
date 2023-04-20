import { Injectable } from '@nestjs/common'

@Injectable()
export class AppService {
  checkHealth(): string {
    return 'healthcheck:dev ' + process.env.DATABASE_URL
  }
}
