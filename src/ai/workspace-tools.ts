import type { ToolSpec } from './providers/provider.interface';

/**
 * Local (client-side) tools that answer questions about the workspace itself,
 * rather than acting on a connected app. Executed by AiService against the
 * workspace's own data (members, integrations) and the results fed back to the
 * model — the same mechanism as the Spaces tools.
 */

/** Tool name, shared between the definition and AiService's dispatcher. */
export const GET_WORKSPACE_STATS = 'get_workspace_stats';

export const GET_WORKSPACE_STATS_TOOL: ToolSpec = {
  name: GET_WORKSPACE_STATS,
  description:
    'Get a full report of THIS workspace: total members, how many have signed up to Gaspo vs not, ' +
    'and every connected app account with who connected it and its label. Use this for questions like ' +
    '"how many members are in this workspace?", "who has connected what?", or "how many people have ' +
    'attached their Slack?". This reads workspace data directly; it is not a connected-app integration.\n' +
    'ALSO use this to RE-CHECK which apps are connected, reading them live rather than from the list ' +
    'in your instructions. That list was assembled at the start of the turn, so call this whenever the ' +
    'user says they have just connected something ("check now", "I connected it", "it IS connected", ' +
    '"try again"), whenever you are about to tell someone an app is not connected, and whenever the ' +
    'user contradicts you about what is connected. Check before you deny: saying an app is missing ' +
    'when it is there sends the user off to connect something they already have. If this comes back ' +
    'showing the app, use it and simply proceed — do not apologise for a mistake you did not make. ' +
    'If it comes back genuinely missing, say so plainly and name what to connect.\n' +
    'Present the result clearly: a short member summary first (total, signed up, not signed up), then the ' +
    'connected accounts grouped or tabulated by person → app → label (use a Slack code block for alignment ' +
    'when there are several). Flag any account where active is false as needing attention, note when total ' +
    'members is null (roster unavailable), and offer to help reach members who have not signed up. Returns ' +
    'JSON; if there are no connections, say so plainly.',
  parameters: { type: 'object', properties: {} },
};

/** Tool name for the workspace's own Gaspo credit balance. */
export const GET_CREDIT_BALANCE = 'get_credit_balance';

/**
 * Asked "How many credits do I have left?" on 6 Oct 2026, Gaspo could only say
 * "I can't see credit balances" — the figure lives in Gaspo's own ledger, which
 * no tool read.
 */
export const GET_CREDIT_BALANCE_TOOL: ToolSpec = {
  name: GET_CREDIT_BALANCE,
  description:
    "Get this workspace's Gaspo credit balance right now: credits left, their dollar value, and " +
    'which of them expire when (plan credits expire, bought and free ones do not). Use it whenever ' +
    'someone asks how many credits they have, what they have left, or whether they need to top up. ' +
    'Answer with the dollar figure first, and add the billing link if they want more.',
  parameters: { type: 'object', properties: {} },
};

export const WORKSPACE_TOOLS = [GET_WORKSPACE_STATS_TOOL, GET_CREDIT_BALANCE_TOOL];
