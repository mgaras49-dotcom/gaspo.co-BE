import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Query parameters that carry a credential. Several redirect-style routes take
 * one in the URL — the Space magic link (`?token=`) and the Meta OAuth callback
 * (`?code=`, `?state=`) — and a request log is a long-lived, widely-readable
 * artifact, so their values never reach it.
 */
const SENSITIVE_QUERY_PARAMS = new Set(['token', 'code', 'state', 'access_token', 'secret']);

/** The request URL with any credential-bearing query values masked. */
export function redactUrl(url: string): string {
  const split = url.indexOf('?');
  if (split === -1) return url;

  const path = url.slice(0, split);
  const params = new URLSearchParams(url.slice(split + 1));
  let redacted = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, '[redacted]');
      redacted = true;
    }
  }
  if (!redacted) return url;
  // URLSearchParams percent-encodes the mask; put it back for readability.
  return `${path}?${params.toString().replace(/%5Bredacted%5D/g, '[redacted]')}`;
}

/** The HTTP status a handler's error will answer with: an HttpException's own, else 500. */
export function errorStatus(error: unknown): number {
  const status = (error as { getStatus?: () => unknown })?.getStatus?.();
  return typeof status === 'number' ? status : 500;
}

/**
 * Logs each incoming request and the time taken to handle it — refused and
 * failed ones too, with their status. Only successes used to be logged, so on
 * 7 Oct 2026, when a scanner-style signup (an *.oast.online email) walked the
 * dashboard API, the log could show what it read but not what it was refused.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(`${method} ${redactUrl(url)} ${Date.now() - start}ms`);
        },
        error: (error: unknown) => {
          this.logger.warn(
            `${method} ${redactUrl(url)} ${errorStatus(error)} ${Date.now() - start}ms`,
          );
        },
      }),
    );
  }
}
