import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BugReportStatus } from '../common/enums';
import { UpdateBugReportDto } from './dto';
import { SuperAdminGuard } from './guards/super-admin.guard';
import type { WorkspaceStage } from './sales';
import { SuperAdminService, type WorkspaceSort } from './super-admin.service';

/** Clamp a `days` query param to a window the aggregates can serve. */
function parseDays(raw: string | undefined, fallback = 30): number {
  return Math.min(Math.max(Number(raw) || fallback, 1), 365);
}

/**
 * The platform owner's panel — the only cross-tenant surface in the API.
 *
 * Namespaced away from `/admin`, which is *workspace* administration and is
 * reachable by any customer's admin. Two similar names for two very different
 * blast radii is exactly the confusion worth spending a URL prefix to avoid.
 *
 * The class-level guard is the whole authorization story: there is no `@Roles`
 * here, because no workspace role grants this.
 */
@ApiTags('super-admin')
@UseGuards(SuperAdminGuard)
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  /** Platform headline numbers: tenants, users, revenue, margin, open bugs. */
  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.superAdminService.overview(parseDays(days));
  }

  /** Daily signups and platform-wide burn, for the growth chart. */
  @Get('growth')
  growth(@Query('days') days?: string) {
    return this.superAdminService.growth(parseDays(days));
  }

  /** The customer table: every workspace with its members, credits and plan. */
  @Get('workspaces')
  listWorkspaces(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string,
    @Query('stage') stage?: string,
  ) {
    // An unrecognised sort or stage falls back to the default rather than
    // erroring, for the same reason the bug filter below does: this is a view
    // preference arriving from a URL, and a stale link should still render the
    // table.
    return this.superAdminService.listWorkspaces({
      search,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      sort: sort as WorkspaceSort | undefined,
      stage: stage as WorkspaceStage | undefined,
    });
  }

  /** One customer in full: members, plan, grants, integrations, recent runs. */
  @Get('workspaces/:id')
  workspaceDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.superAdminService.workspaceDetail(id);
  }

  /** The bug inbox across every tenant. */
  @Get('bugs')
  listBugs(@Query('status') status?: string, @Query('limit') limit?: string) {
    // An unrecognised status is treated as no filter rather than an error: the
    // query string is a view preference, and a stale bookmark should show the
    // inbox, not a 400.
    const parsed = Object.values(BugReportStatus).find((value) => value === status);
    return this.superAdminService.listBugReports({
      status: parsed,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Move a report through triage, or annotate it. */
  @Patch('bugs/:id')
  updateBug(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBugReportDto) {
    return this.superAdminService.updateBugReport(id, dto);
  }
}
