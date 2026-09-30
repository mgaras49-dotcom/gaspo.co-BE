export * from './workspace.entity';
export * from './user.entity';
export * from './integration.entity';
export * from './skill.entity';
export * from './user-skill.entity';
export * from './scheduled-task.entity';
export * from './credit-event.entity';
export * from './credit-grant.entity';
export * from './credit-allocation.entity';
export * from './subscription.entity';
export * from './message.entity';
export * from './workspace-memory.entity';
export * from './roas-snapshot.entity';
export * from './ad-rule.entity';
export * from './ad-rule-action.entity';
export * from './anomaly-alert.entity';
export * from './scheduled-export.entity';
export * from './space.entity';
export * from './space-user.entity';
export * from './space-auth-token.entity';
export * from './space-record.entity';
export * from './bug-report.entity';
export * from './generated-file.entity';

import { BugReport } from './bug-report.entity';
import { CreditAllocation } from './credit-allocation.entity';
import { CreditEvent } from './credit-event.entity';
import { CreditGrant } from './credit-grant.entity';
import { GeneratedFile } from './generated-file.entity';
import { Integration } from './integration.entity';
import { AdRuleAction } from './ad-rule-action.entity';
import { AdRule } from './ad-rule.entity';
import { AnomalyAlert } from './anomaly-alert.entity';
import { Message } from './message.entity';
import { RoasSnapshot } from './roas-snapshot.entity';
import { ScheduledExport } from './scheduled-export.entity';
import { ScheduledTask } from './scheduled-task.entity';
import { Skill } from './skill.entity';
import { SpaceAuthToken } from './space-auth-token.entity';
import { SpaceRecord } from './space-record.entity';
import { SpaceUser } from './space-user.entity';
import { Space } from './space.entity';
import { Subscription } from './subscription.entity';
import { User } from './user.entity';
import { UserSkill } from './user-skill.entity';
import { WorkspaceMemory } from './workspace-memory.entity';
import { Workspace } from './workspace.entity';

/** Convenience array of every entity, used for TypeORM registration. */
export const entities = [
  Workspace,
  User,
  Integration,
  Skill,
  UserSkill,
  ScheduledTask,
  CreditEvent,
  CreditGrant,
  CreditAllocation,
  Subscription,
  Message,
  WorkspaceMemory,
  RoasSnapshot,
  AdRule,
  AdRuleAction,
  AnomalyAlert,
  ScheduledExport,
  Space,
  SpaceUser,
  SpaceAuthToken,
  SpaceRecord,
  BugReport,
  GeneratedFile,
];
