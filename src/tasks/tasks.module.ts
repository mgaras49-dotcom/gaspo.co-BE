import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduledTask } from '../database/entities';
import { TasksService } from './tasks.service';

/**
 * The scheduled-task store. Deliberately free of AI: AiModule imports it so the
 * model can manage tasks from chat, and running tasks lives in TaskRunnerModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ScheduledTask])],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
