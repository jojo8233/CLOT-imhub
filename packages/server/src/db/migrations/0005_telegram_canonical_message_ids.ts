import { sql, type Kysely } from 'kysely'
import type { Database } from '../types.js'

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('messages')
    .addColumn('edit_version', 'integer')
    .execute()
  await db.schema.alterTable('messages')
    .addCheckConstraint(
      'messages_edit_version_nonnegative_check',
      sql`edit_version is null or edit_version >= 0`,
    )
    .execute()

  // M2 以前 Telegram 只保存 TDLib 的 int64 MessageId。服务器消息的低 20 位为 0，
  // 高位才是 MTProto server message id；其余数值属于本地/临时命名空间。
  // 已经是 v2 规范键的行保持不动，未知格式直接阻断迁移，不能静默猜测并误合并。
  await sql`
    do $$
    begin
      if exists (
        select 1
        from conversations c
        join accounts a on a.id = c.account_id
        where a.platform = 'telegram'
          and case
            when c.platform_conversation_id ~ '^(-?[1-9][0-9]*)$'
              then c.platform_conversation_id::numeric < -9223372036854775808
                or c.platform_conversation_id::numeric > 9223372036854775807
            else true
          end
      ) then
        raise exception 'unsupported Telegram chat id; audit conversations before migration';
      end if;

      if exists (
        select 1
        from messages m
        join conversations c on c.id = m.conversation_id
        where m.platform = 'telegram'
          and not (
            m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
            or m.platform_message_id ~ '^-?[1-9][0-9]*:[1-9][0-9]*$'
            or m.platform_message_id
              ~ '^-?[1-9][0-9]*:temp:(tdlib|telegram-tt):-?(0|[1-9][0-9]*)([.][0-9]+)?$'
          )
      ) then
        raise exception 'unsupported Telegram platform_message_id; audit rows before migration';
      end if;

      if exists (
        select 1
        from messages m
        join conversations c on c.id = m.conversation_id
        where m.platform = 'telegram'
          and position(':' in m.platform_message_id) > 0
          and split_part(m.platform_message_id, ':', 1) <> c.platform_conversation_id
      ) then
        raise exception 'Telegram canonical message id does not match its conversation chat id';
      end if;

      if exists (
        select 1
        from messages m
        where m.platform = 'telegram'
          and case
            when m.platform_message_id ~ '^-?[1-9][0-9]*:[1-9][0-9]*$'
              then split_part(m.platform_message_id, ':', 2)::numeric > 2147483647
            else false
          end
      ) then
        raise exception 'Telegram canonical server message id is out of MTProto int32 range';
      end if;

      if exists (
        select 1
        from messages m
        where m.platform = 'telegram'
          and m.platform_message_id
            ~ '^-?[1-9][0-9]*:temp:(tdlib|telegram-tt):-0([.]0+)?$'
      ) then
        raise exception 'Telegram temporary message id negative zero is invalid';
      end if;

      if exists (
        select 1
        from messages m
        where m.platform = 'telegram'
          and m.platform_message_id = '0'
      ) then
        raise exception 'TDLib message id zero is invalid';
      end if;

      if exists (
        select 1
        from messages m
        where m.platform = 'telegram'
          and case
            when m.platform_message_id ~ '^[1-9][0-9]*$'
              then mod(m.platform_message_id::numeric, 1048576) = 0
                and m.platform_message_id::numeric / 1048576 > 2147483647
            else false
          end
      ) then
        raise exception 'TDLib server message id is out of MTProto int32 range';
      end if;

      if exists (
        select 1
        from messages m
        join message_id_aliases alias
          on alias.account_id = m.account_id
          and alias.platform_message_id = m.platform_message_id
          and alias.message_id <> m.id
        where m.platform = 'telegram'
          and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
      ) then
        raise exception 'legacy Telegram message id alias points to another row';
      end if;

      if exists (
        select 1
        from messages m
        join conversations c on c.id = m.conversation_id
        where m.platform = 'telegram'
          and m.reply_to_platform_message_id is not null
          and not (
            m.reply_to_platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
            or m.reply_to_platform_message_id ~ '^-?[1-9][0-9]*:[1-9][0-9]*$'
            or m.reply_to_platform_message_id
              ~ '^-?[1-9][0-9]*:temp:(tdlib|telegram-tt):-?(0|[1-9][0-9]*)([.][0-9]+)?$'
          )
      ) then
        raise exception 'unsupported Telegram reply message id; audit rows before migration';
      end if;

      if exists (
        select 1
        from messages m
        join conversations c on c.id = m.conversation_id
        where m.platform = 'telegram'
          and m.reply_to_platform_message_id is not null
          and position(':' in m.reply_to_platform_message_id) > 0
          and split_part(m.reply_to_platform_message_id, ':', 1)
            <> c.platform_conversation_id
      ) then
        raise exception 'Telegram canonical reply id does not match its conversation chat id';
      end if;

      if exists (
        select 1
        from messages m
        where m.platform = 'telegram'
          and (
            m.reply_to_platform_message_id = '0'
            or m.reply_to_platform_message_id
              ~ '^-?[1-9][0-9]*:temp:(tdlib|telegram-tt):-0([.]0+)?$'
            or case
              when m.reply_to_platform_message_id ~ '^-?[1-9][0-9]*:[1-9][0-9]*$'
                then split_part(m.reply_to_platform_message_id, ':', 2)::numeric > 2147483647
              when m.reply_to_platform_message_id ~ '^[1-9][0-9]*$'
                then mod(m.reply_to_platform_message_id::numeric, 1048576) = 0
                  and m.reply_to_platform_message_id::numeric / 1048576 > 2147483647
              else false
            end
          )
      ) then
        raise exception 'Telegram reply message id is invalid or out of range';
      end if;
    end $$
  `.execute(db)

  await sql`
    do $$
    begin
      if exists (
        with candidates as (
          select
            m.id,
            m.account_id,
            c.platform_conversation_id || case
              when m.platform_message_id::numeric > 0
                and mod(m.platform_message_id::numeric, 1048576) = 0
              then ':' || ((m.platform_message_id::numeric / 1048576)::bigint)::text
              else ':temp:tdlib:' || m.platform_message_id
            end as new_platform_message_id
          from messages m
          join conversations c on c.id = m.conversation_id
          where m.platform = 'telegram'
            and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
        )
        select 1
        from candidates candidate
        join messages existing
          on existing.account_id = candidate.account_id
          and existing.platform_message_id = candidate.new_platform_message_id
          and existing.id <> candidate.id
      ) then
        raise exception 'Telegram canonical message id conflicts with an existing row';
      end if;

      if exists (
        with candidates as (
          select
            m.account_id,
            c.platform_conversation_id || case
              when m.platform_message_id::numeric > 0
                and mod(m.platform_message_id::numeric, 1048576) = 0
              then ':' || ((m.platform_message_id::numeric / 1048576)::bigint)::text
              else ':temp:tdlib:' || m.platform_message_id
            end as new_platform_message_id
          from messages m
          join conversations c on c.id = m.conversation_id
          where m.platform = 'telegram'
            and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
        )
        select 1
        from candidates
        group by account_id, new_platform_message_id
        having count(*) > 1
      ) then
        raise exception 'multiple Telegram rows collapse to one canonical message id';
      end if;

      if exists (
        with candidates as (
          select
            m.id,
            m.account_id,
            c.platform_conversation_id || case
              when m.platform_message_id::numeric > 0
                and mod(m.platform_message_id::numeric, 1048576) = 0
              then ':' || ((m.platform_message_id::numeric / 1048576)::bigint)::text
              else ':temp:tdlib:' || m.platform_message_id
            end as new_platform_message_id
          from messages m
          join conversations c on c.id = m.conversation_id
          where m.platform = 'telegram'
            and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
        )
        select 1
        from candidates candidate
        join message_id_aliases alias
          on alias.account_id = candidate.account_id
          and alias.platform_message_id = candidate.new_platform_message_id
          and alias.message_id <> candidate.id
      ) then
        raise exception 'Telegram canonical message id alias points to another row';
      end if;
    end $$
  `.execute(db)

  // 先保留旧 TDLib id alias。这样迁移前已经在队列里的迟到事件仍会命中同一行。
  await sql`
    insert into message_id_aliases (account_id, platform_message_id, message_id)
    select m.account_id, m.platform_message_id, m.id
    from messages m
    where m.platform = 'telegram'
      and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
    on conflict (account_id, platform_message_id) do nothing
  `.execute(db)

  await sql`
    update messages m
    set platform_message_id = c.platform_conversation_id || case
      when m.platform_message_id::numeric > 0
        and mod(m.platform_message_id::numeric, 1048576) = 0
      then ':' || ((m.platform_message_id::numeric / 1048576)::bigint)::text
      else ':temp:tdlib:' || m.platform_message_id
    end
    from conversations c
    where c.id = m.conversation_id
      and m.platform = 'telegram'
      and m.platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
  `.execute(db)

  await sql`
    update messages m
    set reply_to_platform_message_id = c.platform_conversation_id || case
      when m.reply_to_platform_message_id::numeric > 0
        and mod(m.reply_to_platform_message_id::numeric, 1048576) = 0
      then ':' || ((m.reply_to_platform_message_id::numeric / 1048576)::bigint)::text
      else ':temp:tdlib:' || m.reply_to_platform_message_id
    end
    from conversations c
    where c.id = m.conversation_id
      and m.platform = 'telegram'
      and m.reply_to_platform_message_id ~ '^-?(0|[1-9][0-9]*)$'
  `.execute(db)
}

export async function down(db: Kysely<Database>): Promise<void> {
  // canonical id 与旧 TDLib id alias 保留。反向改回 account 范围 id 会重新制造跨 chat
  // 冲突并破坏已经由 telegram-tt 写入的数据；这里只回退新增的排序列。
  await db.schema.alterTable('messages')
    .dropConstraint('messages_edit_version_nonnegative_check')
    .execute()
  await db.schema.alterTable('messages')
    .dropColumn('edit_version')
    .execute()
}
