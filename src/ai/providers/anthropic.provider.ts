import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AppConfig } from '../../config/configuration';
import { CACHE_TTL } from './model-catalog';
import { Attachment } from '../attachments';
import {
  AttachmentRejectedError,
  isAttachmentRejection,
  LlmProvider,
  McpConnectionError,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStopReason,
  RemoteToolActivity,
  ToolCall,
} from './provider.interface';

/** Beta flag enabling the remote MCP connector on the Messages API. */
const MCP_BETA = 'mcp-client-2025-11-20';

/**
 * Room for the longest single reply: a page Gaspo writes is one tool call
 * holding the whole HTML document, often 15K tokens after thinking. Streamed,
 * because the SDK refuses a non-streamed request whose limit could run past
 * ten minutes, and a long silent request is the one a proxy drops.
 */
const MAX_TOKENS = 32000;

/**
 * Marks a cache breakpoint: everything rendered before it is stored and, on a
 * later request with a byte-identical prefix, billed at a tenth of the input
 * rate instead of full price. The TTL comes from the catalogue so it cannot
 * drift from the write multiplier credits are charged at.
 */
const CACHE: Anthropic.Beta.BetaCacheControlEphemeral = { type: 'ephemeral', ttl: CACHE_TTL };

/**
 * How many of the transcript's trailing user turns get a breakpoint. Two rather
 * than one because a breakpoint only looks back twenty content blocks for an
 * earlier entry to resume from, and a single agent-loop pass can append more
 * than that in tool results alone — the older mark stays inside the window when
 * the newer one has already been pushed out of it. Three total with the one on
 * the system block, against a ceiling of four.
 */
const TRANSCRIPT_BREAKPOINTS = 2;

/**
 * Anthropic's server-side web tools, run on its side like the MCP connectors.
 * The 20260209 versions filter results with code execution before they reach
 * the context, which keeps search-heavy research from flooding the prompt; they
 * need Sonnet 5 / Opus 4.6 or later, which is everything in the catalogue.
 *
 * max_uses caps one request's searches (each is billed) and fetches;
 * max_content_tokens stops one huge page from eating the context.
 */
const WEB_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10, max_content_tokens: 40000 },
];

/** Server tools reported in the run audit, under this app label. */
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

/**
 * Anthropic adapter. Connected apps are handed over as server-side MCP servers,
 * so Anthropic runs those tools itself and we only execute our own local tools —
 * the arrangement Gaspo has always used, kept intact.
 */
@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private readonly logger = new Logger(AnthropicProvider.name);
  private client: Anthropic | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  isConfigured(): boolean {
    return Boolean(this.configService.get('ai', { infer: true }).anthropicApiKey);
  }

  private getClient(): Anthropic {
    if (!this.client) {
      const ai = this.configService.get('ai', { infer: true });
      if (!ai.anthropicApiKey) {
        throw new ServiceUnavailableException('AI is not configured (set ANTHROPIC_API_KEY)');
      }
      this.client = new Anthropic({ apiKey: ai.anthropicApiKey });
    }
    return this.client;
  }

  async create(request: ProviderRequest): Promise<ProviderResponse> {
    const client = this.getClient();
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...request.mcpServers.map((server) => ({
        type: 'mcp_toolset' as const,
        mcp_server_name: server.name,
        // Deny by default and name the wanted actions: the provider then fetches
        // only those schemas rather than the app's entire catalogue. `configs` is
        // a map keyed by tool name, not a list — an array is rejected outright.
        ...(server.enabledTools?.length
          ? {
              default_config: { enabled: false },
              configs: Object.fromEntries(
                server.enabledTools.map((tool) => [tool, { enabled: true }]),
              ),
            }
          : {}),
      })),
      ...request.tools.map((tool) => ({
        type: 'custom' as const,
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Beta.BetaTool['input_schema'],
      })),
      ...(request.webAccess ? WEB_TOOLS : []),
    ];
    const mcpServers = request.mcpServers.map((server) => ({
      type: 'url' as const,
      url: server.url,
      name: server.name,
      authorization_token: server.authorizationToken,
    }));

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages
        .stream({
          model: request.model,
          max_tokens: MAX_TOKENS,
          // Pre-4.6 models reject the parameter outright, so it is opt-in per model.
          ...(request.capabilities.adaptiveThinking
            ? { thinking: { type: 'adaptive' as const } }
            : {}),
          // Tools render before the system prompt and both are identical on every
          // turn of a run, so one breakpoint here caches that entire prefix — the
          // bulk of what we send. Volatile content (the transcript) comes after it.
          system: [{ type: 'text', text: request.system, cache_control: CACHE }],
          messages: this.withTranscriptCache(this.toAnthropicMessages(request.messages)),
          ...(tools.length ? { tools } : {}),
          ...(mcpServers.length ? { mcp_servers: mcpServers } : {}),
          betas: [MCP_BETA],
        })
        .finalMessage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Anthropic request failed: ${message}`);
      // A single unreachable MCP server makes Anthropic 400 the whole request;
      // surfaced as its own type so the caller can retry without connectors.
      if (message.includes('MCP server')) throw new McpConnectionError(message);
      if (isAttachmentRejection(request.messages, message)) {
        throw new AttachmentRejectedError(message);
      }
      throw new ServiceUnavailableException(`AI request failed: ${message}`);
    }

    return this.fromAnthropicMessage(response);
  }

  /**
   * Replays assistant turns from their original blocks when we have them —
   * Anthropic rejects edited thinking blocks, and its MCP blocks have no neutral
   * equivalent to rebuild from. Turns that came from another provider (or from
   * stored chat history) fall back to plain text.
   */
  private toAnthropicMessages(messages: ProviderMessage[]): Anthropic.Beta.BetaMessageParam[] {
    return messages.map((message) => {
      if (message.role === 'user') {
        if (!message.attachments?.length) {
          return { role: 'user' as const, content: message.content };
        }
        // Files ahead of the words: Anthropic reads a question asked after its
        // documents better than one asked before them. The text block stays last
        // so the transcript cache marker below still has somewhere to go.
        return {
          role: 'user' as const,
          content: [
            ...message.attachments.map((attachment) => this.attachmentBlock(attachment)),
            { type: 'text' as const, text: message.content },
          ],
        };
      }
      if (message.role === 'assistant') {
        if (message.raw) {
          return {
            role: 'assistant' as const,
            content: message.raw as Anthropic.Beta.BetaContentBlockParam[],
          };
        }
        return { role: 'assistant' as const, content: message.content };
      }
      return {
        role: 'user' as const,
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    });
  }

  /** A PDF or image as the file itself; extracted text as a titled text document. */
  private attachmentBlock(attachment: Attachment): Anthropic.Beta.BetaContentBlockParam {
    if (attachment.kind === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data },
      };
    }
    return {
      type: 'document',
      title: attachment.name,
      source:
        attachment.kind === 'pdf'
          ? { type: 'base64', media_type: 'application/pdf', data: attachment.data }
          : { type: 'text', media_type: 'text/plain', data: attachment.text },
    };
  }

  /**
   * Extends the cache over the transcript by marking the last
   * {@link TRANSCRIPT_BREAKPOINTS} user turns, so each pass of the agent loop
   * reads back the turns the previous pass wrote instead of re-paying for the
   * whole conversation.
   *
   * Walks from the end rather than looking only at the final turn: a pass that
   * ends on an assistant turn still has cacheable user turns behind it, and
   * marking them costs nothing while leaving a resume point for the next pass.
   *
   * Only user and tool-result turns are marked: assistant turns replay from
   * their original blocks, and Anthropic rejects a thinking block that has been
   * edited in any way, including by adding cache_control to it.
   */
  private withTranscriptCache(
    messages: Anthropic.Beta.BetaMessageParam[],
  ): Anthropic.Beta.BetaMessageParam[] {
    const marked = [...messages];
    let remaining = TRANSCRIPT_BREAKPOINTS;
    for (let i = marked.length - 1; i >= 0 && remaining > 0; i--) {
      const message = marked[i];
      if (message.role !== 'user') continue;
      const blocks: Anthropic.Beta.BetaContentBlockParam[] =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : [...message.content];
      const tail = blocks[blocks.length - 1];
      // Not every block type carries cache_control (a thinking block rejects it
      // outright). Text and tool results are the only ones a user turn of ours
      // ever ends on; anything else simply goes uncached rather than erroring.
      if (tail?.type !== 'text' && tail?.type !== 'tool_result') continue;
      blocks[blocks.length - 1] = { ...tail, cache_control: CACHE };
      marked[i] = { role: 'user', content: blocks };
      remaining--;
    }
    return marked;
  }

  private fromAnthropicMessage(response: Anthropic.Beta.BetaMessage): ProviderResponse {
    let text = '';
    const toolCalls: ToolCall[] = [];
    const remoteActivity: RemoteToolActivity[] = [];
    // Web tool calls by id, so a result can mark its call as failed.
    const webCalls = new Map<string, RemoteToolActivity>();

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'mcp_tool_use') {
        remoteActivity.push({ app: block.server_name, tool: block.name, isError: false });
      } else if (block.type === 'mcp_tool_result') {
        // Results arrive immediately after their call, so the open activity is
        // always the last one pushed.
        const last = remoteActivity[remoteActivity.length - 1];
        if (last) last.isError = block.is_error ?? false;
      } else if (block.type === 'server_tool_use' && WEB_TOOL_NAMES.has(block.name)) {
        const activity = { app: 'web', tool: block.name, isError: false };
        webCalls.set(block.id, activity);
        remoteActivity.push(activity);
      } else if (
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result'
      ) {
        // Failures arrive as HTTP 200 with an error object in place of results.
        const call = webCalls.get(block.tool_use_id);
        const content = block.content as { type?: string } | unknown[];
        if (call && !Array.isArray(content)) {
          call.isError = Boolean(content.type?.endsWith('_error'));
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    let stopReason: ProviderStopReason = 'end';
    if (response.stop_reason === 'max_tokens') stopReason = 'truncated';
    else if (response.stop_reason === 'tool_use' && toolCalls.length) stopReason = 'tool_use';
    else if (response.stop_reason === 'pause_turn') stopReason = 'pause';

    // Anthropic reports cached tokens separately and leaves them out of
    // `input_tokens`. Summing keeps the number meaning "size of the prompt we
    // sent", which is what usage and credit charging have always recorded — the
    // caching saving lands on our side of the bill, not the workspace's.
    const cacheWrites = response.usage.cache_creation_input_tokens ?? 0;
    const cacheReads = response.usage.cache_read_input_tokens ?? 0;
    this.logger.log(
      `Anthropic usage: ${response.usage.input_tokens} uncached, ` +
        `${cacheWrites} cache write, ${cacheReads} cache read`,
    );

    return {
      text,
      toolCalls,
      remoteActivity,
      usage: {
        inputTokens: response.usage.input_tokens + cacheWrites + cacheReads,
        outputTokens: response.usage.output_tokens,
        cacheWriteTokens: cacheWrites,
        cacheReadTokens: cacheReads,
        webSearches: response.usage.server_tool_use?.web_search_requests ?? 0,
      },
      stopReason,
      raw: response.content,
    };
  }
}
