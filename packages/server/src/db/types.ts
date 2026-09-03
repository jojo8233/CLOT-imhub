import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type {
  AccountConnectionMode,
  AccountStatus,
  Direction,
  KeywordAlertSeverity,
  Platform,
  Role,
} from '@im-hub/shared'
import type { TelegramShadowEventType, TelegramShadowSource } from '../shadow/telegram.js'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableText = ColumnType<string | null, string | null | undefined, string | null>
/** 必填且 DB 无默认值的时间列：insert 时不允许省略 */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>

export type WhatsAppSendAttemptState = 'sending' | 'accepted' | 'unknown' | 'failed'
export type WhatsAppMessageStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted'
export type WhatsAppOnboardingState = 'pending' | 'processing' | 'completed' | 'failed'

export interface UsersTable {
  id: Generated<string>
  email: string
  display_name: string
  role: Role
  password_hash: string
  created_at: Generated<Timestamp>
  disabled_at: Timestamp | null
}

export interface TeamsTable {
  id: Generated<string>
  name: string
  created_at: Generated<Timestamp>
}

export interface TeamMembersTable {
  team_id: string
  user_id: string
  is_lead: boolean
}

export interface AccountsTable {
  id: Generated<string>
  platform: Platform
  owner_user_id: string
  team_id: string | null
  display_name: string
  status: AccountStatus
  /** 服务端适配器、桌面原生客户端、官方网页壳或官方 Cloud API。 */
  connection_mode: Generated<AccountConnectionMode>
  credentials_ref: string | null
  /** 由平台适配器确认的实际登录身份；Telegram 使用 self user id。 */
  platform_account_external_id: NullableText
  /** 每次签发或撤销 native control grant 都递增，使旧 grant 立即失效。 */
  native_control_version: Generated<number>
  linked_at: Timestamp | null
  /** link 模式接入的平台（Signal）在此标注历史消息起点，null 表示历史完整 */
  history_available_from: Timestamp | null
  created_at: Generated<Timestamp>
}

export interface ConversationsTable {
  id: Generated<string>
  account_id: string
  platform_conversation_id: string
  contact_external_id: string
  contact_display_name: string | null
  last_message_at: Timestamp | null
  /** null 表示自动跟随客户语言，有值表示员工按会话锁定了目标语言 */
  target_lang: string | null
}

export interface CustomerProfilesTable {
  conversation_id: string
  name: string | null
  age_location: string | null
  occupation: string | null
  family: string | null
  interests: string | null
  other: string | null
  revision: number
  updated_by_user_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface MessagesTable {
  id: Generated<string>
  conversation_id: string
  account_id: string
  platform: Platform
  platform_message_id: string
  direction: Direction
  sender_external_id: string
  body: string
  body_lang: string | null
  media_refs: JSONColumnType<unknown[]>
  reply_to_platform_message_id: NullableText
  edited_at: Timestamp | null
  edit_version: number | null
  deleted_at: Timestamp | null
  sent_at: RequiredTimestamp
  ingested_at: Generated<Timestamp>
  raw: JSONColumnType<Record<string, unknown>>
}

export interface MessageIdAliasesTable {
  account_id: string
  platform_message_id: string
  message_id: string
  created_at: Generated<Timestamp>
}

export interface MessageTranslationsTable {
  message_id: string
  target_lang: string
  provider: string
  translated_text: string
  created_at: Generated<Timestamp>
}

export interface MessageReactionsTable {
  account_id: string
  platform_message_id: string
  reactor_external_id: string
  /** null 是删除回应的墓碑，防止迟到的旧 add 在乱序重放时复活。 */
  emoji: string | null
  reacted_at: RequiredTimestamp
}

export interface TelegramShadowObservationsTable {
  account_id: string
  source: TelegramShadowSource
  event_type: TelegramShadowEventType
  fact_key: string
  semantic_hash: string
  has_conflict: Generated<boolean>
  observation_count: Generated<number>
  first_observed_at: Timestamp
  last_observed_at: Timestamp
}

/**
 * 服务端 secret store。ciphertext/iv/auth_tag 都是 base64，主密钥只来自进程环境。
 * account_id 级联删除，避免删除 Cloud API 账号后遗留不可达 token。
 */
export interface PlatformSecretsTable {
  id: Generated<string>
  account_id: string
  purpose: string
  ciphertext: string
  iv: string
  auth_tag: string
  created_at: Generated<Timestamp>
  rotated_at: Timestamp | null
}

export interface WhatsAppCloudAccountsTable {
  account_id: string
  waba_id: string
  phone_number_id: string
  graph_api_version: string
  authorization_revision: Generated<number>
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface WhatsAppSendAttemptsTable {
  attempt_id: string
  account_id: string
  conversation_id: string
  actor_user_id: string
  target_external_id: string
  body_sha256: string
  authorization_revision: number
  state: WhatsAppSendAttemptState
  platform_message_id: string | null
  error_code: string | null
  started_at: Generated<Timestamp>
  completed_at: Timestamp | null
}

export interface WhatsAppMessageStatusesTable {
  account_id: string
  platform_message_id: string
  status: WhatsAppMessageStatus
  status_at: RequiredTimestamp
  error_code: string | null
  updated_at: Generated<Timestamp>
}

export interface WhatsAppOnboardingSessionsTable {
  id: Generated<string>
  owner_user_id: string
  team_id: string | null
  display_name: string
  ticket_sha256: string
  state: Generated<WhatsAppOnboardingState>
  account_id: string | null
  error_code: string | null
  expires_at: RequiredTimestamp
  created_at: Generated<Timestamp>
  consumed_at: Timestamp | null
}

export interface KeywordRulesTable {
  id: Generated<string>
  pattern: string
  normalized_pattern: string
  severity: KeywordAlertSeverity
  enabled: Generated<boolean>
  revision: Generated<number>
  effective_at: Generated<Timestamp>
  created_by_user_id: string
  updated_by_user_id: string
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
  deleted_at: Timestamp | null
}

export interface KeywordAlertScanJobsTable {
  id: Generated<string>
  message_id: string
  message_revision: string
  body_snapshot: string
  available_at: Generated<Timestamp>
  attempt_count: Generated<number>
  lease_owner: string | null
  lease_expires_at: Timestamp | null
  last_error_code: string | null
  created_at: Generated<Timestamp>
}

export interface KeywordAlertsTable {
  id: Generated<string>
  message_id: string
  rule_id: string
  pattern_snapshot: string
  severity_snapshot: KeywordAlertSeverity
  matched_message_revision: string
  created_at: Generated<Timestamp>
}

export interface KeywordAlertRecipientsTable {
  alert_id: string
  user_id: string
  requires_ack: boolean
  acknowledged_at: Timestamp | null
  created_at: Generated<Timestamp>
}

export interface Database {
  users: UsersTable
  teams: TeamsTable
  team_members: TeamMembersTable
  accounts: AccountsTable
  conversations: ConversationsTable
  customer_profiles: CustomerProfilesTable
  messages: MessagesTable
  message_translations: MessageTranslationsTable
  message_reactions: MessageReactionsTable
  message_id_aliases: MessageIdAliasesTable
  telegram_shadow_observations: TelegramShadowObservationsTable
  platform_secrets: PlatformSecretsTable
  whatsapp_cloud_accounts: WhatsAppCloudAccountsTable
  whatsapp_send_attempts: WhatsAppSendAttemptsTable
  whatsapp_message_statuses: WhatsAppMessageStatusesTable
  whatsapp_onboarding_sessions: WhatsAppOnboardingSessionsTable
  keyword_rules: KeywordRulesTable
  keyword_alert_scan_jobs: KeywordAlertScanJobsTable
  keyword_alerts: KeywordAlertsTable
  keyword_alert_recipients: KeywordAlertRecipientsTable
}
