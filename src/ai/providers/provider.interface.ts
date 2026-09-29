import type { Attachment } from '../attachments';

/**
 * Provider-neutral shapes for a model run.
 *
 * AiService owns the agent loop and all business logic; a provider is a thin
 * adapter that renders these shapes into one vendor's wire format and maps the
 * reply back. Anything vendor-specific — Anthropic's server-side MCP connector,
 * OpenAI's `tool_calls` — is confined to the adapter.
 */

/** JSON Schema for a tool's arguments. Kept loose: it is passed straight through. */
export type JsonSchema = Record<string, unknown>;

/**
 * A tool the model may call, in neither vendor's dialect. Providers translate
 * this at request time (Anthropic wants `input_schema`, OpenAI `parameters`).
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** A tool invocation the model asked for, to be executed and answered. */
export interface ToolCall {
  /** Provider-assigned id, echoed back so the reply is matched to the call. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The outcome of a {@link ToolCall}, fed back into the conversation. */
export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * One turn of the run's transcript.
 *
 * `raw` carries the provider's own representation of an assistant turn so it can
 * be replayed byte-identical on the next request — Anthropic rejects edited
 * thinking blocks, and its MCP blocks have no neutral equivalent. Providers that
 * did not produce a given turn rebuild it from `content` + `toolCalls` instead.
 */
export type ProviderMessage =
  | { role: 'user'; content: string; attachments?: Attachment[] }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] };

/** A remote MCP server the provider connects to itself (Anthropic only). */
export interface RemoteMcpServer {
  appSlug: string;
  name: string;
  url: string;
  authorizationToken?: string;
  /**
   * The subset of the app's actions to expose, by MCP tool name. A server's
   * whole action list is otherwise fetched and billed on every turn, and an app
   * like Google Ads carries 35 of them — measured at ~108K prompt tokens against
   * ~1K for two. Undefined means expose everything, which is the right answer
   * for an app small enough that narrowing would save nothing.
   */
  enabledTools?: string[];
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ProviderMessage[];
  /** Tools AiService executes itself, including any bridged MCP tools. */
  tools: ToolSpec[];
  /**
   * Servers the provider should connect to server-side. Only the Anthropic
   * adapter honours this; the gateway adapter is handed pre-bridged tools in
   * `tools` instead and ignores it.
   */
  mcpServers: RemoteMcpServer[];
  /**
   * Per-model capability flags resolved from the catalog, so an adapter does not
   * have to pattern-match on model ids to know what the API will accept.
   */
  capabilities: { adaptiveThinking: boolean };
  /**
   * Let the model search the web and read pages. Anthropic runs both itself as
   * server tools; other adapters ignore it. Set only on the agent loop — a
   * routing call has no use for the web and would pay for the tool schemas.
   */
  webAccess?: boolean;
}

/**
 * Why the model stopped. `pause` means the provider hit its own per-turn
 * iteration cap mid-work and the accumulated conversation should be re-sent
 * unchanged (Anthropic's `pause_turn`). `truncated` means the reply ran into the
 * output limit, so any tool call in it may be cut off partway.
 */
export type ProviderStopReason = 'end' | 'tool_use' | 'pause' | 'truncated';

/** A tool the provider ran on its own side, recorded for the run's audit trail. */
export interface RemoteToolActivity {
  /** The MCP server name the call went to. */
  app: string;
  tool: string;
  isError: boolean;
}

export interface ProviderResponse {
  /** Text emitted this turn. Accumulated across turns into the final answer. */
  text: string;
  /** Calls for AiService to execute and answer. */
  toolCalls: ToolCall[];
  /** Tools the provider executed server-side, already complete. */
  remoteActivity: RemoteToolActivity[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    /**
     * The cached slices of {@link inputTokens}, when the provider reports them.
     * They are already counted in `inputTokens` — a workspace is charged for the
     * whole prompt it sent — and are broken out only because they are billed to
     * us at different rates (a write costs more than fresh input, a read far
     * less). Without them a cache-heavy run's cost cannot be derived at all.
     */
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    /** Web searches the provider ran this call, billed per search on top of tokens. */
    webSearches?: number;
    /**
     * What the provider says this call actually cost us, in USD. Only gateways
     * that report a per-response cost set this; when absent the cost is derived
     * from the catalog's list price instead.
     */
    costUsd?: number;
    /**
     * The model that actually served the request, when it differs from the one
     * asked for. Router ids like `auto/best-coding` pick a different backend per
     * call, so the requested id alone cannot explain a bill.
     */
    resolvedModel?: string;
  };
  stopReason: ProviderStopReason;
  /** Provider-native assistant content, replayed verbatim on the next turn. */
  raw: unknown;
}

/**
 * The provider could not reach a remote MCP server (a Pipedream connector being
 * down or unresponsive), as opposed to genuinely rejecting the request. AiService
 * retries these once without connected apps so a prompt that needs no app still
 * gets answered.
 */
export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/**
 * The model refused a file the user attached — a PDF over the page limit, an
 * encrypted one, an image it cannot decode — and with it the whole request.
 * AiService retries once without attachments, telling the model why, so the user
 * hears what was wrong with the file instead of a generic failure.
 */
export class AttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentRejectedError';
  }
}

/**
 * Whether a failed request was refused over an attached file rather than for
 * some other reason. Only asked when the request carried attachments, so a
 * mention of "image" or "document" in an unrelated error cannot trigger it.
 */
export function isAttachmentRejection(messages: ProviderMessage[], errorMessage: string): boolean {
  const hadAttachments = messages.some(
    (message) => message.role === 'user' && Boolean(message.attachments?.length),
  );
  return hadAttachments && /\b(pdf|image|document|file)\b|too.large/i.test(errorMessage);
}

/** Adapter for one vendor's chat API. */
export interface LlmProvider {
  /** Catalog key this adapter serves, e.g. `anthropic`. */
  readonly id: string;
  /** False when the adapter has no credentials configured. */
  isConfigured(): boolean;
  create(request: ProviderRequest): Promise<ProviderResponse>;
}
