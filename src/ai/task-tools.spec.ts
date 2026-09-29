import assert from 'node:assert/strict';
import test from 'node:test';
import { AiService } from './ai.service';
import type { CreateTaskDto } from '../tasks/dto';

/**
 * AiService with only what the task tools touch: a fake task store that
 * records what it was asked to create.
 */
function service() {
  const created: CreateTaskDto[] = [];
  const ai = Object.create(AiService.prototype) as AiService;
  Object.assign(ai, {
    tasksService: {
      create: (_workspaceId: string, _userId: string | null, dto: CreateTaskDto) => {
        created.push(dto);
        return Promise.resolve({
          id: 't1',
          name: dto.name,
          cronExpression: dto.cronExpression,
          timezone: dto.timezone ?? null,
          slackChannelId: dto.slackChannelId ?? null,
          nextRun: '2026-09-30T22:00:00.000Z',
        });
      },
    },
  });
  const run = (
    input: Record<string, unknown>,
    ctx: { slackChannelId: string | null; fetchRequesterTimezone?: () => Promise<string | null> },
  ) =>
    (
      ai as unknown as {
        runTaskTool: (
          workspaceId: string,
          userId: string | null,
          call: { id: string; name: string; input: Record<string, unknown> },
          context: typeof ctx,
        ) => Promise<{ content: string; is_error?: boolean }>;
      }
    ).runTaskTool('w1', 'u1', { id: 'c1', name: 'create_scheduled_task', input }, ctx);
  return { run, created };
}

void test('a task asked for in Slack posts back there, on the requester’s clock', async () => {
  const { run, created } = service();
  let lookups = 0;
  const result = await run(
    {
      name: 'Inbox triage',
      prompt: 'Sort my new Gmail and list what needs a reply',
      cron_expression: '0 8 * * *',
    },
    {
      slackChannelId: 'D123',
      fetchRequesterTimezone: () => {
        lookups += 1;
        return Promise.resolve('Australia/Sydney');
      },
    },
  );

  assert.equal(result.is_error, undefined);
  assert.equal(created[0].slackChannelId, 'D123');
  assert.equal(created[0].timezone, 'Australia/Sydney');
  assert.equal(lookups, 1);
});

void test('an explicit timezone and channel win, and skip the Slack lookup', async () => {
  const { run, created } = service();
  let lookups = 0;
  await run(
    {
      name: 'Weekly revenue',
      prompt: 'Post last week’s Xero revenue',
      cron_expression: '0 9 * * 1',
      timezone: 'Europe/London',
      slack_channel_id: 'C999',
    },
    {
      slackChannelId: 'D123',
      fetchRequesterTimezone: () => {
        lookups += 1;
        return Promise.resolve('Australia/Sydney');
      },
    },
  );

  assert.equal(created[0].timezone, 'Europe/London');
  assert.equal(created[0].slackChannelId, 'C999');
  assert.equal(lookups, 0);
});

void test('a task without a prompt is refused back to the model, not stored', async () => {
  const { run, created } = service();
  const result = await run(
    { name: 'Empty', cron_expression: '0 8 * * *' },
    { slackChannelId: null },
  );

  assert.equal(result.is_error, true);
  assert.equal(created.length, 0);
});
