import assert from 'node:assert/strict';
import test from 'node:test';
import { ArgumentsHost, ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** Run one exception through the filter and capture what it logged and sent. */
function handle(exception: unknown, url = '/super-admin/overview') {
  const warned: string[] = [];
  const errored: string[] = [];
  const filter = new AllExceptionsFilter();
  const logger = (filter as unknown as { logger: Logger }).logger;
  logger.warn = (message: unknown) => void warned.push(String(message));
  logger.error = (message: unknown) => void errored.push(String(message));
  let sent: { status?: number; body?: unknown } = {};
  const response = {
    status: (status: number) => ({ json: (body: unknown) => void (sent = { status, body }) }),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return { warned, errored, sent };
}

void test('a refused request is logged with its status', () => {
  // Guards reject before the request logger runs, so this is the only record.
  assert.deepEqual(handle(new UnauthorizedException()).warned, [
    'GET /super-admin/overview -> 401',
  ]);
  assert.deepEqual(handle(new ForbiddenException()).warned, ['GET /super-admin/overview -> 403']);
});

void test('a refused request logs its URL with credentials masked', () => {
  const { warned } = handle(new UnauthorizedException(), '/spaces/x/auth?token=abc123');
  assert.deepEqual(warned, ['GET /spaces/x/auth?token=[redacted] -> 401']);
});

void test('a server error still logs as an error, not a warning', () => {
  const { warned, errored, sent } = handle(new Error('database down'));
  assert.equal(warned.length, 0);
  assert.deepEqual(errored, ['GET /super-admin/overview -> 500']);
  assert.equal(sent.status, 500);
});
