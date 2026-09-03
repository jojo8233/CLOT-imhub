import type {
  KeywordRule,
  KeywordRuleCreate,
  KeywordRuleListResponse,
  KeywordRuleUpdate,
} from '@im-hub/shared'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Database, KeywordRulesTable } from '../db/types.js'
import { normalizeKeywordPattern } from './matcher.js'

const ACTIVE_PATTERN_CONSTRAINT = 'keyword_rules_normalized_active_uq'

export type SaveKeywordRuleResult =
  | { kind: 'updated'; rule: KeywordRule }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'duplicate' }

export type CreateKeywordRuleResult =
  | { kind: 'created'; rule: KeywordRule }
  | { kind: 'duplicate' }

export type RemoveKeywordRuleResult =
  | { kind: 'removed' }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentRevision: number }

export interface KeywordAlertScanMaintenance {
  countDegraded(): Promise<number>
  retryDegraded(now: Date): Promise<number>
}

type KeywordRuleRow = Selectable<KeywordRulesTable>

function timestampToIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function rowToRule(row: KeywordRuleRow): KeywordRule {
  return {
    id: row.id,
    pattern: row.pattern,
    severity: row.severity,
    enabled: row.enabled,
    revision: row.revision,
    effectiveAt: timestampToIso(row.effective_at),
    createdAt: timestampToIso(row.created_at),
    updatedAt: timestampToIso(row.updated_at),
  }
}

function isActivePatternConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23505' && candidate.constraint === ACTIVE_PATTERN_CONSTRAINT
}

export class KeywordRuleRepo {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly scans: KeywordAlertScanMaintenance,
  ) {}

  async list(): Promise<KeywordRuleListResponse> {
    const [rows, degradedScanCount] = await Promise.all([
      this.db.selectFrom('keyword_rules')
        .selectAll()
        .where('deleted_at', 'is', null)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
      this.scans.countDegraded(),
    ])
    return { rules: rows.map(rowToRule), degradedScanCount }
  }

  async create(
    actorUserId: string,
    input: KeywordRuleCreate,
  ): Promise<CreateKeywordRuleResult> {
    const pattern = input.pattern.trim()
    const normalizedPattern = normalizeKeywordPattern(input.pattern)
    const changedAt = new Date()
    try {
      const row = await this.db.insertInto('keyword_rules').values({
        pattern,
        normalized_pattern: normalizedPattern,
        severity: input.severity,
        enabled: input.enabled,
        revision: 1,
        effective_at: changedAt,
        created_by_user_id: actorUserId,
        updated_by_user_id: actorUserId,
        created_at: changedAt,
        updated_at: changedAt,
        deleted_at: null,
      }).returningAll().executeTakeFirstOrThrow()
      return { kind: 'created', rule: rowToRule(row) }
    } catch (error) {
      if (isActivePatternConflict(error)) return { kind: 'duplicate' }
      throw error
    }
  }

  async update(
    id: string,
    actorUserId: string,
    input: KeywordRuleUpdate,
  ): Promise<SaveKeywordRuleResult> {
    const patternChanges = input.pattern === undefined
      ? {}
      : {
          pattern: input.pattern.trim(),
          normalized_pattern: normalizeKeywordPattern(input.pattern),
        }
    const changedAt = new Date()
    try {
      const row = await this.db.updateTable('keyword_rules').set({
        ...patternChanges,
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        revision: sql<number>`revision + 1`,
        effective_at: changedAt,
        updated_at: changedAt,
        updated_by_user_id: actorUserId,
      })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .where('revision', '=', input.baseRevision)
        .returningAll()
        .executeTakeFirst()
      if (row) return { kind: 'updated', rule: rowToRule(row) }
    } catch (error) {
      if (isActivePatternConflict(error)) return { kind: 'duplicate' }
      throw error
    }

    const current = await this.currentRevision(id)
    return current === null
      ? { kind: 'not_found' }
      : { kind: 'conflict', currentRevision: current }
  }

  async remove(
    id: string,
    actorUserId: string,
    baseRevision: number,
  ): Promise<RemoveKeywordRuleResult> {
    const changedAt = new Date()
    const removed = await this.db.updateTable('keyword_rules').set({
      enabled: false,
      revision: sql<number>`revision + 1`,
      effective_at: changedAt,
      updated_at: changedAt,
      updated_by_user_id: actorUserId,
      deleted_at: changedAt,
    })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .where('revision', '=', baseRevision)
      .returning('id')
      .executeTakeFirst()
    if (removed) return { kind: 'removed' }

    const current = await this.currentRevision(id)
    return current === null
      ? { kind: 'not_found' }
      : { kind: 'conflict', currentRevision: current }
  }

  async retryDegraded(now: Date): Promise<{ retried: number }> {
    return { retried: await this.scans.retryDegraded(now) }
  }

  private async currentRevision(id: string): Promise<number | null> {
    const row = await this.db.selectFrom('keyword_rules')
      .select('revision')
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    return row?.revision ?? null
  }
}
