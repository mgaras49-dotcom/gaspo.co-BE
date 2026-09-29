import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { CreateTaskDto, UpdateTaskDto } from './dto';
import { TaskRunnerService } from './task-runner.service';
import { TasksService, TaskView } from './tasks.service';

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly taskRunner: TaskRunnerService,
  ) {}

  /** List the scheduled tasks for the current workspace. */
  @Get()
  list(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<TaskView[]> {
    return this.tasksService.findAllForWorkspace(workspaceId, userId);
  }

  /** Create a scheduled task. */
  @Post()
  create(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateTaskDto,
  ): Promise<TaskView> {
    return this.tasksService.create(workspaceId, userId, dto);
  }

  /** Update a task, or pause/resume it via `isActive`. */
  @Patch(':id')
  update(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ): Promise<TaskView> {
    return this.tasksService.update(workspaceId, userId, id, dto);
  }

  /** Run a task now, regardless of its schedule. */
  @Post(':id/run')
  run(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<TaskView> {
    return this.taskRunner.runNow(workspaceId, id, userId);
  }

  /** Delete a task. */
  @Delete(':id')
  remove(
    @CurrentUser('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    return this.tasksService.remove(workspaceId, id);
  }
}
