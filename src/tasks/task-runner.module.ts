import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { ScheduledTask } from '../database/entities';
import { SlackModule } from '../slack/slack.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TaskRunnerService } from './task-runner.service';
import { TasksController } from './tasks.controller';
import { TasksModule } from './tasks.module';
import { TasksScheduler } from './tasks.scheduler';

/** Runs scheduled tasks on their cron and serves the dashboard's task API. */
@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduledTask]),
    AiModule,
    SlackModule,
    TasksModule,
    WorkspacesModule,
  ],
  controllers: [TasksController],
  providers: [TaskRunnerService, TasksScheduler],
})
export class TaskRunnerModule {}
