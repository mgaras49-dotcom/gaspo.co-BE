import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TaskRunnerService } from './task-runner.service';

/**
 * Drives scheduled-task execution. A single per-minute tick asks the service to
 * run whatever is due, so schedules survive restarts (state lives in the DB, not
 * in registered cron jobs) and overlapping ticks are avoided by a run guard.
 */
@Injectable()
export class TasksScheduler {
  private readonly logger = new Logger(TasksScheduler.name);
  private running = false;

  constructor(private readonly taskRunner: TaskRunnerService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.taskRunner.runDueTasks();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Scheduler tick failed: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
