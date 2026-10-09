import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { redactUrl } from '../interceptors/logging.interceptor';

interface ErrorResponseBody {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error: string;
}

/**
 * Global exception filter that normalizes every error into a consistent JSON shape
 * and logs unexpected (non-HTTP) failures.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, error } = this.resolveMessage(exception, status);
    // A failing request is exactly the one whose URL gets read later, so the
    // same masking the request log applies is applied here too.
    const path = redactUrl(request.url);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${path} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= HttpStatus.BAD_REQUEST) {
      // Refusals too, since the request log only records successes and guards
      // reject before it runs. On 7 Oct 2026 a scanner-style signup (an
      // *.oast.online email) walked the dashboard API, and the log could show
      // what it read but nothing it was refused.
      this.logger.warn(`${request.method} ${path} -> ${status}`);
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path,
      method: request.method,
      message,
      error,
    };

    response.status(status).json(body);
  }

  private resolveMessage(
    exception: unknown,
    status: number,
  ): { message: string | string[]; error: string } {
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        return { message: res, error: exception.name };
      }
      const obj = res as Record<string, unknown>;
      return {
        message: (obj.message as string | string[]) ?? exception.message,
        error: (obj.error as string) ?? exception.name,
      };
    }

    return {
      message:
        status === HttpStatus.INTERNAL_SERVER_ERROR ? 'Internal server error' : 'Unexpected error',
      error: 'InternalServerError',
    };
  }
}
