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

/**
 * Logs each incoming request and the time taken to handle it.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        this.logger.log(`${method} ${redactUrl(url)} ${Date.now() - start}ms`);
      }),
    );
  }
}
