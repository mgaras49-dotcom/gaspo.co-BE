import type { ToolSpec } from './providers/provider.interface';

/**
 * Local tools for scheduled tasks — the same tasks the dashboard's Scheduled
 * Tasks page manages. A task re-runs a prompt through Gaspo on a cron schedule
 * with the workspace's connected apps, and posts the answer to Slack. Offered on
 * every run: without them the model told people who asked for "every morning"
 * work that Gaspo had no scheduling, while the dashboard plainly had it.
 */

/** Tool names, shared between the definitions and AiService's dispatcher. */
export const CREATE_SCHEDULED_TASK = 'create_scheduled_task';
export const LIST_SCHEDULED_TASKS = 'list_scheduled_tasks';
export const UPDATE_SCHEDULED_TASK = 'update_scheduled_task';
export const DELETE_SCHEDULED_TASK = 'delete_scheduled_task';

const CREATE_SCHEDULED_TASK_TOOL: ToolSpec = {
  name: CREATE_SCHEDULED_TASK,
  description:
    'Schedule a recurring (or one-time) task: at each scheduled time Gaspo runs the prompt on its ' +
    'own, with this workspace\'s connected apps, and posts the result in Slack — e.g. "every ' +
    'weekday at 8am, sort my new emails and summarise what needs a reply", "every Monday at 9, ' +
    'post last week\'s Xero revenue", "tomorrow at 3pm remind me to call Sam". Write the prompt ' +
    'as a complete, self-contained instruction, because it runs later with no memory of this ' +
    'conversation. Confirm the schedule and what it will do with the user before calling. ' +
    'Returns the task with its next run time.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short human name, e.g. "Morning inbox triage".' },
      prompt: {
        type: 'string',
        description:
          'The full instruction to run each time, written as if the user had just sent it. ' +
          'Name the apps and specifics it needs (which inbox, which report, what to post).',
      },
      cron_expression: {
        type: 'string',
        description:
          'Standard 5-field cron (minute hour day-of-month month day-of-week) for WHEN it runs, ' +
          'e.g. "0 8 * * *" daily at 8:00, "0 8 * * 1-5" weekdays at 8:00, "0 9 * * 1" Mondays ' +
          'at 9:00. For a one-time task, the single minute it should fire, with one_time true.',
      },
      timezone: {
        type: 'string',
        description:
          'IANA timezone the cron runs in, e.g. "Australia/Sydney". Omit to use the requester\'s ' +
          'own Slack timezone.',
      },
      one_time: {
        type: 'boolean',
        description: 'true to run once at the next matching time and then stop. Default false.',
      },
      slack_channel_id: {
        type: 'string',
        description:
          'Where to post results: a Slack channel id, or a user id for a DM. Omit to post back ' +
          'where this conversation is happening.',
      },
      description: { type: 'string', description: 'Optional one-line summary for the dashboard.' },
    },
    required: ['name', 'prompt', 'cron_expression'],
  },
};

const LIST_SCHEDULED_TASKS_TOOL: ToolSpec = {
  name: LIST_SCHEDULED_TASKS,
  description:
    "List this workspace's scheduled tasks with their schedule, prompt, active state, and last " +
    'and next run. Use for "what have I got scheduled?" or to find a task id to change. Returns JSON.',
  parameters: { type: 'object', properties: {} },
};

const UPDATE_SCHEDULED_TASK_TOOL: ToolSpec = {
  name: UPDATE_SCHEDULED_TASK,
  description:
    'Change a scheduled task by id: pause or resume it, move its schedule, or rewrite its prompt. ' +
    'Only the fields given change. Get the id from list_scheduled_tasks.',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task id to change.' },
      is_active: { type: 'boolean', description: 'false to pause, true to resume.' },
      name: { type: 'string' },
      prompt: { type: 'string' },
      cron_expression: { type: 'string' },
      timezone: { type: 'string' },
      slack_channel_id: { type: 'string' },
    },
    required: ['task_id'],
  },
};

const DELETE_SCHEDULED_TASK_TOOL: ToolSpec = {
  name: DELETE_SCHEDULED_TASK,
  description:
    'Permanently delete a scheduled task by id. Confirm which task with the user first. Get the ' +
    'id from list_scheduled_tasks.',
  parameters: {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'The task id to delete.' } },
    required: ['task_id'],
  },
};

export const TASK_TOOLS: ToolSpec[] = [
  CREATE_SCHEDULED_TASK_TOOL,
  LIST_SCHEDULED_TASKS_TOOL,
  UPDATE_SCHEDULED_TASK_TOOL,
  DELETE_SCHEDULED_TASK_TOOL,
];

/** Every task tool name, for the AiService dispatcher. */
export const TASK_TOOL_NAMES = new Set<string>([
  CREATE_SCHEDULED_TASK,
  LIST_SCHEDULED_TASKS,
  UPDATE_SCHEDULED_TASK,
  DELETE_SCHEDULED_TASK,
]);
