import { sql, type Kysely } from 'kysely'
import type { Database } from './types.js'

export type OrganizationPreflightIssueCode =
  | 'enabled_owner_count'
  | 'team_lead_count'
  | 'multi_team_agent'
  | 'invalid_membership'
  | 'invalid_account_assignment'

export interface OrganizationPreflightIssue {
  code: OrganizationPreflightIssueCode
  count: number
}

export interface OrganizationPreflightReport {
  ok: boolean
  issues: OrganizationPreflightIssue[]
}

function numericCount(value: string | number | bigint): number {
  return Number(value)
}

export async function organizationPreflight(
  db: Kysely<Database>,
): Promise<OrganizationPreflightReport> {
  const ownerCountRow = await db.selectFrom('users')
    .select(expression => expression.fn.countAll<string>().as('count'))
    .where('role', '=', 'owner')
    .where('disabled_at', 'is', null)
    .executeTakeFirstOrThrow()

  const invalidLeadTeams = await db.selectFrom('teams as team')
    .leftJoin('team_members as member', join => join
      .onRef('member.team_id', '=', 'team.id')
      .on('member.is_lead', '=', true))
    .select('team.id')
    .where(sql<boolean>`to_jsonb(team)->>'disabled_at' is null`)
    .groupBy('team.id')
    .having(sql<number>`count(member.user_id)`, '<>', 1)
    .execute()

  const multiTeamAgents = await db.selectFrom('users as user')
    .innerJoin('team_members as member', 'member.user_id', 'user.id')
    .select('user.id')
    .where('user.role', '=', 'agent')
    .where('user.disabled_at', 'is', null)
    .groupBy('user.id')
    .having(sql<number>`count(member.team_id)`, '>', 1)
    .execute()

  const invalidMembershipRow = await db.selectFrom('team_members as member')
    .innerJoin('users as user', 'user.id', 'member.user_id')
    .innerJoin('teams as team', 'team.id', 'member.team_id')
    .select(expression => expression.fn.countAll<string>().as('count'))
    .where(expression => expression.or([
      expression('user.disabled_at', 'is not', null),
      expression('user.role', 'in', ['owner', 'auditor']),
      expression.and([
        expression('user.role', '=', 'manager'),
        expression('member.is_lead', '=', false),
      ]),
      expression.and([
        expression('user.role', '=', 'agent'),
        expression('member.is_lead', '=', true),
      ]),
      sql<boolean>`to_jsonb(team)->>'disabled_at' is not null`,
    ]))
    .executeTakeFirstOrThrow()

  const membershipCounts = db.selectFrom('team_members')
    .select('user_id')
    .select(expression => expression.fn.countAll<string>().as('membership_count'))
    .groupBy('user_id')
    .as('membership_counts')

  const invalidAccountRow = await db.selectFrom('accounts as account')
    .innerJoin('users as owner', 'owner.id', 'account.owner_user_id')
    .leftJoin('teams as account_team', 'account_team.id', 'account.team_id')
    .leftJoin('team_members as assignment_membership', join => join
      .onRef('assignment_membership.user_id', '=', 'owner.id')
      .onRef('assignment_membership.team_id', '=', 'account.team_id'))
    .leftJoin(membershipCounts, 'membership_counts.user_id', 'owner.id')
    .select(expression => expression.fn.countAll<string>().as('count'))
    .where(expression => expression.or([
      expression('owner.disabled_at', 'is not', null),
      expression('owner.role', '=', 'auditor'),
      sql<boolean>`account.team_id is not null and (
        account_team.id is null
        or to_jsonb(account_team)->>'disabled_at' is not null
      )`,
      sql<boolean>`owner.role = 'agent' and (
        coalesce(membership_counts.membership_count, 0) > 1
        or (
          coalesce(membership_counts.membership_count, 0) = 0
          and account.team_id is not null
        )
        or (
          coalesce(membership_counts.membership_count, 0) = 1
          and assignment_membership.user_id is null
        )
      )`,
      sql<boolean>`owner.role = 'manager' and (
        account.team_id is null
        or assignment_membership.user_id is null
        or assignment_membership.is_lead is not true
      )`,
    ]))
    .executeTakeFirstOrThrow()

  const counts: OrganizationPreflightIssue[] = [
    { code: 'enabled_owner_count', count: numericCount(ownerCountRow.count) },
    { code: 'team_lead_count', count: invalidLeadTeams.length },
    { code: 'multi_team_agent', count: multiTeamAgents.length },
    {
      code: 'invalid_membership',
      count: numericCount(invalidMembershipRow.count),
    },
    {
      code: 'invalid_account_assignment',
      count: numericCount(invalidAccountRow.count),
    },
  ]
  const issues = counts.filter(issue => (
    issue.code === 'enabled_owner_count' ? issue.count !== 1 : issue.count > 0
  ))
  return { ok: issues.length === 0, issues }
}
