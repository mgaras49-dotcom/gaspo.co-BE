import { Injectable, Logger } from '@nestjs/common';
import { LlmProvider, RemoteMcpServer, ToolSpec } from './provider.interface';

/**
 * Below this many bridged tools, routing is skipped: the prompt savings do not
 * justify an extra provider round-trip, and sending them all is cheap enough.
 */
const ROUTE_THRESHOLD = 20;

/**
 * Below this many connected servers there is nothing to route: with one server
 * the choice is send-it-or-fail, and the round-trip costs more than it saves.
 */
const SERVER_ROUTE_THRESHOLD = 1;

/**
 * Below this many actions an app is cheap enough to expose whole. Far lower than
 * {@link ROUTE_THRESHOLD} because an action's schema is large — a handful of
 * them already outweighs the router call that would narrow them.
 */
const ACTION_ROUTE_THRESHOLD = 4;

/** A candidate the router can pick by name: a local tool or a bridged action. */
export interface RoutableAction {
  name: string;
  description?: string;
}

/**
 * Hard ceiling on how many tool descriptions go into the router prompt. A
 * pathological workspace with hundreds of tools would otherwise make the router
 * call itself expensive; the candidate list is already app-fair (round-robin),
 * so a cap still spans every connected app.
 */
const MAX_CANDIDATES_IN_PROMPT = 200;

/** Only the first slice of a tool description is needed to judge relevance. */
const DESCRIPTION_PREVIEW_CHARS = 160;

const ROUTER_SYSTEM_PROMPT =
  'You are a tool selector. You are given a user request and a list of available ' +
  'tools, each as "name: description". Return the tools that could plausibly be ' +
  'needed to fulfil the request, as a JSON array of tool names and nothing else.\n\n' +
  'Bias hard toward recall: a missing tool makes the task fail outright, while an ' +
  'extra tool only costs a little prompt space. Include a tool if there is any ' +
  'reasonable chance it helps, including tools needed to gather ids or context ' +
  'before the main action. Only return an empty array if the request plainly needs ' +
  'no tool at all (e.g. a greeting or a general question). Respond with the JSON ' +
  'array only — no prose, no code fences.';

const SERVER_ROUTER_SYSTEM_PROMPT =
  'You are an app selector. You are given a user request, the built-in tools the ' +
  'assistant already has, and a list of apps the workspace has connected, each as ' +
  '"id (name)". Return the connected apps the request actually needs, as a JSON ' +
  'array of app ids and nothing else.\n\n' +
  'Built-in tools cover their own domain, so an app is not needed merely to ' +
  'repeat what one already does. But when a connected app covers the same domain ' +
  'as a built-in, the two hold different data: the built-in cannot see inside the ' +
  'connected app.\n\n' +
  'So for a request that spans a domain rather than naming one platform — "list ' +
  'my ads accounts", "how are my campaigns doing", "what am I spending" — select ' +
  'every connected app in that domain alongside the built-ins. Answering from the ' +
  'built-in alone would silently omit whatever the connected app holds, and the ' +
  'user would never know it was missing. Only leave an app out when the request ' +
  'plainly cannot involve it.\n\n' +
  'Attaching an app is cheap — only the handful of its actions the request needs ' +
  'are loaded — so bias toward including one. Include any app needed to gather ' +
  'ids or context first. Return an empty array only when no connected app could ' +
  'contribute. Where one app has several accounts, each is listed as its own id ' +
  '("app:account"): pick the accounts the request is about, and every one of them only when it ' +
  'is about all of them. Respond with the JSON array only — no prose, no code fences.';

/**
 * Picks which bridged tools are worth sending for a given message.
 *
 * Gaspo sends every tool schema on every turn, so a workspace with many
 * connected apps spends tens of thousands of tokens describing tools the current
 * message will never touch. A cheap pre-pass — the model sees only tool *names*
 * and short descriptions, not their full schemas — narrows that to the relevant
 * few before the real run.
 *
 * This never fails a run: any error, timeout, or unparseable answer returns null,
 * and the caller falls back to sending the unfiltered (capped) toolset.
 */
@Injectable()
export class ToolRouterService {
  private readonly logger = new Logger(ToolRouterService.name);

  /**
   * Returns the subset of `candidates` worth sending, or null to mean "could not
   * decide — send them all". Null covers both the skip-when-few case and any
   * failure, so the caller treats them identically.
   */
  async selectRelevant(
    provider: LlmProvider,
    model: string,
    message: string,
    candidates: ToolSpec[],
  ): Promise<ToolSpec[] | null> {
    if (candidates.length <= ROUTE_THRESHOLD) return null;

    const considered = candidates.slice(0, MAX_CANDIDATES_IN_PROMPT);
    const names = await this.chooseNames(provider, model, message, considered);
    if (!names) return null;

    // Keep only names that are real candidates — the model can hallucinate one —
    // preserving the app-fair order the candidates already came in.
    const selected = considered.filter((tool) => names.has(tool.name));

    // An empty selection is ambiguous: a correct "nothing applies" and a wrong
    // "the model dropped everything" look identical, and the second fails a real
    // task. Falling back to unfiltered costs tokens but never capability.
    if (!selected.length) return null;

    this.logger.log(`Tool router kept ${selected.length}/${candidates.length} tools for this run`);
    return selected;
  }

  /**
   * Which of an attached app's individual actions this message needs.
   *
   * The server-side MCP path never shows us a tool's schema, but it does let us
   * name which of an app's actions to expose — and the provider then fetches
   * only those. That turns app attachment from a ~100K-token decision into a
   * ~1K-token one, which is what makes attaching an app on a maybe affordable.
   *
   * Returns the action names to expose, or null for "expose everything" — the
   * same failure-is-never-fatal contract as {@link selectRelevant}.
   */
  async selectRelevantActions(
    provider: LlmProvider,
    model: string,
    message: string,
    actions: RoutableAction[],
  ): Promise<string[] | null> {
    // Below a handful of actions the whole app is about as cheap as the router
    // call that would narrow it, and narrowing can only lose capability.
    if (actions.length <= ACTION_ROUTE_THRESHOLD) return null;

    const considered = actions.slice(0, MAX_CANDIDATES_IN_PROMPT);
    const names = await this.chooseNames(provider, model, message, considered);
    if (!names) return null;

    const selected = considered.filter((action) => names.has(action.name));
    if (!selected.length) return null;

    this.logger.log(`Action router kept ${selected.length}/${actions.length} actions for this run`);
    // Sorted so the same set always renders the same bytes: the toolset sits in
    // the cached prefix, and an order that wobbled between turns would miss the
    // cache for no reason.
    return selected.map((action) => action.name).sort();
  }

  /**
   * Ask the model which of `candidates` the request could need, by name. Shared
   * by both routing levels — they differ only in what a candidate is.
   */
  private async chooseNames(
    provider: LlmProvider,
    model: string,
    message: string,
    candidates: RoutableAction[],
  ): Promise<Set<string> | null> {
    const catalog = candidates
      .map((tool) => `- ${tool.name}: ${this.previewDescription(tool.description ?? '')}`)
      .join('\n');

    let text: string;
    try {
      const response = await provider.create({
        model,
        system: ROUTER_SYSTEM_PROMPT,
        // No tools: the candidates are described as text so the router prompt
        // stays small. Handing them over as real tools would recreate the very
        // bloat this exists to remove.
        tools: [],
        mcpServers: [],
        // A one-shot classification needs no extended thinking, and only the
        // gateway path routes anyway — where this flag is ignored.
        capabilities: { adaptiveThinking: false },
        messages: [
          {
            role: 'user',
            content: `Request:\n${message}\n\nAvailable tools:\n${catalog}\n\nReturn the JSON array of relevant tool names.`,
          },
        ],
      });
      text = response.text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Tool routing failed, sending unfiltered toolset: ${detail}`);
      return null;
    }

    const names = this.parseNames(text);
    if (!names) {
      this.logger.warn('Tool router returned an unparseable answer; sending unfiltered toolset');
      return null;
    }
    return new Set(names);
  }

  /**
   * The same idea as {@link selectRelevant}, one level up: which connected apps
   * to attach at all.
   *
   * On the server-side MCP path we never see individual tool schemas — the
   * provider fetches them itself — so filtering tool by tool is done separately,
   * by {@link selectRelevantActions}. This decides which apps are in play at all.
   *
   * Selection preserves the caller's order, so two messages that pick the same
   * apps render a byte-identical prefix and can share a prompt cache entry.
   *
   * Returns null to mean "send them all", exactly as {@link selectRelevant} does.
   */
  async selectRelevantServers(
    provider: LlmProvider,
    model: string,
    message: string,
    servers: RemoteMcpServer[],
    localTools: ToolSpec[] = [],
  ): Promise<RemoteMcpServer[] | null> {
    if (servers.length <= SERVER_ROUTE_THRESHOLD) return null;

    // An app with several accounts lists each one, so a request about one
    // Shopify store attaches that store and not all thirty of them.
    const routeId = (server: RemoteMcpServer) => server.routeId ?? server.appSlug;
    const catalog = servers
      .map(
        (server) =>
          `- ${routeId(server)} (${this.humanise(server.appSlug)}` +
          `${server.accountLabel ? ` — account: ${server.accountLabel}` : ''})`,
      )
      .join('\n');
    // Names only. They are self-describing (`meta_ads_list_campaigns`,
    // `verify_roas`), and full descriptions would cost more than the decision
    // they inform. Without this the router cannot tell that a request about
    // campaigns or ROAS is already covered, and reflexively attaches whichever
    // connected app looks topically closest — the expensive mistake here.
    const builtIn = localTools.map((tool) => tool.name).join(', ');

    let text: string;
    try {
      const response = await provider.create({
        model,
        system: SERVER_ROUTER_SYSTEM_PROMPT,
        // Deliberately no tools and no servers: attaching the very connectors we
        // are deciding about would cost the tokens this exists to save.
        tools: [],
        mcpServers: [],
        capabilities: { adaptiveThinking: false },
        messages: [
          {
            role: 'user',
            content:
              `Request:\n${message}\n\n` +
              (builtIn ? `Built-in tools (no app needed for these):\n${builtIn}\n\n` : '') +
              `Connected apps:\n${catalog}\n\n` +
              `Return the JSON array of app ids this request needs.`,
          },
        ],
      });
      text = response.text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`App routing failed, attaching every connected app: ${detail}`);
      return null;
    }

    const slugs = this.parseNames(text);
    if (!slugs) {
      this.logger.warn('App router returned an unparseable answer; attaching every connected app');
      return null;
    }

    // Unlike tool routing, an explicitly empty answer is trusted rather than
    // treated as a failure. It is both the most common case and the most
    // valuable one: anything Gaspo answers with local tools alone (most Meta Ads
    // work) needs no connector, and attaching none is the largest saving there
    // is. The prompt asks for `[]` in exactly this case, which is what separates
    // it from a reply we simply could not read.
    if (!slugs.length) {
      this.logger.log(`App router attached none of ${servers.length} connected apps for this run`);
      return [];
    }

    const wanted = new Set(slugs);
    // A bare app id for an app listed account by account means all its accounts.
    const selected = servers.filter(
      (server) => wanted.has(routeId(server)) || wanted.has(server.appSlug),
    );

    // Every name came back hallucinated, so there is no way to tell what was
    // meant. Falling back costs tokens but never capability.
    if (!selected.length) return null;

    this.logger.log(
      `App router kept ${selected.length}/${servers.length} connected apps for this run` +
        ` (${selected.map((server) => server.appSlug).join(', ')})`,
    );
    return selected;
  }

  /** `google_sheets` → `google sheets`, so the model has a plain-English hint. */
  private humanise(slug: string): string {
    return slug.replace(/[_-]+/g, ' ').trim();
  }

  private previewDescription(description: string): string {
    const flat = description.replace(/\s+/g, ' ').trim();
    return flat.length > DESCRIPTION_PREVIEW_CHARS
      ? `${flat.slice(0, DESCRIPTION_PREVIEW_CHARS)}…`
      : flat;
  }

  /**
   * Pull a JSON string array out of the model's reply. Tolerates a stray code
   * fence or surrounding prose by locating the first bracketed array; returns
   * null when nothing array-shaped is found.
   */
  private parseNames(text: string): string[] | null {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      return null;
    }
  }
}
