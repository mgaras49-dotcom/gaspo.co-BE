import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/constants';
import { AppConfig } from '../config/configuration';
import { PERSONALITY_INSTRUCTIONS } from './personality';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GatewayProvider } from './providers/gateway.provider';
import {
  BridgedToolset,
  MAX_BRIDGED_TOOLS,
  McpBridgeService,
} from './providers/mcp-bridge.service';
import { ToolRouterService } from './providers/tool-router.service';
import { AttachedApps, AttachedAppsService } from './providers/attached-apps.service';
import { buildCatalog, ModelDefinition } from './providers/model-catalog';
import { Attachment } from './attachments';
import { describeNow } from './clock';
import { LOAD_APP_TOOLS, LOAD_APP_TOOLS_TOOL, matchAppServers } from './app-loading-tools';
import {
  AttachmentRejectedError,
  LlmProvider,
  McpConnectionError,
  ProviderMessage,
  ProviderResponse,
  RemoteMcpServer,
  ToolCall,
  ToolResult,
  ToolSpec,
} from './providers/provider.interface';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CreditEventType } from '../common/enums';
import type { ExportDataset, Space } from '../database/entities';
import {
  ConnectedIntegrationView,
  IntegrationsService,
} from '../integrations/integrations.service';
import { MetaAdsService } from '../integrations/meta-ads.service';
import { WorkspaceMemoryService } from '../memory/workspace-memory.service';
import { PipedreamAccountTarget, PipedreamService } from '../integrations/pipedream.service';
import { RoasService } from '../integrations/roas.service';
import { XeroReportName, XeroService } from '../integrations/xero.service';
import { ExportsService } from '../exports/exports.service';
import { RulesService } from '../rules/rules.service';
import { SpacesService } from '../spaces/spaces.service';
import { TasksService } from '../tasks/tasks.service';
import { validationReasons } from '../spaces/spec/validate-spec';
import { CREDITS_PER_DOLLAR, UsageService } from '../usage/usage.service';
import { UsersService } from '../users/users.service';
import { GeneratedFilesService, safeFileName } from '../files/generated-files.service';
import {
  IMAGE_ASPECT_RATIOS,
  ImageAspectRatio,
  ImageGenerationService,
} from '../files/image-generation.service';
import { renderPdf } from '../files/pdf-render';
import {
  META_ADS_CREATE_AD,
  META_ADS_CREATE_AD_CREATIVE,
  META_ADS_CREATE_AD_SET,
  META_ADS_CREATE_CAMPAIGN,
  META_ADS_DELETE_AD,
  META_ADS_DELETE_AD_SET,
  META_ADS_DELETE_CAMPAIGN,
  META_ADS_DUPLICATE_AD,
  META_ADS_DUPLICATE_AD_SET,
  META_ADS_DUPLICATE_CAMPAIGN,
  META_ADS_GET_INSIGHTS,
  META_ADS_LIST_AD_ACCOUNTS,
  META_ADS_LIST_AD_SETS,
  META_ADS_LIST_ADS,
  META_ADS_LIST_CAMPAIGNS,
  META_ADS_LIST_PAGES,
  META_ADS_SEARCH_INTERESTS,
  META_ADS_TOOL_NAMES,
  META_ADS_TOOLS,
  META_ADS_UPDATE_AD,
  META_ADS_UPDATE_AD_SET,
  META_ADS_UPDATE_CAMPAIGN,
  META_ADS_WRITE_TOOL_NAMES,
} from './meta-ads-tools';
import {
  MEMORY_FORGET_FACT,
  MEMORY_REMEMBER_FACT,
  MEMORY_TOOL_NAMES,
  MEMORY_TOOLS,
} from './memory-tools';
import { ROAS_TOOL_NAMES, ROAS_TOOLS, VERIFY_ROAS } from './roas-tools';
import {
  CREATE_AD_RULE,
  DELETE_AD_RULE,
  RULE_TOOL_NAMES,
  RULE_TOOLS,
  SET_AD_RULE_ACTIVE,
} from './rule-tools';
import {
  CREATE_SCHEDULED_EXPORT,
  DELETE_SCHEDULED_EXPORT,
  EXPORT_TO_SHEET,
  RUN_SCHEDULED_EXPORT_NOW,
  SET_SCHEDULED_EXPORT_ACTIVE,
  SHEETS_TOOL_NAMES,
  SHEETS_TOOLS,
} from './sheets-tools';
import { SPACE_TOOLS } from './space-tools';
import {
  CREATE_SCHEDULED_TASK,
  DELETE_SCHEDULED_TASK,
  LIST_SCHEDULED_TASKS,
  TASK_TOOL_NAMES,
  TASK_TOOLS,
} from './task-tools';
import { GET_WORKSPACE_STATS, WORKSPACE_TOOLS } from './workspace-tools';
import { XERO_GET_REPORT, XERO_TOOLS } from './xero-tools';
import { CREATE_PDF, CREATE_PDF_TOOL, FILE_TOOL_NAMES, GENERATE_IMAGE_TOOL } from './file-tools';

/**
 * Balance under which replies carry a top-up nudge: $10 of credits.
 *
 * Derived from {@link CREDITS_PER_DOLLAR} rather than written as a count. The
 * literal 1000 here survived the move from 100 to 400 credits per dollar, so
 * the nudge fired at $2.50 and reported a balance four times its real size.
 */
const LOW_BALANCE_CREDITS = 10 * CREDITS_PER_DOLLAR;

/** Pipedream's slug for the Xero Accounting app. */
const XERO_APP_SLUG = 'xero_accounting_api';

/**
 * How long one low-balance nudge suppresses the next in the same conversation.
 *
 * The nudge used to ride on every reply once under the threshold, so a thread
 * that crossed it wore a top-up banner — and, in Slack, an unfurled link card —
 * on every turn including one-line acknowledgements. The balance is falling the
 * whole time, so the nudge is loudest exactly when the user is most likely to be
 * mid-task. Once a conversation has been told, it has been told.
 */
const LOW_BALANCE_NUDGE_TTL_SECONDS = 6 * 60 * 60;

/** Redis key prefix for the per-conversation low-balance nudge throttle. */
const LOW_BALANCE_PREFIX = 'ai:lowbalance:';

/**
 * Retries allowed after a reply is cut off mid tool call. One, because a retry
 * of a whole page can cost as much as the first attempt, and a model that ran
 * out of room twice needs the request made smaller, not a third try.
 */
const MAX_TRUNCATED_RETRIES = 1;

/** Said when a reply keeps outgrowing the output limit and the run gives up on it. */
const TRUNCATED_ANSWER =
  'That was too long for me to write in one reply, so I stopped rather than publish it cut off. ' +
  'Ask for a shorter version, or for it in parts and I will add each part to the page.';

/** What each Spaces tool was doing, for the error result when it fails. */
const SPACE_TOOL_ACTIONS: Record<string, string> = {
  create_space: 'build the Space',
  update_space: 'update the Space',
  add_space_records: 'add rows to the Space',
  create_page: 'build the page',
  update_page: 'change the page',
  get_page: 'read the page',
};

/**
 * Local (custom) tools AiService executes itself: building/updating Spaces and
 * reading workspace facts. Sent on every run alongside any connected-app MCP
 * toolsets, and kept as the sole tools when the MCP connector is dropped.
 */
const LOCAL_TOOLS: ToolSpec[] = [
  ...SPACE_TOOLS,
  ...WORKSPACE_TOOLS,
  ...MEMORY_TOOLS,
  ...TASK_TOOLS,
  CREATE_PDF_TOOL,
];

/**
 * Actions sent whenever their app is, because nearly every other action of the
 * app needs what they return and their own descriptions don't say so. Google
 * Ads' list of reachable accounts is described only as "options for the Account
 * ID field", so the router never picked it: asked to edit The Business
 * Builders' account, Gaspo said it had no way to find it and asked Matthew for
 * the customer ID.
 */
const ALWAYS_ATTACHED_ACTIONS: Record<string, string[]> = {
  google_ads: ['google_ads-list-account-id-options'],
};

/** A routed action list plus the app's always-attached actions it actually has. */
export function withAlwaysAttached(
  appSlug: string,
  chosen: string[],
  actions: Array<{ name: string }>,
): string[] {
  const available = new Set(actions.map((action) => action.name));
  const always = (ALWAYS_ATTACHED_ACTIONS[appSlug] ?? []).filter((name) => available.has(name));
  return [...new Set([...chosen, ...always])];
}

const SYSTEM_PROMPT = `You are Gaspo, an AI assistant for a workspace. You can take actions across the user's connected apps using the available tools. Prefer acting over describing: when a request maps to a tool, use it. When you lack a connected app needed for a request, say so plainly and name the app to connect. Shopify is the one app that cannot connect in one click: Shopify only admits outside tools through a custom app the store owner creates. If asked how to connect it, walk them through it — in the Shopify Dev Dashboard create an app, paste in the redirect URL Gaspo's connect screen shows, choose what Gaspo may read (orders, products, customers) and install the app on the store; then on Gaspo's Integrations page choose "Shopify" and enter the shop ID (the "acme-co" in acme-co.myshopify.com) plus the app's Client ID and Client Secret. Before any action that creates, edits, deletes, or starts spending on a connected app — especially Meta Ads campaigns (creating, activating, changing budgets, or deleting) — state exactly what you will do and get the user's explicit confirmation first; never perform such actions speculatively.

You can also build web apps for the workspace, each hosted at its own link with passwordless (magic-link) login, and there are two kinds. For something people read and use — a plan or gameplan, strategy, report, calculator, or a dashboard that presents analysis — build a page with create_page: you write the whole page as HTML, designed to the standard of a polished Claude artifact. For a tool where people keep entering and tracking records over time — a time logger, lead tracker, or content calendar — build an app with create_space, described as entities (data types with typed fields) and views (forms, tables, dashboards); when it should start with content, such as a checklist's items, put that in as starting rows with its records, and fill an existing app with add_space_records. When someone asks for a plan, gameplan or dashboard, build a page. Never invent or share end-user passwords; logins are always magic links. After building either, give the user its link and tell them how to get in: anyone on this team who is signed in to the Gaspo dashboard opens it signed in straight away, and otherwise they enter the email on their Slack profile and get a sign-in link from you as a Slack DM. Gaspo cannot email sign-in links, so people outside this team's Slack cannot sign in yet — never tell anyone to check their email.

You can also answer questions about this workspace itself — how many members it has and which apps members have connected — with the get_workspace_stats tool. Use it instead of guessing or saying you have no way to know.

You can schedule work to run on its own. When someone asks for something recurring or later — "every morning sort my emails", "each Monday send me last week's numbers", "remind me tomorrow at 3" — set it up with create_scheduled_task: at each run you do the task again with the workspace's connected apps and post the result in Slack. Confirm what will run and when, then create it; never say you have no scheduling. Manage existing ones with list_scheduled_tasks, update_scheduled_task (pause, resume, reschedule) and delete_scheduled_task.

You can make PDF files with create_pdf: reports, strategies, proposals, one-pagers — anything someone wants as a document to download, send or attach. Write the full content, then share the link it returns. To attach one to an email, pass that link as a file URL: in Gmail's send or draft action put the link in "attachments" and the file name (with .pdf) at the same position in "attachmentFilenames" — never "attachmentContent", which attaches text, not the file. Never say you cannot make PDFs or offer a .txt file instead.

You have a durable workspace memory that persists across every conversation. When the user states a lasting fact, preference, target, or standing instruction (e.g. "our target ROAS is 3", "always report in EUR"), save it with remember_fact — silently, without announcing it. Saved facts appear in your context under "Workspace memory"; treat them as current truth. Update a fact by re-saving its key; delete a retracted one with forget_fact. Never save transient, one-off request details.

When the user asks what you can do — overall or about a specific connected app — give a structured, scannable answer rather than a one-liner: confirm which relevant app(s) are connected, name the specific account when a quick read-only tool call can tell you (e.g. list Meta ad accounts to name the account and currency), group the concrete capabilities into a few labelled sections, and finish with 2–3 example prompts the user could send. This capability-overview case is the one exception to the brevity rule below.

Numbers from the user's own business — revenue, profit, spend, balances, counts — must come from a tool result in this conversation. Never state one from memory, an estimate, or arithmetic over data you did not actually retrieve, and never present a reconstruction as the official figure. If the tool that would give the real number fails, say it failed and what you could get instead. Industry benchmarks are fine when labelled as benchmarks.

Connected apps are listed below annotated with whose account each one is: the requester's own private account, or a shared team account labelled with the member who connected it. Ownership is load-bearing. When the user asks for THEIR OWN data ("my email", "my calendar", "my repos") and the only matching app is a shared team account connected by a different member, do not silently read it — say whose account it is and confirm that is what they want first. Never present another member's account or its contents as if it were the user's own. If an app the user names is not in the list, it is not connected for them in this workspace — say so plainly rather than guessing why.

When greeting someone or introducing yourself (e.g. they just say "hi"), ground the intro in what is actually available to this specific person: the connected apps listed below — their own accounts first, then shared team ones — plus building Spaces and answering workspace questions. Do not recite a generic pitch or lead with capabilities whose apps are not connected.

People can attach files to their messages, and the files come with the message: PDFs and images as the files themselves, Word, Excel, PowerPoint, CSV and text files as their extracted text. Read them and work from them; never say you cannot open or see attachments. A bracketed note saying a file could not be opened means that file did not come through — tell the user which one and why in a line, and what would work instead.

Your replies are delivered in Slack, so format for Slack's mrkdwn — not Markdown: use *single asterisks* for bold (never **double**, which Slack shows literally), _underscores_ for italics, and a leading "• " for bullets. Don't use # headings or [text](url) links; write links as <https://example.com|label>.

Be brief and lead with the answer. Put the direct response in the first sentence, then add only the detail the request actually needs. Prefer a few short sentences; use a short bulleted list only when giving steps or options. Don't restate the question, stack on caveats, or list the tools you have unless asked.

When a request is clear, do it, then report what you did — not what you held back or why. Ask a question only when you truly cannot proceed without the answer, and then ask just one.

Each new message ends with the current date and time for the person asking. Use it for anything time-relative ("today", "last week", "what time is it") and never say you don't know the date or time.`;

/**
 * Said on runs that can reach the web: Anthropic's server-side search and fetch
 * tools ride along with Anthropic models only, so this is added per run rather
 * than baked into SYSTEM_PROMPT.
 */
const WEB_ACCESS_PROMPT =
  'You can search the web and read web pages with the web_search and web_fetch tools. Use them ' +
  'for anything current or public — research, competitors, prices, news, benchmarks, or pulling ' +
  'facts and data out of a page someone links (web_fetch reads a URL from the conversation or ' +
  'from search results). Say where facts came from and link the sources. Never say you lack web ' +
  'access or cannot browse. You cannot log in to sites or run a browser, so for pages behind a ' +
  'login or built entirely by scripts, say that plainly and use what is publicly readable.';

/** Said on runs that can make images, i.e. when an image provider is configured. */
const IMAGE_PROMPT =
  'You can create images with generate_image — ad creatives, product shots, social posts, ' +
  'thumbnails, illustrations — and edit or restyle pictures the user attached (set ' +
  'use_attached_images). Never say you cannot make images. The image appears under your reply ' +
  'in Slack by itself, so just say what you made in a line; for several variations, call the ' +
  'tool once per image.';

/**
 * What a local tool executor returns. Keeps the wire shape the executors were
 * written against so the provider refactor did not have to touch forty return
 * sites; {@link AiService.run} converts it to a neutral {@link ToolResult} once.
 */
interface LocalToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** A prior turn replayed into a run, with any files it carried already fetched. */
export interface RunTurn {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}

/** A tool the model invoked during a run, for surfacing what Gaspo did. */
export interface AiAction {
  app: string;
  tool: string;
  isError: boolean;
}

/** A file Gaspo made during a run (PDF, image), surfaced so the chat can show it. */
export interface AiFile {
  name: string;
  mimetype: string;
  url: string;
}

/** A Space created during a run, surfaced so the chat can link to it. */
export interface AiSpace {
  slug: string;
  name: string;
  url: string;
}

/**
 * A write action the model wants to take that is gated behind explicit user
 * approval. In interactive (Slack button) mode the run stops when one is
 * proposed, returns it here, and the surface renders Approve/Cancel buttons —
 * the action is executed later via {@link AiService.executeMetaAdsAction}.
 */
export interface AiPendingAction {
  app: string;
  tool: string;
  /** Human label for the action, e.g. "Update campaign". */
  label: string;
  input: Record<string, unknown>;
}

export interface AiRunResult {
  answer: string;
  /** App slugs whose tools were made available for this run. */
  connectedApps: string[];
  actions: AiAction[];
  /** Spaces Gaspo built during this run. */
  spaces: AiSpace[];
  /** Files Gaspo made during this run, e.g. images to show under the reply. */
  files: AiFile[];
  /** A write awaiting the user's button approval, when in interactive mode. */
  pendingAction: AiPendingAction | null;
}

/** How a run gates write actions: soft `confirmed` flag vs. out-of-band buttons. */
export type ConfirmMode = 'inline' | 'buttons';

/** Readable labels for the gated Meta Ads write tools, shown on the approval card. */
const META_WRITE_LABELS: Record<string, string> = {
  [META_ADS_CREATE_CAMPAIGN]: 'Create campaign',
  [META_ADS_UPDATE_CAMPAIGN]: 'Update campaign',
  [META_ADS_DELETE_CAMPAIGN]: 'Delete campaign',
  [META_ADS_DUPLICATE_CAMPAIGN]: 'Duplicate campaign',
  [META_ADS_CREATE_AD_SET]: 'Create ad set',
  [META_ADS_UPDATE_AD_SET]: 'Update ad set',
  [META_ADS_DELETE_AD_SET]: 'Delete ad set',
  [META_ADS_DUPLICATE_AD_SET]: 'Duplicate ad set',
  [META_ADS_CREATE_AD_CREATIVE]: 'Create ad creative',
  [META_ADS_CREATE_AD]: 'Create ad',
  [META_ADS_UPDATE_AD]: 'Update ad',
  [META_ADS_DELETE_AD]: 'Delete ad',
  [META_ADS_DUPLICATE_AD]: 'Duplicate ad',
};

/**
 * Orchestrates Gaspo's model calls across every supported provider.
 *
 * Connected integrations reach the model one of two ways, depending on which
 * provider serves the chosen model: Anthropic is handed the Pipedream servers
 * directly and runs those tools itself, while every other provider gets them as
 * ordinary function tools resolved by {@link McpBridgeService}. Either way this
 * service owns the loop, executes the local tools, and audits what ran.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly integrationsService: IntegrationsService,
    private readonly pipedream: PipedreamService,
    private readonly metaAds: MetaAdsService,
    private readonly spacesService: SpacesService,
    private readonly tasksService: TasksService,
    private readonly usageService: UsageService,
    private readonly usersService: UsersService,
    private readonly workspaceMemory: WorkspaceMemoryService,
    private readonly roasService: RoasService,
    private readonly xeroService: XeroService,
    private readonly rulesService: RulesService,
    private readonly exportsService: ExportsService,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly gatewayProvider: GatewayProvider,
    private readonly mcpBridge: McpBridgeService,
    private readonly toolRouter: ToolRouterService,
    private readonly attachedApps: AttachedAppsService,
    private readonly workspacesService: WorkspacesService,
    private readonly generatedFiles: GeneratedFilesService,
    private readonly imageGeneration: ImageGenerationService,
  ) {}

  getStatus(): { module: string; ready: boolean; providers: string[] } {
    const providers = [this.anthropicProvider, this.gatewayProvider].filter((provider) =>
      provider.isConfigured(),
    );
    return {
      module: 'ai',
      ready: providers.length > 0,
      providers: providers.map((provider) => provider.id),
    };
  }

  /** Every model this deployment can actually reach, for the settings picker. */
  listModels(): Array<ModelDefinition & { available: boolean }> {
    return this.catalog().map((model) => ({
      ...model,
      available: model.supportsTools && this.providerFor(model).isConfigured(),
    }));
  }

  private catalog(): ModelDefinition[] {
    return buildCatalog(this.configService.get('ai', { infer: true }).gatewayModels);
  }

  private providerFor(model: ModelDefinition): LlmProvider {
    return model.provider === 'anthropic' ? this.anthropicProvider : this.gatewayProvider;
  }

  /**
   * Resolve a model id to its catalog entry, falling back to the configured
   * default when a workspace points at a model that has since been removed.
   */
  private resolveModel(modelId: string): ModelDefinition | null {
    const catalog = this.catalog();
    return catalog.find((model) => model.id === modelId) ?? null;
  }

  /**
   * Decide which connected apps this run attaches, and which of their actions.
   *
   * Two narrowings, and one thing that overrides the first. An app attached
   * earlier in the conversation stays attached: re-deciding per message made
   * apps blink in and out mid-thread — a follow-up question answered from the
   * transcript instead of live data — and re-paid the cache write each time,
   * which is 1.25x the input rate against 0.1x to read what is already there.
   *
   * Which of its actions ride along is decided every turn, though. Freezing that
   * too meant a thread's action set was whatever its opening message needed:
   * "check my google ads" attached the readers, and "target the US" three turns
   * later still saw only readers, so the model reported that the connection
   * could not write — an app limit it had inferred from its own toolset. The
   * union is append-only, so re-routing can only add.
   */
  private async attachServers(
    provider: LlmProvider,
    modelId: string,
    prompt: string,
    servers: RemoteMcpServer[],
    localTools: ToolSpec[],
    workspaceId: string,
    conversationId: string | null,
    branchConversationId: string | null,
  ): Promise<RemoteMcpServer[]> {
    const sticky: AttachedApps = conversationId
      ? await this.attachedApps.get(workspaceId, conversationId)
      : {};

    // Keyed by server name rather than app slug: the same app connected under a
    // team and a private account is two servers holding different data, and they
    // must not inherit each other's actions.
    const undecided = servers.filter((server) => !(server.name in sticky));
    const chosen = new Set(servers.filter((server) => server.name in sticky).map((s) => s.name));
    if (undecided.length) {
      // Route only over what this conversation has not already committed to;
      // when that leaves nothing, the routing round trip is pure cost.
      const relevant = await this.toolRouter.selectRelevantServers(
        provider,
        modelId,
        prompt,
        undecided,
        localTools,
      );
      for (const server of relevant ?? undecided) chosen.add(server.name);
    }
    if (!chosen.size) return [];

    // Accounts of one app share its catalogue, so its actions are routed once
    // however many accounts are attached.
    const routed = new Map<string, Promise<string[] | null>>();
    const routeActions = (appSlug: string): Promise<string[] | null> => {
      let decision = routed.get(appSlug);
      if (!decision) {
        decision = this.appActions(appSlug).then(async (actions) => {
          if (!actions.length) return null;
          const chosen = await this.toolRouter.selectRelevantActions(
            provider,
            modelId,
            prompt,
            actions,
          );
          return chosen ? withAlwaysAttached(appSlug, chosen, actions) : null;
        });
        routed.set(appSlug, decision);
      }
      return decision;
    };

    const attaching: AttachedApps = {};
    const attached = await Promise.all(
      // Preserve the input order so the same set of apps always renders the same
      // bytes, and a settled conversation keeps hitting the cached prefix.
      servers
        .filter((server) => chosen.has(server.name))
        .map(async (server) => {
          // An empty list is the "expose everything" marker: the app is already
          // whole, so there is nothing the router could add and the call is pure
          // cost.
          const remembered = sticky[server.name];
          if (remembered?.length === 0) {
            attaching[server.name] = [];
            return { ...server, enabledTools: undefined };
          }

          const enabled = await routeActions(server.appSlug);

          // Null means "expose the app whole" — the fail-open answer for an app
          // too small to route, an unreachable catalogue, or a router error. For
          // an app this conversation has already narrowed it can only be the
          // failure reading, since a narrow list is proof it routed once. Widening
          // it mid-thread would cost the whole catalogue for a transient error, so
          // keep what the thread has instead.
          if (!enabled && remembered?.length) {
            attaching[server.name] = remembered;
            return { ...server, enabledTools: remembered };
          }

          attaching[server.name] = enabled ?? [];
          return { ...server, enabledTools: enabled ?? undefined };
        }),
    );

    let sending = attached;
    if (conversationId) {
      // Fold this turn into the conversation's record, then send the union — an
      // app attached two turns ago is still expected to work now.
      const merged = await this.attachedApps.merge(workspaceId, conversationId, attaching);
      sending = servers
        .filter((server) => server.name in merged)
        .map((server) => ({
          ...server,
          enabledTools: merged[server.name].length ? merged[server.name] : undefined,
        }));
    }

    // Hand this turn's attachment to the conversation branching off it, so the
    // branch's first message does not have to re-route from scratch — with only
    // a follow-up like "check budget and targeting" to go on, the router would
    // attach nothing and the answer would come from the transcript.
    if (branchConversationId) {
      await this.attachedApps.replace(
        workspaceId,
        branchConversationId,
        Object.fromEntries(sending.map((server) => [server.name, server.enabledTools ?? []])),
      );
    }
    return sending;
  }

  /**
   * An app's actions as routing candidates. Served from the shared catalogue
   * cache, so this is a Redis read rather than a Pipedream round trip; a failure
   * yields none, which the caller reads as "expose the app whole" — worse for
   * the bill, never for the run.
   */
  private async appActions(
    appSlug: string,
  ): Promise<Array<{ name: string; description?: string }>> {
    try {
      const { tools } = await this.integrationsService.listAppTools(appSlug);
      return tools.map((tool) => ({ name: tool.key, description: tool.description }));
    } catch (error) {
      this.logger.warn(
        `Could not list actions for ${appSlug}, attaching it whole: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Answer a load_app_tools call: route the named app's actions against what the
   * model says it needs, add them to the servers for the rest of the run, and
   * remember them for the conversation so the next turn starts with them too.
   * Only ever widens — an action already attached stays attached.
   */
  private async loadAppTools(
    provider: LlmProvider,
    modelId: string,
    input: Record<string, unknown>,
    ctx: {
      servers: RemoteMcpServer[];
      attached: RemoteMcpServer[];
      appNames: Map<string, string>;
      workspaceId: string;
      /** The conversation and the one branching off it, both of which keep what loads. */
      conversationIds: Array<string | null>;
    },
  ): Promise<{ servers: RemoteMcpServer[]; message: string; isError: boolean }> {
    const app = typeof input.app === 'string' ? input.app : '';
    const account = typeof input.account === 'string' ? input.account : undefined;
    const need = typeof input.need === 'string' && input.need.trim() ? input.need : app;
    const matched = matchAppServers(app, ctx.servers, ctx.appNames, account);
    if (!matched.length && account && matchAppServers(app, ctx.servers, ctx.appNames).length) {
      const accounts = matchAppServers(app, ctx.servers, ctx.appNames)
        .map((s) => s.accountLabel)
        .filter(Boolean);
      return {
        servers: ctx.attached,
        isError: true,
        message: `No ${app} account matches "${account}". Its accounts: ${accounts.join(', ')}.`,
      };
    }
    if (!matched.length) {
      const connected = [
        ...new Set(ctx.servers.map((s) => ctx.appNames.get(s.appSlug) ?? s.appSlug)),
      ];
      return {
        servers: ctx.attached,
        isError: true,
        message:
          `No connected app matches "${app}". Connected apps: ${connected.join(', ') || 'none'}. ` +
          'If the one you need is not among them, tell the user to connect it.',
      };
    }

    let servers = [...ctx.attached];
    const remembered: AttachedApps = {};
    const loaded: string[] = [];
    // Accounts of one app share its catalogue: route its actions once.
    const routed = new Map<string, Promise<string[] | null>>();
    for (const server of matched) {
      const label = [ctx.appNames.get(server.appSlug) ?? server.appSlug, server.accountLabel]
        .filter(Boolean)
        .join(' — ');
      const current = servers.find((s) => s.name === server.name);
      if (current && !current.enabledTools) {
        loaded.push(`${label}: every action is already available`);
        continue;
      }
      let decision = routed.get(server.appSlug);
      if (!decision) {
        const appSlug = server.appSlug;
        decision = this.appActions(appSlug).then(async (actions) => {
          if (!actions.length) return null;
          const chosen = await this.toolRouter.selectRelevantActions(
            provider,
            modelId,
            need,
            actions,
          );
          return chosen ? withAlwaysAttached(appSlug, chosen, actions) : null;
        });
        routed.set(appSlug, decision);
      }
      const chosen = await decision;
      // Null is the router's "could not narrow" — the app goes whole, as on attach.
      const enabledTools = chosen
        ? [...new Set([...(current?.enabledTools ?? []), ...chosen])]
        : undefined;
      const widened = { ...server, enabledTools };
      servers = current
        ? servers.map((s) => (s.name === server.name ? widened : s))
        : [...servers, widened];
      remembered[server.name] = enabledTools ?? [];
      loaded.push(`${label}: ${enabledTools ? enabledTools.join(', ') : 'every action'}`);
    }
    if (Object.keys(remembered).length) {
      for (const conversationId of ctx.conversationIds) {
        if (conversationId)
          await this.attachedApps.merge(ctx.workspaceId, conversationId, remembered);
      }
    }
    return {
      servers,
      isError: false,
      message: `Loaded. You can now call these directly — ${loaded.join('; ')}.`,
    };
  }

  /**
   * Run a single prompt for a workspace, exposing its connected apps as tools,
   * and return Gaspo's answer plus the actions it took.
   *
   * `options.model` overrides the workspace default (used by scheduled tasks
   * that pin a model); `options.taskId`/`options.sourceName` attribute the
   * metered usage to the originating scheduled task.
   */
  async run(
    workspaceId: string,
    userId: string | null,
    prompt: string,
    options: {
      model?: string | null;
      taskId?: string | null;
      sourceName?: string;
      /** Lazily resolves the workspace's total member count (e.g. Slack roster),
       * used by the workspace-stats tool. Optional — omitted off-Slack. */
      fetchMemberCount?: () => Promise<number | null>;
      /** How Meta Ads writes are confirmed: 'buttons' defers them to an
       * out-of-band approval (Slack), 'inline' (default) uses the soft flag. */
      confirmVia?: ConfirmMode;
      /** Prior turns of this conversation (oldest first), replayed ahead of the
       * prompt so the model has thread continuity. Omitted for fresh runs. */
      history?: RunTurn[];
      /** Files attached to this prompt, sent alongside it. */
      attachments?: Attachment[];
      /** Stable id for the conversation this run belongs to (a Slack thread).
       * Keeps connected apps attached across its turns instead of re-routing per
       * message; omitted for one-off runs, which route from scratch. */
      conversationId?: string | null;
      /** A conversation that will branch off this turn — the thread a Slack DM
       * reply opens under it. Seeded with what this run attached, so the branch
       * continues where its parent left off. */
      branchConversationId?: string | null;
      /** The Slack channel (or DM) this request came from, where a task created
       * during the run posts its results unless told otherwise. */
      slackChannelId?: string | null;
      /** Lazily resolves the requester's IANA timezone (their Slack profile), so
       * "every morning at 8" means their 8am. Optional — omitted off-Slack. */
      fetchRequesterTimezone?: () => Promise<string | null>;
      /** A known IANA timezone for the run (a scheduled task's), used for the
       * date and time the model is told when there is no Slack requester. */
      timezone?: string | null;
    } = {},
  ): Promise<AiRunResult> {
    const confirmVia: ConfirmMode = options.confirmVia ?? 'inline';
    // One lookup per run, shared by the clock below and any task created in it.
    let timezoneLookup: Promise<string | null> | undefined;
    const resolveTimezone = (): Promise<string | null> =>
      (timezoneLookup ??= options.timezone
        ? Promise.resolve(options.timezone)
        : (options.fetchRequesterTimezone?.().catch(() => null) ?? Promise.resolve(null)));
    const ai = this.configService.get('ai', { infer: true });
    const appUrl = this.configService.get('app', { infer: true }).frontendUrl;
    const billingUrl = `${appUrl}/dashboard/billing`;
    const settingsUrl = `${appUrl}/dashboard/settings/general`;

    // A caller-pinned model (a scheduled task) wins over the workspace default,
    // which in turn wins over the deployment-wide fallback.
    const workspace = await this.workspacesService.findByIdOrFail(workspaceId);
    const modelId = options.model ?? workspace.defaultModel ?? ai.model;

    // Credit gate: an exhausted workspace gets a pointer to the top-up page
    // instead of a model call. Checked before anything is spent.
    const creditBalance = await this.usageService.getBalance(workspaceId);
    if (creditBalance.balance <= 0) {
      return {
        answer:
          `This workspace is out of credits, so I can't run that request. ` +
          `Top up at <${billingUrl}|${billingUrl}> and I'll pick right back up.`,
        connectedApps: [],
        actions: [],
        spaces: [],
        files: [],
        pendingAction: null,
      };
    }

    // An unreachable model is a settings problem, not a server fault: say which
    // model and where to change it rather than throwing a 503 into the chat.
    const model = this.resolveModel(modelId);
    if (!model) {
      return this.configurationProblem(
        `I'm set to use "${modelId}", which isn't a model I recognise. Pick another one at ` +
          `<${settingsUrl}|${settingsUrl}>.`,
      );
    }
    const provider = this.providerFor(model);
    if (!provider.isConfigured()) {
      return this.configurationProblem(
        `I'm set to use ${model.name}, but this deployment has no ${model.provider} credentials ` +
          `configured. Pick a different model at <${settingsUrl}|${settingsUrl}>.`,
      );
    }

    // Only the accounts this member may use become tools: every team account
    // plus their own private ones. Pipedream apps live under a per-scope external
    // user (a private account is unreachable from another member's run); Meta
    // connections are their own OAuth grants, resolved separately below.
    const connected = (
      await this.integrationsService.findVisibleForUser(workspaceId, userId)
    ).filter((c) => c.isActive);
    const pipedreamConnected = connected.filter((c) => c.provider === 'pipedream');
    // One server per app, or per account when a scope holds several accounts of
    // one app: unpinned, Pipedream picks the account itself, which sent a
    // question about 33 Shopify stores to whichever one it chose.
    const serversFor = (externalUserId: string, accounts: ConnectedIntegrationView[]) => {
      const bySlug = new Map<string, ConnectedIntegrationView[]>();
      for (const account of accounts) {
        bySlug.set(account.appSlug, [...(bySlug.get(account.appSlug) ?? []), account]);
      }
      const whole: string[] = [];
      const pinned: PipedreamAccountTarget[] = [];
      for (const [appSlug, list] of bySlug) {
        if (list.length < 2 || list.some((account) => !account.externalAccountId)) {
          whole.push(appSlug);
          continue;
        }
        for (const account of list) {
          pinned.push({
            appSlug,
            accountId: account.externalAccountId as string,
            label: account.nickname ?? account.accountName ?? (account.externalAccountId as string),
          });
        }
      }
      return [
        ...(whole.length ? this.pipedream.buildMcpServers(externalUserId, whole) : []),
        ...(pinned.length ? this.pipedream.buildAccountMcpServers(externalUserId, pinned) : []),
      ];
    };
    const pipedreamServers = [
      ...serversFor(
        workspaceId,
        pipedreamConnected.filter((c) => c.accessLevel === 'team'),
      ),
      ...(userId
        ? serversFor(
            PipedreamService.privateExternalUserId(userId),
            pipedreamConnected.filter((c) => c.accessLevel === 'private'),
          )
        : []),
    ];
    // Pipedream shares one access token across its servers.
    const pipedreamToken = pipedreamServers.length ? await this.pipedream.getAccessToken() : null;
    const servers: RemoteMcpServer[] = pipedreamServers.map((server) => ({
      appSlug: server.appSlug,
      name: server.name,
      url: server.url,
      authorizationToken: pipedreamToken ?? undefined,
      ...(server.accountLabel
        ? { accountLabel: server.accountLabel, routeId: server.routeId }
        : {}),
    }));

    // Meta Ads is NOT exposed as an MCP server: Meta's hosted Ads MCP is
    // allowlist-gated and rejects our token, which would 400 the whole request
    // (taking the Pipedream connectors down with it). Instead we serve Meta as
    // native local tools that call the Marketing API with the stored token.
    const hasMeta = connected.some((c) => c.provider === 'meta');
    // Verified ROAS needs both sides: Meta for spend, Stripe for real revenue.
    const hasStripe = pipedreamConnected.some((c) => c.appSlug === 'stripe');
    const hasRoas = hasMeta && hasStripe;
    // Export automation writes through the Sheets API directly, so it needs the
    // workspace's own Google Sheets connection.
    const hasSheets = pipedreamConnected.some((c) => c.appSlug === 'google_sheets');
    // Xero's reports are read through the proxy, not Pipedream's actions.
    const hasXero = pipedreamConnected.some((c) => c.appSlug === XERO_APP_SLUG);
    const localTools: ToolSpec[] = [
      ...LOCAL_TOOLS,
      ...(hasMeta ? META_ADS_TOOLS : []),
      ...(hasRoas ? ROAS_TOOLS : []),
      // The rule engine acts on Meta, so its tools ride along with a Meta account.
      ...(hasMeta ? RULE_TOOLS : []),
      ...(hasSheets ? SHEETS_TOOLS : []),
      ...(hasXero ? XERO_TOOLS : []),
      // Offered only when a provider is configured, so without one the model
      // says it cannot make images instead of calling a tool that always fails.
      ...(this.imageGeneration.isConfigured() ? [GENERATE_IMAGE_TOOL] : []),
      // Server-side MCP is the path that narrows apps to a few actions, so it is
      // the one that needs a way to widen them again mid-run.
      ...(model.supportsRemoteMcp && servers.length ? [LOAD_APP_TOOLS_TOOL] : []),
    ];

    // The apps this run ended up with, filled in once the toolset is resolved
    // below and narrowed again if the connectors turn out to be unreachable.
    let appSlugs: string[] = [];

    // Name the connected apps in the system prompt so the model can accurately
    // confirm what's usable right now (e.g. for a "what can you do?" answer)
    // instead of guessing. Each app is annotated with whose account it is —
    // the requester's own private account vs a shared team account and who
    // connected it — so "check my gmail" against a teammate's shared account
    // gets attributed instead of being presented as the requester's own inbox.
    // Meta stores no appName, so label it explicitly.
    const describeConnection = (connection: ConnectedIntegrationView): string => {
      const label =
        connection.provider === 'meta' ? 'Meta Ads' : connection.appName || connection.appSlug;
      const account = connection.nickname ?? connection.accountName;
      const ownership =
        connection.accessLevel === 'private'
          ? "the requester's own private account"
          : userId && connection.userId === userId
            ? 'shared team account, connected by the requester'
            : `shared team account${connection.userName ? `, connected by ${connection.userName}` : ''}`;
      return `${label} (${ownership}${account ? `; account: ${account}` : ''})`;
    };
    const connectionDescriptions = [...new Set(connected.map(describeConnection))];
    let system = connectionDescriptions.length
      ? `${SYSTEM_PROMPT}\n\nApps connected and usable right now:\n${connectionDescriptions
          .map((line) => `• ${line}`)
          .join('\n')}`
      : `${SYSTEM_PROMPT}\n\nNo apps are connected in this workspace yet.`;
    const pinnedServers = servers.filter((server) => server.accountLabel);
    if (pinnedServers.length) {
      const appName = (slug: string) => connected.find((c) => c.appSlug === slug)?.appName ?? slug;
      system +=
        '\n\nSome apps have several accounts connected, and each account has its own set of tools. Every ' +
        "tool's name starts with its account's connection name, so use the tools of the account the user " +
        "means. If they don't say which and it matters, ask; if they mean all of them, go through each.\n" +
        pinnedServers
          .map((server) => `• ${server.name}: ${appName(server.appSlug)} — ${server.accountLabel}`)
          .join('\n');
    }
    if (localTools.some((tool) => tool.name === LOAD_APP_TOOLS)) {
      system +=
        "\n\nEach connected app comes with only the actions this message seemed to need. If you need one you don't " +
        'have, or an app above has no tools here, call load_app_tools and carry on. Never say a connected app ' +
        'cannot do something before calling it.';
    }
    // Tell the model who it is serving, so the ownership annotations above have
    // a referent. An unmatched Slack sender is flagged explicitly: their private
    // connections are unreachable, and the model must not paper over that by
    // treating shared team accounts as theirs.
    const requester = userId ? await this.usersService.findById(userId) : null;
    if (requester) {
      system += `\n\nThe requester is ${requester.name}, a member of this workspace.`;
    } else if (options.sourceName === 'slack') {
      system +=
        `\n\nThe requester could not be matched to a workspace member account, so only shared ` +
        `team apps are listed — anything they connected privately is not reachable in this run. ` +
        `If they ask for personal data or for an app that is missing, tell them to sign in with ` +
        `Slack at <${appUrl}|${appUrl}> so their account and private connections link up.`;
    }
    // Gaspo's own plans and credits live on the dashboard, not behind a tool, so
    // without the link "I want to pay for Gaspo" got "not something I can set up".
    system +=
      `\n\nGaspo's own plans, credits and billing are on the dashboard at <${billingUrl}|${billingUrl}>. ` +
      'When someone wants to subscribe, pay for Gaspo, top up or check their credits, give them that link.';
    // Durable workspace facts ride along on every run so the model has standing
    // context (targets, preferences) without a tool call. Best-effort: null on
    // a read failure or an empty memory.
    const memoryBlock = await this.workspaceMemory.buildPromptBlock(workspaceId);
    if (memoryBlock) system += `\n\n${memoryBlock}`;
    // The workspace's own settings come last so they override the defaults above
    // where they conflict — that is what an admin setting them expects.
    const toneInstruction = PERSONALITY_INSTRUCTIONS[workspace.personalityTone ?? ''];
    if (toneInstruction) system += `\n\n${toneInstruction}`;
    if (workspace.workspaceInstructions?.trim()) {
      system +=
        `\n\nWorkspace instructions (set by an admin of this workspace — follow them unless ` +
        `they conflict with the confirmation rules above):\n${workspace.workspaceInstructions.trim()}`;
    }
    // Web search and fetch are Anthropic server tools, so only its models get them.
    const webAccess = model.provider === 'anthropic';
    if (webAccess) system += `\n\n${WEB_ACCESS_PROMPT}`;
    if (this.imageGeneration.isConfigured()) system += `\n\n${IMAGE_PROMPT}`;
    // Verified-ROAS guidance rides along only when the tools do.
    if (hasRoas) {
      system +=
        '\n\nBoth Meta Ads and Stripe are connected, so you can VERIFY ad performance instead of ' +
        "trusting Meta's self-reported conversions: use verify_roas to pair Meta spend with actual " +
        'Stripe revenue for any profitability question ("what\'s our real ROAS?"). Prefer it over ' +
        'Meta-only numbers, present both when they differ, and always mention its caveats (blended ' +
        'revenue, currency notes). Past results are queryable with list_roas_snapshots.';
    }
    // Sheets guidance rides along only when the export tools do. It leads with
    // the connected app's own actions on purpose: leading with the export tools
    // read as "Sheets means exports", and the model refused to list or read a
    // spreadsheet on the grounds that it only had export tools — while holding
    // the whole Google Sheets action catalogue.
    if (hasSheets) {
      system +=
        '\n\nGoogle Sheets is connected TWO ways and you have both. First, the Google Sheets app ' +
        'itself, whose ordinary actions do anything a person could do in Sheets — list the ' +
        'spreadsheets in the account, read a sheet, search, add or update arbitrary rows. Use ' +
        'those for any normal spreadsheet request; never tell the user you cannot list or read ' +
        'their spreadsheets, and never send them to connect Google Drive for something the ' +
        'Sheets app already covers. Second, on top of that, two reporting tools that write ' +
        "Gaspo's own datasets — verified ROAS runs, Meta campaign performance, and rule-engine " +
        'actions: export_to_sheet for a one-off report and create_scheduled_export for a ' +
        'recurring one ("every Monday put last week\'s numbers in the sheet"), which runs on its ' +
        'own and appends only new rows so the sheet builds a history. Those two are ONLY for ' +
        "those three datasets; everything else goes through the app's own actions. Reuse a " +
        'remembered sheet (e.g. an "export_sheet_id" fact) instead of creating new spreadsheets ' +
        'each time, remember the sheet id the first time one is created, and always give the ' +
        'user the spreadsheet link.';
    }
    if (hasXero) {
      system +=
        '\n\nXero is connected. For profit, margin, revenue, expenses or financial position, ' +
        "always use xero_get_report — it returns Xero's own Profit & Loss, Balance Sheet and " +
        "other reports in the organisation's base currency. Never total invoices or bills to " +
        'answer those: invoices come in mixed currencies and miss journals, credit notes and ' +
        'expenses. Name the Xero organisation and currency the figures are for.';
    }
    // Rule-engine guidance rides along with a Meta connection.
    if (hasMeta) {
      system +=
        '\n\nYou can set up automated ad rules with create_ad_rule: scheduled checks that alert, ' +
        'pause, or scale campaigns/ad sets when a metric (CPA, ROAS, spend…) breaches a threshold — ' +
        'e.g. overnight pausing of losing campaigns or morning budget scaling of winners. ' +
        'Pause/scale rules act autonomously within guardrails and report to Slack afterwards, so ' +
        'ALWAYS describe the full rule (metric, threshold, window, action, schedule, guardrails) and ' +
        'get explicit confirmation before creating one. Use remembered targets (e.g. target_roas) as ' +
        'sensible defaults. Manage rules with list_ad_rules, set_ad_rule_active, and delete_ad_rule. ' +
        'Separately, an automatic hourly monitor alerts on CPA spikes, ROAS drops, and spend spikes ' +
        '(vs the trailing 7 days) once the workspace has an "alerts_channel" fact — if the user asks ' +
        'for automatic alerts, ask which channel and remember_fact its channel ID as alerts_channel.';
    }
    // In button mode the platform gates Meta Ads writes with an out-of-band
    // approval, so the model must actually CALL the write tool (not ask in
    // prose) — calling it does not execute it; it triggers the approval buttons.
    if (confirmVia === 'buttons' && hasMeta) {
      system +=
        '\n\nFor Meta Ads write actions (create/update/delete a campaign, ad set, creative, or ' +
        'ad; changing budgets or status), do NOT ask for confirmation in your text. Instead call ' +
        'the appropriate tool directly with your best parameters. Calling it does not execute ' +
        'anything — the platform automatically pauses and shows the user Approve/Cancel buttons, ' +
        'and only runs the action if they approve. First gather any ids you need with read tools, ' +
        'then call the one write tool and, in one short line, state exactly what you are about to do.';
    }

    // How connected apps reach the model depends on the provider. Anthropic runs
    // the MCP servers itself, so it gets them as servers and only our local tools
    // as tools. Every other provider gets them bridged into ordinary tools.
    //
    // Both are `let`: a dead MCP server makes Anthropic reject the whole request,
    // so we drop the connectors and retry with only the local tools.
    let bridged: BridgedToolset | null = model.supportsRemoteMcp
      ? null
      : await this.mcpBridge.buildToolset(servers);
    let mcpServers: RemoteMcpServer[] = model.supportsRemoteMcp ? servers : [];

    // Which apps this run can actually use. Bridging resolves that precisely
    // (an unreachable server drops out); server-side MCP only finds out on use.
    // Read before routing narrows the toolset: routing changes which tools this
    // message is sent, not which apps the workspace has connected.
    const reachableApps = model.supportsRemoteMcp
      ? servers.map((server) => server.appSlug)
      : (bridged?.apps ?? []);

    // Send only the tools this message plausibly needs. Every schema rides on
    // every turn, so a workspace with many connected apps otherwise spends tens
    // of thousands of tokens per call describing tools it will never touch. The
    // router judges from tool names and short descriptions; a null result — too
    // few tools to bother, or any failure — falls back to the app-fair cap, so
    // routing can trim the bill but never break a run.
    if (bridged) {
      const relevant = await this.toolRouter.selectRelevant(
        provider,
        model.id,
        prompt,
        bridged.tools,
      );
      bridged = bridged.narrowTo(relevant ?? bridged.tools, MAX_BRIDGED_TOOLS);
    } else if (mcpServers.length) {
      // Server-side MCP hides the individual schemas from us, but it does let us
      // name which of an app's actions to expose — and the provider then fetches
      // only those. Narrowing therefore happens twice: which apps are in play,
      // then which of their actions ride along. The second is where the money is:
      // Google Ads whole is ~108K prompt tokens, two of its actions ~1K.
      mcpServers = await this.attachServers(
        provider,
        model.id,
        prompt,
        mcpServers,
        // Meta Ads, ROAS and memory are served locally, and the router has to be
        // told so: otherwise a question about campaigns pulls in whichever ad
        // connector looks related and pays for its schemas unused.
        localTools,
        workspaceId,
        options.conversationId ?? null,
        options.branchConversationId ?? null,
      );
    }
    let tools: ToolSpec[] = [...localTools, ...(bridged?.tools ?? [])];
    appSlugs = [...new Set([...reachableApps, ...(hasMeta ? ['meta_ads'] : [])])];
    // Whether connected apps were available for this run; on an MCP failure the
    // Pipedream toolsets drop but the Meta local tools survive.
    let appsAvailable = reachableApps.length > 0 || hasMeta;

    // Prior turns (thread history) replay ahead of the new prompt, giving the
    // model conversation continuity; only final text turns are stored/replayed,
    // never tool_use blocks, so there are no dangling tool-result pairs.
    // Files ride on the turn they were attached to, so a follow-up about a
    // document shared three messages ago still has the document.
    // The clock rides on the new message, not in the system prompt: a timestamp
    // there would change the cached prefix every minute. It is not stored, so
    // replayed turns never carry a stale time.
    const now = describeNow(new Date(), await resolveTimezone());
    const messages: ProviderMessage[] = [
      ...(options.history ?? []).map((turn) =>
        turn.role === 'assistant'
          ? { role: 'assistant' as const, content: turn.content, toolCalls: [] }
          : { role: 'user' as const, content: turn.content, attachments: turn.attachments },
      ),
      {
        role: 'user' as const,
        content: `${prompt}\n\n[Current date and time for the person asking: ${now}]`,
        attachments: options.attachments,
      },
    ];
    const actions: AiAction[] = [];
    const spaces: AiSpace[] = [];
    const files: AiFile[] = [];
    // Images generated this run, billed per image on top of tokens.
    const imageCost = { usd: 0 };
    // Pictures the image tool can work from: this message's first, then the
    // thread's, newest first.
    const referenceImages = [
      ...(options.attachments ?? []),
      ...[...(options.history ?? [])].reverse().flatMap((turn) => turn.attachments ?? []),
    ].filter((attachment) => attachment.kind === 'image');
    // In button mode, the first Meta write the model proposes is captured here
    // (rather than executed) so the surface can request approval out of band.
    const pending: { current: AiPendingAction | null } = { current: null };
    let answer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    // A run is many provider calls, so cost accumulates like tokens do. Left
    // undefined unless a provider actually reports one, so that "reported zero"
    // stays distinguishable from "reported nothing".
    let costUsd: number | undefined;
    let resolvedModel: string | undefined;
    // Searches are billed per use on top of tokens, so they are counted apart.
    let webSearches = 0;
    // Replies cut off mid tool call so far, capped by MAX_TRUNCATED_RETRIES.
    let truncations = 0;

    // Two reasons to loop: a provider returns `pause` when it hits its own
    // per-turn iteration cap, and any tool call needs answering — in both cases
    // we re-send the accumulated conversation.
    for (let i = 0; i < 6; i += 1) {
      const request = {
        model: model.id,
        system,
        messages,
        tools,
        mcpServers,
        capabilities: { adaptiveThinking: model.supportsAdaptiveThinking ?? false },
        webAccess,
      };
      let response: ProviderResponse;
      try {
        response = await provider.create(request);
      } catch (error) {
        if (error instanceof AttachmentRejectedError) {
          // A file the model will not take fails the whole request. Drop the
          // files once, say why, and let the model answer and explain.
          this.logger.warn(
            `An attached file was rejected; retrying without files: ${error.message}`,
          );
          this.dropAttachments(messages, error.message);
          response = await provider.create(request);
        } else {
          // A single unreachable Pipedream MCP server makes Anthropic 400 the whole
          // request, which would otherwise fail even prompts that need no app. Drop
          // the connectors once and retry so the model can still answer locally.
          if (!mcpServers.length || !(error instanceof McpConnectionError)) throw error;
          this.logger.warn(
            'A connected-app MCP server was unreachable; retrying without connected apps',
          );
          mcpServers = [];
          bridged = null;
          tools = [...localTools];
          appSlugs = hasMeta ? ['meta_ads'] : [];
          appsAvailable = hasMeta;
          response = await provider.create({ ...request, tools, mcpServers });
        }
      }
      inputTokens += response.usage.inputTokens;
      if (response.usage.costUsd !== undefined) {
        costUsd = (costUsd ?? 0) + response.usage.costUsd;
      }
      // A router can pick a different backend per turn; the last one that
      // actually served is the most useful single answer to "what ran?".
      if (response.usage.resolvedModel) resolvedModel = response.usage.resolvedModel;
      outputTokens += response.usage.outputTokens;
      cacheWriteTokens += response.usage.cacheWriteTokens ?? 0;
      cacheReadTokens += response.usage.cacheReadTokens ?? 0;
      webSearches += response.usage.webSearches ?? 0;

      answer += response.text;
      // Tools the provider ran itself are already complete; ours still need executing.
      actions.push(...response.remoteActivity);

      if (response.stopReason === 'tool_use' && response.toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
          raw: response.raw,
        });
        const results: ToolResult[] = [];
        for (const call of response.toolCalls) {
          if (call.name === LOAD_APP_TOOLS) {
            const loaded = await this.loadAppTools(provider, model.id, call.input, {
              servers,
              attached: mcpServers,
              appNames: new Map(connected.map((c) => [c.appSlug, c.appName])),
              workspaceId,
              conversationIds: [
                options.conversationId ?? null,
                options.branchConversationId ?? null,
              ],
            });
            mcpServers = loaded.servers;
            actions.push({ app: 'apps', tool: call.name, isError: loaded.isError });
            results.push({
              id: call.id,
              name: call.name,
              content: loaded.message,
              isError: loaded.isError,
            });
            continue;
          }
          const result = await this.runTool(workspaceId, userId, call, bridged, spaces, {
            confirmVia,
            pending,
            fetchMemberCount: options.fetchMemberCount,
            slackChannelId: options.slackChannelId ?? null,
            fetchRequesterTimezone: resolveTimezone,
            files,
            referenceImages,
            imageCost,
          });
          actions.push({
            app: bridged?.has(call.name) ? bridged.appFor(call.name) : this.localToolApp(call.name),
            tool: call.name,
            isError: result.isError,
          });
          results.push(result);
        }
        messages.push({ role: 'tool', results });
        continue;
      }

      if (response.stopReason === 'truncated' && response.toolCalls.length) {
        // The reply hit the output limit partway through a tool call. It is never
        // run, since a page cut off mid-document would publish broken; the model
        // is told instead, so it can try again with less.
        truncations += 1;
        if (truncations > MAX_TRUNCATED_RETRIES) {
          this.logger.warn('A reply hit the output limit again; giving up on it');
          answer += `${answer.trim() ? '\n\n' : ''}${TRUNCATED_ANSWER}`;
          break;
        }
        messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
          raw: response.raw,
        });
        messages.push({
          role: 'tool',
          results: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            content:
              'Not run: your reply reached the output limit before this call was complete. ' +
              'Try again with less, e.g. a shorter page, or build it and then add to it with edits.',
            isError: true,
          })),
        });
        this.logger.warn('A reply hit the output limit mid tool call; asked the model to retry');
        continue;
      }

      if (response.stopReason === 'pause') {
        messages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: [],
          raw: response.raw,
        });
        continue;
      }

      break;
    }

    await this.recordUsage(workspaceId, userId, model.id, inputTokens, outputTokens, {
      taskId: options.taskId ?? null,
      sourceName: options.sourceName,
      providerCostUsd: costUsd,
      resolvedModel,
      cacheWriteTokens,
      cacheReadTokens,
      webSearches,
      imageCostUsd: imageCost.usd,
    });

    // Low-balance nudge: piggybacks on the answer once the workspace is under
    // $10 of credits, so the user hears about it before the hard stop above —
    // but at most once per conversation per window, so it stays a warning rather
    // than a footer on every reply.
    if (
      answer.trim() &&
      creditBalance.balance < LOW_BALANCE_CREDITS &&
      (await this.shouldNudgeLowBalance(workspaceId, options.conversationId ?? null))
    ) {
      answer +=
        `\n\n_Heads up: this workspace has about $${(creditBalance.balance / CREDITS_PER_DOLLAR).toFixed(2)} ` +
        `of credits left. Top up at <${billingUrl}|${billingUrl}>._`;
    }

    return {
      answer: answer.trim(),
      connectedApps: appsAvailable ? appSlugs : [],
      actions,
      spaces,
      files,
      pendingAction: pending.current,
    };
  }

  /**
   * Whether this run should carry the low-balance nudge, claiming the slot if so.
   *
   * Keyed per conversation, so each thread hears it once and a scheduled task
   * (which has no conversation) is throttled per workspace instead of nudging on
   * every unattended run. SET NX makes the check and the claim one operation, so
   * two turns landing together cannot both take it.
   *
   * Fails open: if Redis is unreachable the nudge shows. A user who sees it twice
   * is mildly annoyed; a user who never sees it hits the hard stop unwarned.
   */
  private async shouldNudgeLowBalance(
    workspaceId: string,
    conversationId: string | null,
  ): Promise<boolean> {
    const key = `${LOW_BALANCE_PREFIX}${workspaceId}:${conversationId ?? 'workspace'}`;
    try {
      const claimed = await this.redis.set(key, '1', 'EX', LOW_BALANCE_NUDGE_TTL_SECONDS, 'NX');
      return claimed === 'OK';
    } catch (error) {
      this.logger.warn(
        `Could not throttle the low-balance nudge: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
  }

  /**
   * Strip every attachment from the transcript in place, leaving a note on each
   * turn that had one so the model can tell the user what went wrong with it.
   * All of them go because the provider's error rarely says which file it was.
   */
  private dropAttachments(messages: ProviderMessage[], reason: string): void {
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message.role !== 'user' || !message.attachments?.length) continue;
      const names = message.attachments.map((attachment) => attachment.name).join(', ');
      messages[i] = {
        role: 'user',
        content:
          `${message.content}\n\n[The attached file(s) ${names} could not be read by the model, ` +
          `so they are not included. The error was: ${reason.slice(0, 300)}]`,
      };
    }
  }

  /**
   * A run that cannot start because of how the workspace is configured. Shaped
   * like a normal answer so the surface renders it as Gaspo speaking, rather
   * than surfacing a server error to the user.
   */
  private configurationProblem(answer: string): AiRunResult {
    this.logger.warn(`Refusing an AI run: ${answer}`);
    return { answer, connectedApps: [], actions: [], spaces: [], files: [], pendingAction: null };
  }

  /**
   * Execute one tool the model called and normalise the result.
   *
   * A bridged connected-app tool goes back out over MCP; everything else is one
   * of our own local tools. Only providers without server-side MCP produce the
   * former — on Anthropic those calls never reach us.
   */
  private async runTool(
    workspaceId: string,
    userId: string | null,
    call: ToolCall,
    bridged: BridgedToolset | null,
    spaces: AiSpace[],
    ctx: {
      confirmVia: ConfirmMode;
      pending: { current: AiPendingAction | null };
      fetchMemberCount?: () => Promise<number | null>;
      slackChannelId: string | null;
      fetchRequesterTimezone?: () => Promise<string | null>;
      files: AiFile[];
      referenceImages: Attachment[];
      imageCost: { usd: number };
    },
  ): Promise<ToolResult> {
    if (bridged?.has(call.name)) {
      const result = await bridged.call(call.name, call.input);
      return { id: call.id, name: call.name, content: result.content, isError: result.isError };
    }
    const result = await this.runLocalTool(
      workspaceId,
      userId,
      call,
      spaces,
      ctx,
      ctx.fetchMemberCount,
    );
    return {
      id: call.id,
      name: call.name,
      content: result.content,
      isError: result.is_error ?? false,
    };
  }

  /**
   * Route a local (custom) tool call to its executor. These run on our side and
   * their results are fed back into the conversation.
   */
  /** The app label a local tool's action is attributed to in the run audit. */
  private localToolApp(toolName: string): string {
    if (META_ADS_TOOL_NAMES.has(toolName)) return 'meta_ads';
    if (toolName === GET_WORKSPACE_STATS) return 'workspace';
    if (MEMORY_TOOL_NAMES.has(toolName)) return 'memory';
    if (ROAS_TOOL_NAMES.has(toolName)) return 'roas';
    if (RULE_TOOL_NAMES.has(toolName)) return 'rules';
    if (SHEETS_TOOL_NAMES.has(toolName)) return 'google_sheets';
    if (TASK_TOOL_NAMES.has(toolName)) return 'tasks';
    if (toolName === XERO_GET_REPORT) return XERO_APP_SLUG;
    if (FILE_TOOL_NAMES.has(toolName)) return 'files';
    return 'spaces';
  }

  private runLocalTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
    spaces: AiSpace[],
    ctx: {
      confirmVia: ConfirmMode;
      pending: { current: AiPendingAction | null };
      slackChannelId: string | null;
      fetchRequesterTimezone?: () => Promise<string | null>;
      files: AiFile[];
      referenceImages: Attachment[];
      imageCost: { usd: number };
    },
    fetchMemberCount?: () => Promise<number | null>,
  ): Promise<LocalToolResult> {
    if (toolUse.name === GET_WORKSPACE_STATS) {
      return this.runWorkspaceStatsTool(workspaceId, toolUse, fetchMemberCount);
    }
    if (META_ADS_TOOL_NAMES.has(toolUse.name)) {
      return this.runMetaAdsTool(workspaceId, userId, toolUse, ctx);
    }
    if (MEMORY_TOOL_NAMES.has(toolUse.name)) {
      return this.runMemoryTool(workspaceId, userId, toolUse);
    }
    if (ROAS_TOOL_NAMES.has(toolUse.name)) {
      return this.runRoasTool(workspaceId, userId, toolUse);
    }
    if (RULE_TOOL_NAMES.has(toolUse.name)) {
      return this.runRuleTool(workspaceId, userId, toolUse);
    }
    if (SHEETS_TOOL_NAMES.has(toolUse.name)) {
      return this.runSheetsTool(workspaceId, userId, toolUse);
    }
    if (TASK_TOOL_NAMES.has(toolUse.name)) {
      return this.runTaskTool(workspaceId, userId, toolUse, ctx);
    }
    if (toolUse.name === XERO_GET_REPORT) {
      return this.runXeroTool(workspaceId, userId, toolUse);
    }
    if (FILE_TOOL_NAMES.has(toolUse.name)) {
      return this.runFileTool(workspaceId, userId, toolUse, ctx);
    }
    return this.runSpaceTool(workspaceId, userId, toolUse, spaces);
  }

  /**
   * Make a file (a PDF from written content, or a generated image), store it,
   * and hand the model its link. Images are also collected on the run so Slack
   * can show them under the reply. A failure goes back as an error result the
   * model can explain, never a failed request.
   */
  private async runFileTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
    ctx: { files: AiFile[]; referenceImages: Attachment[]; imageCost: { usd: number } },
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof input[key] === 'string' && (input[key] as string).trim()
        ? (input[key] as string).trim()
        : undefined;
    const result = (content: string, isError = false): LocalToolResult => ({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    try {
      if (toolUse.name === CREATE_PDF) {
        const title = text('title');
        const content = text('content');
        if (!title || !content) return result('A PDF needs a title and content.', true);
        const bytes = await renderPdf({ title, subtitle: text('subtitle'), body: content });
        const file = await this.generatedFiles.save({
          workspaceId,
          userId,
          name: safeFileName(text('file_name') ?? title, 'pdf'),
          mimetype: 'application/pdf',
          data: bytes,
        });
        ctx.files.push({ name: file.name, mimetype: file.mimetype, url: file.url });
        return result(
          JSON.stringify({
            created: true,
            name: file.name,
            url: file.url,
            sizeKb: Math.round(file.size / 1024),
            note: 'Share this link in your reply. Anyone with the link can download the PDF.',
          }),
        );
      }
      // Remaining file tool: generate_image.
      const prompt = text('prompt');
      if (!prompt) return result('An image needs a prompt.', true);
      const ratio = text('aspect_ratio');
      const aspectRatio: ImageAspectRatio = (IMAGE_ASPECT_RATIOS as readonly string[]).includes(
        ratio ?? '',
      )
        ? (ratio as ImageAspectRatio)
        : '1:1';
      const references =
        input.use_attached_images === true
          ? ctx.referenceImages
              .slice(0, 3)
              .flatMap((image) =>
                image.kind === 'image' ? [{ mediaType: image.mediaType, data: image.data }] : [],
              )
          : [];
      if (input.use_attached_images === true && !references.length) {
        return result(
          'No images are attached in this conversation. Ask the user to attach the picture, or ' +
            'generate from the prompt alone.',
          true,
        );
      }
      const image = await this.imageGeneration.generate({ prompt, aspectRatio, references });
      ctx.imageCost.usd += image.costUsd;
      const extension = image.mimetype.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const file = await this.generatedFiles.save({
        workspaceId,
        userId,
        name: safeFileName(text('file_name') ?? prompt.slice(0, 60), extension),
        mimetype: image.mimetype,
        data: image.bytes,
      });
      ctx.files.push({ name: file.name, mimetype: file.mimetype, url: file.url });
      return result(
        JSON.stringify({
          created: true,
          name: file.name,
          url: file.url,
          note:
            'The image is shown under your reply in Slack automatically — do not paste the link ' +
            'as an image. Mention the link only if they need it elsewhere (an email, an ad).',
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${toolUse.name} failed: ${message}`);
      return result(`Could not ${toolUse.name.replace(/_/g, ' ')}: ${message}`, true);
    }
  }

  /**
   * Pull a Xero report through the Connect proxy. A failure (no reports scope,
   * several organisations, a bad date) goes back to the model as an error it
   * can relay, so it says what went wrong instead of estimating.
   */
  private async runXeroTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof input[key] === 'string' && (input[key] as string).trim()
        ? (input[key] as string).trim()
        : undefined;
    try {
      const credential = await this.integrationsService.getProxyCredential(
        workspaceId,
        userId,
        XERO_APP_SLUG,
      );
      if (!credential) throw new Error('No Xero account is connected for this member');
      const content = await this.xeroService.getReport(
        credential,
        String(input.report) as XeroReportName,
        {
          fromDate: text('from_date'),
          toDate: text('to_date'),
          date: text('date'),
          periods: typeof input.periods === 'number' ? input.periods : undefined,
          timeframe: text('timeframe') as 'MONTH' | 'QUARTER' | 'YEAR' | undefined,
          organisation: text('organisation'),
        },
      );
      return { type: 'tool_result', tool_use_id: toolUse.id, content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Xero report ${String(input.report)} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Xero report failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a scheduled-task tool (create/list/update/delete). Creating a task
   * only stores it — TaskRunnerService runs it when it falls due. A bad cron or
   * an unknown id comes back as an error result the model can correct, never a
   * failed request.
   */
  private async runTaskTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
    ctx: { slackChannelId: string | null; fetchRequesterTimezone?: () => Promise<string | null> },
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof input[key] === 'string' && (input[key] as string).trim()
        ? (input[key] as string).trim()
        : undefined;
    const result = (content: string, isError = false): LocalToolResult => ({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    try {
      if (toolUse.name === CREATE_SCHEDULED_TASK) {
        const prompt = text('prompt');
        const cronExpression = text('cron_expression');
        if (!prompt || !cronExpression) {
          return result('A task needs both a prompt and a cron_expression.', true);
        }
        const timezone =
          text('timezone') ??
          (ctx.fetchRequesterTimezone ? await ctx.fetchRequesterTimezone() : null);
        const task = await this.tasksService.create(workspaceId, userId, {
          name: text('name') ?? 'Scheduled task',
          prompt,
          cronExpression,
          timezone: timezone ?? undefined,
          slackChannelId: text('slack_channel_id') ?? ctx.slackChannelId ?? undefined,
          description: text('description'),
          oneTime: input.one_time === true,
        });
        return result(
          JSON.stringify({
            created: true,
            id: task.id,
            name: task.name,
            schedule: task.cronExpression,
            timezone: task.timezone ?? 'server time (UTC)',
            nextRun: task.nextRun,
            postsTo: task.slackChannelId ?? 'nowhere (runs silently)',
          }),
        );
      }
      if (toolUse.name === LIST_SCHEDULED_TASKS) {
        const tasks = await this.tasksService.findAllForWorkspace(workspaceId, userId);
        return result(
          JSON.stringify(
            tasks.map((task) => ({
              id: task.id,
              name: task.name,
              prompt: task.prompt,
              schedule: task.cronExpression,
              timezone: task.timezone,
              active: task.isActive,
              oneTime: task.oneTime,
              system: task.isSystem,
              lastRun: task.lastRun,
              nextRun: task.nextRun,
              author: task.authorName,
            })),
          ),
        );
      }
      if (toolUse.name === DELETE_SCHEDULED_TASK) {
        await this.tasksService.remove(workspaceId, String(input.task_id));
        return result('Task deleted.');
      }
      // Remaining task tool: update_scheduled_task.
      const task = await this.tasksService.update(workspaceId, userId, String(input.task_id), {
        ...(typeof input.is_active === 'boolean' ? { isActive: input.is_active } : {}),
        name: text('name'),
        prompt: text('prompt'),
        cronExpression: text('cron_expression'),
        timezone: text('timezone'),
        slackChannelId: text('slack_channel_id'),
      });
      return result(
        `Task "${task.name}" is ${task.isActive ? 'active' : 'paused'}; next run ${
          task.nextRun ?? 'none'
        }.`,
      );
    } catch (error) {
      return result(
        `Could not ${toolUse.name.replace(/_/g, ' ')}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
  }

  /**
   * Execute an ad-rule management tool (create/list/toggle/delete). Creating a
   * rule only persists it — the RulesScheduler evaluates and acts later — so no
   * ad account is touched here. A validation error becomes an error result the
   * model can relay and correct, never a failed request.
   */
  private async runRuleTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    try {
      if (toolUse.name === CREATE_AD_RULE) {
        const rule = await this.rulesService.create(workspaceId, userId, {
          name: String(input.name),
          adAccountId: String(input.ad_account_id),
          scope: input.scope as 'account' | 'campaign' | 'adset',
          metric: input.metric as 'spend' | 'cpa' | 'roas' | 'verified_roas' | 'ctr' | 'cpc',
          comparator: input.comparator as 'gt' | 'gte' | 'lt' | 'lte',
          threshold: Number(input.threshold),
          windowDays: input.window_days as number | undefined,
          action: input.action as 'alert' | 'pause' | 'scale',
          scalePct: input.scale_pct as number | undefined,
          cronExpression: String(input.cron_expression),
          timezone: input.timezone as string | undefined,
          slackChannelId: input.slack_channel_id as string | undefined,
          autoExecute: input.auto_execute as boolean | undefined,
          maxScalePct: input.max_scale_pct as number | undefined,
          maxActionsPerRun: input.max_actions_per_run as number | undefined,
          dailyActionCap: input.daily_action_cap as number | undefined,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Rule "${rule.name}" created (id ${rule.id}); first run ${
            rule.nextRun ? rule.nextRun.toISOString() : 'unscheduled'
          }.`,
        };
      }
      if (toolUse.name === SET_AD_RULE_ACTIVE) {
        const rule = await this.rulesService.setActive(
          workspaceId,
          String(input.rule_id),
          Boolean(input.is_active),
        );
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Rule "${rule.name}" is now ${rule.isActive ? 'active' : 'paused'}.`,
        };
      }
      if (toolUse.name === DELETE_AD_RULE) {
        await this.rulesService.remove(workspaceId, String(input.rule_id));
        return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Rule deleted.' };
      }
      // Remaining rule tool: list_ad_rules.
      const rules = await this.rulesService.list(workspaceId);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(
          rules.map((rule) => ({
            id: rule.id,
            name: rule.name,
            adAccountId: rule.adAccountId,
            scope: rule.scope,
            metric: rule.metric,
            comparator: rule.comparator,
            threshold: rule.threshold,
            windowDays: rule.windowDays,
            action: rule.action,
            scalePct: rule.scalePct,
            autoExecute: rule.autoExecute,
            guardrails: {
              maxScalePct: rule.maxScalePct,
              maxActionsPerRun: rule.maxActionsPerRun,
              dailyActionCap: rule.dailyActionCap,
            },
            cronExpression: rule.cronExpression,
            timezone: rule.timezone,
            isActive: rule.isActive,
            lastRun: rule.lastRun ? rule.lastRun.toISOString() : null,
            nextRun: rule.nextRun ? rule.nextRun.toISOString() : null,
          })),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Rule tool ${toolUse.name} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Rule operation failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a Sheets export tool: write a dataset to a spreadsheet now, or
   * manage the recurring exports that do it on a schedule. Writes only ever
   * touch the workspace's own spreadsheet — nothing is spent and no connected ad
   * account is changed — so these need no confirmation gate. A missing Sheets
   * connection or an API error becomes an error result the model can relay.
   */
  private async runSheetsTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const destination = {
      spreadsheetId: (input.spreadsheet_id as string | undefined) ?? null,
      spreadsheetTitle: (input.spreadsheet_title as string | undefined) ?? null,
      sheetTitle: (input.sheet_title as string | undefined) ?? null,
    };
    try {
      if (toolUse.name === EXPORT_TO_SHEET) {
        const result = await this.exportsService.exportNow(workspaceId, userId, {
          dataset: input.dataset as ExportDataset,
          adAccountId: input.ad_account_id as string | undefined,
          windowDays: input.window_days as number | undefined,
          ...destination,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        };
      }
      if (toolUse.name === CREATE_SCHEDULED_EXPORT) {
        const scheduled = await this.exportsService.create(workspaceId, userId, {
          name: String(input.name),
          dataset: input.dataset as ExportDataset,
          adAccountId: input.ad_account_id as string | undefined,
          windowDays: input.window_days as number | undefined,
          cronExpression: String(input.cron_expression),
          timezone: input.timezone as string | undefined,
          slackChannelId: input.slack_channel_id as string | undefined,
          ...destination,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Export "${scheduled.name}" created (id ${scheduled.id}); first run ${
            scheduled.nextRun ? scheduled.nextRun.toISOString() : 'unscheduled'
          }.`,
        };
      }
      if (toolUse.name === SET_SCHEDULED_EXPORT_ACTIVE) {
        const scheduled = await this.exportsService.setActive(
          workspaceId,
          String(input.export_id),
          Boolean(input.is_active),
        );
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Export "${scheduled.name}" is now ${scheduled.isActive ? 'active' : 'paused'}.`,
        };
      }
      if (toolUse.name === DELETE_SCHEDULED_EXPORT) {
        await this.exportsService.remove(workspaceId, String(input.export_id));
        return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Export deleted.' };
      }
      if (toolUse.name === RUN_SCHEDULED_EXPORT_NOW) {
        const report = await this.exportsService.runNow(workspaceId, String(input.export_id));
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content:
            report.message ??
            `Export "${report.exportName}" ran with nothing new to add since its last run.`,
        };
      }
      // Remaining export tool: list_scheduled_exports.
      const exports = await this.exportsService.list(workspaceId);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(
          exports.map((scheduled) => ({
            id: scheduled.id,
            name: scheduled.name,
            dataset: scheduled.dataset,
            adAccountId: scheduled.adAccountId,
            windowDays: scheduled.windowDays,
            cronExpression: scheduled.cronExpression,
            timezone: scheduled.timezone,
            sheetTitle: scheduled.sheetTitle,
            spreadsheetId: scheduled.spreadsheetId,
            spreadsheetUrl: scheduled.spreadsheetUrl,
            isActive: scheduled.isActive,
            lastRun: scheduled.lastRun ? scheduled.lastRun.toISOString() : null,
            nextRun: scheduled.nextRun ? scheduled.nextRun.toISOString() : null,
            lastRowCount: scheduled.lastRowCount,
            lastError: scheduled.lastError,
          })),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Sheets export tool ${toolUse.name} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Sheets export failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a verified-ROAS tool: pair Meta spend with actual Stripe revenue
   * (verify_roas) or read back past snapshots. Read-only against both APIs — no
   * confirmation gate needed. A missing connection or API error becomes an
   * error result the model can relay, never a failed request.
   */
  private async runRoasTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    try {
      if (toolUse.name === VERIFY_ROAS) {
        const result = await this.roasService.verify(workspaceId, userId, {
          adAccountId: String(input.ad_account_id),
          since: String(input.since),
          until: String(input.until),
          currency: input.currency as string | undefined,
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        };
      }
      // Remaining ROAS tool: list_roas_snapshots.
      const snapshots = await this.roasService.listSnapshots(
        workspaceId,
        typeof input.limit === 'number' ? input.limit : undefined,
      );
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(
          snapshots.map((snapshot) => ({
            adAccountId: snapshot.adAccountId,
            since: snapshot.sinceDate,
            until: snapshot.untilDate,
            metaSpend: snapshot.metaSpend,
            spendCurrency: snapshot.spendCurrency,
            stripeRevenue: snapshot.stripeRevenue,
            revenueCurrency: snapshot.revenueCurrency,
            roas: snapshot.roas,
            purchases: snapshot.purchases,
            cpa: snapshot.cpa,
            caveats: snapshot.caveats,
            verifiedAt: snapshot.createdAt.toISOString(),
          })),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`ROAS tool ${toolUse.name} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `ROAS verification failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a workspace-memory tool (remember/recall/forget a durable fact).
   * A validation or DB error becomes an error result the model can relay,
   * never a failed request.
   */
  private async runMemoryTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    try {
      if (toolUse.name === MEMORY_REMEMBER_FACT) {
        const fact = await this.workspaceMemory.remember(
          workspaceId,
          userId,
          String(input.key ?? ''),
          String(input.value ?? ''),
        );
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Remembered "${fact.key}".`,
        };
      }
      if (toolUse.name === MEMORY_FORGET_FACT) {
        const key = String(input.key ?? '');
        const existed = await this.workspaceMemory.forget(workspaceId, key);
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: existed ? `Forgot "${key}".` : `No fact named "${key}" was saved.`,
        };
      }
      // Remaining memory tool: recall_facts — the full unabridged list.
      const facts = await this.workspaceMemory.list(workspaceId);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(
          facts.map((fact) => ({
            key: fact.key,
            value: fact.value,
            updatedAt: fact.updatedAt.toISOString(),
          })),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Memory tool ${toolUse.name} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Memory operation failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a Meta Ads tool against the Marketing API using the member's stored
   * Meta token. A missing connection or an API error becomes an error result the
   * model can relay, never a failed request.
   */
  private async runMetaAdsTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
    ctx: { confirmVia: ConfirmMode; pending: { current: AiPendingAction | null } },
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    const isWrite = META_ADS_WRITE_TOOL_NAMES.has(toolUse.name);

    // In button mode, a write never runs inline: capture it (once) so the
    // surface can render Approve/Cancel buttons, then tell the model to describe
    // the action and stop. The real execution happens on approval, out of band.
    if (isWrite && ctx.confirmVia === 'buttons') {
      if (!ctx.pending.current) {
        ctx.pending.current = {
          app: 'meta_ads',
          tool: toolUse.name,
          label: META_WRITE_LABELS[toolUse.name] ?? toolUse.name,
          input,
        };
      }
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content:
          'Not executed yet — this change needs the user’s approval, which will be requested ' +
          'via Approve/Cancel buttons shown under your reply. In your reply, state exactly what ' +
          'you will do (account, campaign/ad set, budget, status) in one short paragraph, then ' +
          'stop. Do not call this tool again and do not claim it is done.',
      };
    }

    try {
      const token = await this.integrationsService.getMetaAccessToken(workspaceId, userId);
      if (!token) {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'No active Meta Ads connection is available for this workspace.',
          is_error: true,
        };
      }

      // Inline mode: write tools only run once the model sets `confirmed` after
      // the user has approved. Refuse otherwise — a non-error result so the model
      // asks the user and retries.
      if (isWrite && input.confirmed !== true) {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content:
            'Not executed: this changes a live ad account. Describe the exact action to the user, ' +
            'get their explicit confirmation, then call again with confirmed=true.',
        };
      }

      const result = await this.dispatchMetaAdsTool(token, toolUse.name, input);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meta Ads tool ${toolUse.name} failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Meta Ads request failed: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a previously-proposed Meta Ads write after the user approved it via
   * buttons. Returns a short human summary (success or failure) for the surface
   * to post — the approval itself is the confirmation, so no `confirmed` flag.
   */
  async executeMetaAdsAction(
    workspaceId: string,
    userId: string | null,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; summary: string }> {
    try {
      const token = await this.integrationsService.getMetaAccessToken(workspaceId, userId);
      if (!token) {
        return { ok: false, summary: 'No active Meta Ads connection is available.' };
      }
      const result = await this.dispatchMetaAdsTool(token, toolName, input);
      return { ok: true, summary: this.summarizeMetaWrite(toolName, result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Meta Ads action ${toolName} failed: ${message}`);
      return { ok: false, summary: `Meta Ads request failed: ${message}` };
    }
  }

  /** A short, human confirmation line for a completed Meta Ads write. */
  private summarizeMetaWrite(toolName: string, result: unknown): string {
    const label = META_WRITE_LABELS[toolName] ?? toolName;
    const id =
      result && typeof result === 'object' && 'id' in result
        ? String((result as { id: unknown }).id)
        : null;
    if (toolName.includes('create') && id)
      return `Done — ${label.toLowerCase()} (id ${id}), paused.`;
    return `Done — ${label.toLowerCase()} completed.`;
  }

  /**
   * Dispatch a Meta Ads tool to its Marketing-API call. Pure execution — the
   * confirm/approval gating lives in the callers ({@link runMetaAdsTool} and
   * {@link executeMetaAdsAction}). Returns the raw API result; throws on failure.
   */
  private async dispatchMetaAdsTool(
    token: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    let result: unknown;
    {
      const toolUse = { name: toolName } as { name: string };
      if (toolUse.name === META_ADS_LIST_AD_ACCOUNTS) {
        result = await this.metaAds.listAdAccounts(token);
      } else if (toolUse.name === META_ADS_GET_INSIGHTS) {
        result = await this.metaAds.getInsights(token, {
          adAccountId: String(input.ad_account_id),
          level: input.level as 'account' | 'campaign' | 'adset' | 'ad' | undefined,
          datePreset: input.date_preset as string | undefined,
          since: input.since as string | undefined,
          until: input.until as string | undefined,
          fields: input.fields as string[] | undefined,
        });
      } else if (toolUse.name === META_ADS_LIST_CAMPAIGNS) {
        result = await this.metaAds.listCampaigns(token, {
          adAccountId: String(input.ad_account_id),
          effectiveStatus: input.effective_status as string[] | undefined,
        });
      } else if (toolUse.name === META_ADS_CREATE_CAMPAIGN) {
        result = await this.metaAds.createCampaign(token, {
          adAccountId: String(input.ad_account_id),
          name: String(input.name),
          objective: String(input.objective),
          dailyBudget: input.daily_budget as number | undefined,
        });
      } else if (toolUse.name === META_ADS_UPDATE_CAMPAIGN) {
        result = await this.metaAds.updateCampaign(token, {
          campaignId: String(input.campaign_id),
          name: input.name as string | undefined,
          status: input.status as 'ACTIVE' | 'PAUSED' | undefined,
          dailyBudget: input.daily_budget as number | undefined,
        });
      } else if (toolUse.name === META_ADS_DELETE_CAMPAIGN) {
        result = await this.metaAds.deleteCampaign(token, String(input.campaign_id));
      } else if (toolUse.name === META_ADS_DUPLICATE_CAMPAIGN) {
        result = await this.metaAds.duplicateCampaign(token, {
          campaignId: String(input.campaign_id),
          deepCopy: input.deep_copy as boolean | undefined,
          renameSuffix: input.rename_suffix as string | undefined,
        });
      } else if (toolUse.name === META_ADS_LIST_AD_SETS) {
        result = await this.metaAds.listAdSets(token, String(input.campaign_id));
      } else if (toolUse.name === META_ADS_CREATE_AD_SET) {
        result = await this.metaAds.createAdSet(token, {
          adAccountId: String(input.ad_account_id),
          campaignId: String(input.campaign_id),
          name: String(input.name),
          optimizationGoal: String(input.optimization_goal),
          billingEvent: String(input.billing_event),
          targeting: (input.targeting ?? {}) as Record<string, unknown>,
          dailyBudget: input.daily_budget as number | undefined,
          startTime: input.start_time as string | undefined,
        });
      } else if (toolUse.name === META_ADS_UPDATE_AD_SET) {
        result = await this.metaAds.updateAdSet(token, {
          adSetId: String(input.ad_set_id),
          name: input.name as string | undefined,
          status: input.status as 'ACTIVE' | 'PAUSED' | undefined,
          dailyBudget: input.daily_budget as number | undefined,
        });
      } else if (toolUse.name === META_ADS_DELETE_AD_SET) {
        result = await this.metaAds.deleteAdSet(token, String(input.ad_set_id));
      } else if (toolUse.name === META_ADS_DUPLICATE_AD_SET) {
        result = await this.metaAds.duplicateAdSet(token, {
          adSetId: String(input.ad_set_id),
          campaignId: input.campaign_id as string | undefined,
          deepCopy: input.deep_copy as boolean | undefined,
          renameSuffix: input.rename_suffix as string | undefined,
        });
      } else if (toolUse.name === META_ADS_LIST_ADS) {
        result = await this.metaAds.listAds(token, String(input.ad_set_id));
      } else if (toolUse.name === META_ADS_CREATE_AD_CREATIVE) {
        result = await this.metaAds.createAdCreative(token, {
          adAccountId: String(input.ad_account_id),
          name: String(input.name),
          pageId: String(input.page_id),
          link: String(input.link),
          message: String(input.message),
          headline: input.headline as string | undefined,
          imageUrl: input.image_url as string | undefined,
          callToAction: input.call_to_action as string | undefined,
        });
      } else if (toolUse.name === META_ADS_CREATE_AD) {
        result = await this.metaAds.createAd(token, {
          adAccountId: String(input.ad_account_id),
          name: String(input.name),
          adSetId: String(input.ad_set_id),
          creativeId: String(input.creative_id),
        });
      } else if (toolUse.name === META_ADS_UPDATE_AD) {
        result = await this.metaAds.updateAd(token, {
          adId: String(input.ad_id),
          name: input.name as string | undefined,
          status: input.status as 'ACTIVE' | 'PAUSED' | undefined,
        });
      } else if (toolUse.name === META_ADS_DELETE_AD) {
        result = await this.metaAds.deleteAd(token, String(input.ad_id));
      } else if (toolUse.name === META_ADS_DUPLICATE_AD) {
        result = await this.metaAds.duplicateAd(token, {
          adId: String(input.ad_id),
          adSetId: input.ad_set_id as string | undefined,
          renameSuffix: input.rename_suffix as string | undefined,
        });
      } else if (toolUse.name === META_ADS_LIST_PAGES) {
        result = await this.metaAds.listPages(token);
      } else if (toolUse.name === META_ADS_SEARCH_INTERESTS) {
        result = await this.metaAds.searchInterests(token, String(input.query));
      } else {
        throw new Error(`Unknown Meta Ads tool: ${toolUse.name}`);
      }
    }
    return result;
  }

  /**
   * Produce a full workspace report — total members, sign-up adoption, and every
   * connected account with who connected it — from our own data (plus the Slack
   * roster when available). Read-only and best-effort: a query failure becomes an
   * error result the model can relay, never a failed request.
   */
  private async runWorkspaceStatsTool(
    workspaceId: string,
    toolUse: ToolCall,
    fetchMemberCount?: () => Promise<number | null>,
  ): Promise<LocalToolResult> {
    try {
      const [signedUpMembers, integrations, totalMembers] = await Promise.all([
        this.usersService.countByWorkspace(workspaceId),
        this.integrationsService.getWorkspaceIntegrations(workspaceId),
        fetchMemberCount ? fetchMemberCount() : Promise.resolve(null),
      ]);

      const connectedPeople = new Set(
        integrations.map((row) => row.userName).filter((name): name is string => Boolean(name)),
      ).size;

      const payload = {
        members: {
          // Total members of the workspace (e.g. the full Slack roster); null if
          // we couldn't read it.
          total: totalMembers,
          // People who have a Gaspo account (have interacted with / installed it).
          signedUp: signedUpMembers,
          notSignedUp: totalMembers != null ? Math.max(totalMembers - signedUpMembers, 0) : null,
        },
        connections: {
          accountCount: integrations.length,
          peopleConnected: connectedPeople,
          accounts: integrations.map((row) => ({
            person: row.userName,
            app: row.appName,
            label: row.label,
            scope: row.accessLevel,
            active: row.isActive,
          })),
        },
      };
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(payload),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Workspace stats tool failed: ${message}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Failed to read workspace stats: ${message}`,
        is_error: true,
      };
    }
  }

  /**
   * Execute a local Spaces tool call and return its tool_result. Creating a
   * Space validates the AI's spec (and any starting rows) before persisting; a
   * bad one becomes an error result listing each problem, which the model can
   * read and correct, never a failed request.
   */
  private async runSpaceTool(
    workspaceId: string,
    userId: string | null,
    toolUse: ToolCall,
    spaces: AiSpace[],
  ): Promise<LocalToolResult> {
    const input = (toolUse.input ?? {}) as Record<string, unknown>;
    try {
      if (toolUse.name === 'get_page') {
        const page = await this.spacesService.readPage(workspaceId, String(input.slug));
        const url = this.spacesService.spaceUrl(page.slug);
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Page "${page.name}" at ${url}. Its current HTML:\n\n${page.html ?? ''}`,
        };
      }
      let space: Space;
      let summary: (url: string) => string;
      if (toolUse.name === 'create_page') {
        space = await this.spacesService.createPage(workspaceId, userId, input);
        summary = (url) => `Page "${space.name}" is live at ${url}`;
      } else if (toolUse.name === 'update_page') {
        space = await this.spacesService.updatePage(workspaceId, String(input.slug), input);
        summary = (url) => `Updated page "${space.name}" at ${url}`;
      } else if (toolUse.name === 'update_space') {
        const { slug: target, ...spec } = input;
        space = await this.spacesService.updateSpec(workspaceId, String(target), spec);
        summary = (url) => `Space "${space.name}" is live at ${url}`;
      } else if (toolUse.name === 'add_space_records') {
        const result = await this.spacesService.addRecords(
          workspaceId,
          String(input.slug),
          input.records,
        );
        space = result.space;
        summary = (url) => `Added ${result.added} rows to Space "${space.name}" at ${url}`;
      } else {
        const { records, ...spec } = input;
        const result = await this.spacesService.createFromSpec(workspaceId, userId, spec, records);
        space = result.space;
        summary = (url) =>
          `Space "${space.name}" is live at ${url}` +
          (result.added > 0 ? ` with ${result.added} starting rows` : ' with no rows yet');
      }
      const url = this.spacesService.spaceUrl(space.slug);
      spaces.push({ slug: space.slug, name: space.name, url });
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: summary(url),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reasons = validationReasons(error);
      const detail = reasons.length > 0 ? `${message}:\n- ${reasons.join('\n- ')}` : message;
      this.logger.warn(`Space tool ${toolUse.name} failed: ${detail}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Failed to ${SPACE_TOOL_ACTIONS[toolUse.name] ?? 'build the Space'}: ${detail}`,
        is_error: true,
      };
    }
  }

  /**
   * Meter a completed run. Token spend is best-effort accounting — a failure to
   * persist it must never fail the user's request, so we swallow and log.
   */
  private async recordUsage(
    workspaceId: string,
    userId: string | null,
    model: string,
    inputTokens: number,
    outputTokens: number,
    options: {
      taskId?: string | null;
      sourceName?: string;
      providerCostUsd?: number;
      resolvedModel?: string;
      cacheWriteTokens?: number;
      cacheReadTokens?: number;
      webSearches?: number;
      imageCostUsd?: number;
    } = {},
  ): Promise<void> {
    if (inputTokens + outputTokens <= 0) return;
    try {
      await this.usageService.recordEvent({
        workspaceId,
        userId,
        taskId: options.taskId ?? null,
        type: options.taskId ? CreditEventType.SCHEDULED_TASK : CreditEventType.THREAD,
        model,
        inputTokens,
        outputTokens,
        sourceName: options.sourceName ?? 'ai.run',
        providerCostUsd: options.providerCostUsd,
        resolvedModel: options.resolvedModel ?? null,
        cacheWriteTokens: options.cacheWriteTokens,
        cacheReadTokens: options.cacheReadTokens,
        webSearches: options.webSearches,
        imageCostUsd: options.imageCostUsd,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to record AI usage: ${message}`);
    }
  }
}
