import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { AnthropicProvider } from './anthropic.provider';
import { webSearchCredits } from './model-catalog';
import type { ProviderRequest } from './provider.interface';

/** A provider whose SDK client records the request and replies with `content`. */
function stubbed(content: unknown[], webSearchRequests = 0) {
  const sent: Record<string, unknown>[] = [];
  const provider = new AnthropicProvider({} as ConfigService<AppConfig, true>);
  (provider as unknown as { client: unknown }).client = {
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          sent.push(body);
          return {
            finalMessage: () =>
              Promise.resolve({
                content,
                stop_reason: 'end_turn',
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  server_tool_use: {
                    web_search_requests: webSearchRequests,
                    web_fetch_requests: 0,
                  },
                },
              }),
          };
        },
      },
    },
  };
  return { provider, sent };
}

function request(webAccess: boolean): ProviderRequest {
  return {
    model: 'claude-sonnet-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    mcpServers: [],
    capabilities: { adaptiveThinking: true },
    webAccess,
  };
}

const toolTypes = (body: Record<string, unknown>): string[] =>
  ((body.tools as { type: string }[] | undefined) ?? []).map((tool) => tool.type);

void test('web tools are sent only when the run asks for web access', async () => {
  const { provider, sent } = stubbed([{ type: 'text', text: 'ok' }]);
  await provider.create(request(true));
  await provider.create(request(false));

  assert.deepEqual(toolTypes(sent[0]), ['web_search_20260209', 'web_fetch_20260209']);
  // A routing call (no web access) must not pay for the tool schemas.
  assert.deepEqual(toolTypes(sent[1]), []);
});

void test('web tool calls are audited, with a failed fetch marked as an error', async () => {
  const { provider } = stubbed(
    [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'viktor ai' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'server_tool_use', id: 'f1', name: 'web_fetch', input: { url: 'https://x.test' } },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'f1',
        content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
      },
      { type: 'text', text: 'Here is what I found.' },
    ],
    1,
  );

  const response = await provider.create(request(true));

  assert.deepEqual(response.remoteActivity, [
    { app: 'web', tool: 'web_search', isError: false },
    { app: 'web', tool: 'web_fetch', isError: true },
  ]);
  assert.equal(response.usage.webSearches, 1);
  assert.equal(response.text, 'Here is what I found.');
});

void test('web searches cost a cent each, in credits', () => {
  // $10 per 1,000 searches at 400 credits per dollar, no margin.
  assert.equal(webSearchCredits(3), 12);
  assert.equal(webSearchCredits(0), 0);
});
