import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiFile, AiService } from '../ai/ai.service';
import { ScheduledTask } from '../database/entities';
import { SlackService } from '../slack/slack.service';
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
   * Post a task's answer to its configured Slack destination. Best-effort: a
   * task with no destination (or an empty answer) simply runs silently, and a
   * missing bot token is logged rather than thrown so the schedule still advances.
   */
  private async deliver(task: ScheduledTask, answer: string, files: AiFile[]): Promise<void> {
    const text = answer?.trim();
    if (!task.slackChannelId || !text) return;

    const workspace = await this.workspacesService.findById(task.workspaceId);
    if (!workspace?.slackBotToken) {
      this.logger.warn(`Task ${task.id} (${task.name}) has no Slack bot token to deliver with`);
      return;
    }
    await this.slackService.deliver(workspace.slackBotToken, task.slackChannelId, text, files);
  }
}
