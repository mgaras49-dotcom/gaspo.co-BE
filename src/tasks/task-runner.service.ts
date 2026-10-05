import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiFile, AiService } from '../ai/ai.service';
import { ScheduledTask } from '../database/entities';
import { SlackService } from '../slack/slack.service';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { TasksService, TaskView } from './tasks.service';

/**
 * Executes scheduled tasks: runs each prompt through {@link AiService} and posts
 * the answer to Slack. Kept apart from {@link TasksService} (the task store) so
 * AiService can create and manage tasks from chat without a dependency cycle —
 * the store knows nothing about AI; only this runner does.
 */
@Injectable()
export class TaskRunnerService {
  private readonly logger = new Logger(TaskRunnerService.name);

  constructor(
    @InjectRepository(ScheduledTask)
    private readonly taskRepository: Repository<ScheduledTask>,
    private readonly tasksService: TasksService,
    private readonly aiService: AiService,
    private readonly slackService: SlackService,
    private readonly workspacesService: WorkspacesService,
    private readonly usersService: UsersService,
  ) {}

  /** Run a task immediately, regardless of its schedule. */
  async runNow(workspaceId: string, id: string, currentUserId: string): Promise<TaskView> {
    const task = await this.taskRepository.findOne({ where: { id, workspaceId } });
    if (!task) throw new NotFoundException('Task not found');
    await this.executeTask(task);
    return this.tasksService.findOneView(workspaceId, id, currentUserId);
  }

  /**
   * Execute every active task that is due, called on each scheduler tick. Tasks
   * run sequentially; one failure never blocks the rest.
   */
  async runDueTasks(now: Date = new Date()): Promise<void> {
    const due = await this.taskRepository
      .createQueryBuilder('task')
      .where('task.isActive = :active', { active: true })
      .andWhere('task.nextRun IS NOT NULL')
      .andWhere('task.nextRun <= :now', { now })
      .getMany();

    for (const task of due) {
      await this.executeTask(task).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Scheduled task ${task.id} (${task.name}) failed: ${message}`);
      });
    }
  }

  /** Run one task's prompt, deliver its answer to Slack, and advance its schedule. */
  private async executeTask(task: ScheduledTask): Promise<void> {
    this.logger.log(`Running task ${task.id} (${task.name})`);
    try {
      const result = await this.aiService.run(task.workspaceId, task.createdByUserId, task.prompt, {
        model: task.model,
        taskId: task.id,
        sourceName: `task:${task.name}`,
        timezone: task.timezone,
      });
      await this.deliver(task, result.answer, result.files);
    } finally {
      task.lastRun = new Date();
      if (task.oneTime) {
        task.isActive = false;
        task.nextRun = null;
      } else {
        task.nextRun = this.tasksService.nextRunFrom(task.cronExpression, task.timezone);
      }
      await this.taskRepository.save(task);
    }
  }

  /**
   * Post a task's answer to its configured Slack destination. A task made on the
   * dashboard can have no channel; it reports to its creator by DM instead, since
   * a task that runs silently is one nobody can check — "respond to all my
   * emails" ran for days that way with no one seeing what it did. Best-effort: a
   * missing bot token or recipient is logged, not thrown, so the schedule still
   * advances.
   */
  private async deliver(task: ScheduledTask, answer: string, files: AiFile[]): Promise<void> {
    const text = answer?.trim();
    if (!text) return;

    const workspace = await this.workspacesService.findById(task.workspaceId);
    if (!workspace?.slackBotToken) {
      this.logger.warn(`Task ${task.id} (${task.name}) has no Slack bot token to deliver with`);
      return;
    }
    const destination = task.slackChannelId ?? (await this.creatorDm(task));
    if (!destination) {
      this.logger.warn(`Task ${task.id} (${task.name}) has no channel and no creator to DM`);
      return;
    }
    // Chat answers explain themselves; a task's answer arrives unprompted, so it
    // says which task it came from.
    const body = task.slackChannelId ? text : `*${task.name}* (scheduled task)\n\n${text}`;
    await this.slackService.deliver(workspace.slackBotToken, destination, body, files);
  }

  /** The creator's Slack user id, which Slack accepts as a DM destination. */
  private async creatorDm(task: ScheduledTask): Promise<string | null> {
    if (!task.createdByUserId) return null;
    const creator = await this.usersService.findById(task.createdByUserId);
    return creator?.slackUserId ?? null;
  }
}
