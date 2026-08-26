import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type { AccountStatus, Direction, Platform, Role } from '@im-hub/shared'

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableText = ColumnType<string | null, string | null | undefined, string | null>
/** 必填且 DB 无默认值的时间列：insert 时不允许省略 */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>

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
  credentials_ref: string | null
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

export interface Database {
  users: UsersTable
  teams: TeamsTable
  team_members: TeamMembersTable
  accounts: AccountsTable
  conversations: ConversationsTable
  messages: MessagesTable
  message_translations: MessageTranslationsTable
  message_id_aliases: MessageIdAliasesTable
}
