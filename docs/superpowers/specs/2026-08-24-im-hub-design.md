# im-hub 跨境私域 IM 聚合工作台 — 设计文档

日期：2026-08-24
状态：已定稿，待实现计划

## 1. 目标

给跨境电商/私域运营团队一套自托管的多平台 IM 工作台，解决四件事：

1. **多平台多开** — 一个员工同时经营 Telegram / Signal / Zoom / WhatsApp 上的多个账号，互不串号
2. **多引擎翻译** — DeepL / OpenAI / Claude 自主切换，收到的消息自动译成中文，发出的中文自动译成客户语言
3. **团队管理** — 管理员分组带队，看得到组内员工的账号状态、客户档案与告警
4. **客户沉淀** — 聊天记录自动提炼客户档案，支持人工修改补充；关键词命中时提醒管理员，避免销售漏接关键信号

## 2. 非目标（明确不做）

- 浏览器指纹伪造 / 防关联
- AI 人设扮演、语音克隆
- 客户资产、投资账户、退休金等财务状况画像
- 多租户 SaaS（当前只服务单个企业，但表结构预留）

## 3. 角色与权限

单租户，四个角色：

| 角色 | 数据范围 | 配置权限 |
|---|---|---|
| `owner` | 全局 | 建账号、配平台、设关键词规则、决定员工能否收告警 |
| `auditor` | 全局**只读**，查阅原文强制写审计日志 | 无 |
| `manager` | 仅本人所带 team 内的员工 | 组内关键词规则 |
| `agent` | 仅本人 | 无 |

查询层统一 scope 过滤器：

```
agent    → WHERE owner_user_id = :me
manager  → WHERE team_id IN (SELECT team_id FROM team_members WHERE user_id=:me AND is_lead)
auditor  → 不过滤，但写 audit_logs
owner    → 不过滤
```

一个 manager 可带多个 team，一个 agent 只属于一个 team。

## 4. 系统架构

```
┌─────────────────┐        ┌──────────────────┐
│ desktop         │  WS    │ admin-web        │
│ (Electron)      │◄──────►│ (React SPA)      │
└────────┬────────┘        └────────┬─────────┘
         │  WebSocket + REST        │
         ▼                          ▼
┌──────────────────────────────────────────────┐
│ server (Node 24 + TypeScript + Fastify)      │
│  ├── adapters/  telegram signal zoom whatsapp│
│  ├── pipeline/  translate keyword summary    │
│  ├── rbac/      scope filter + audit         │
│  └── api/       REST + WS gateway            │
└───────┬──────────────────────┬───────────────┘
        ▼                      ▼
   PostgreSQL             Redis + BullMQ
```

部署：Docker Compose 一键起。服务端常驻，客户端离线不影响 Telegram/Signal/Zoom 收消息。

## 5. 平台适配器

统一接口，四种实现：

```ts
interface PlatformAdapter {
  readonly platform: Platform
  connect(account: AccountRecord): Promise<void>
  disconnect(accountId: string): Promise<void>
  sendMessage(accountId: string, conversationId: string, content: OutboundContent): Promise<string>
  onMessage(handler: (msg: NormalizedMessage) => void): void
  onStatusChange(handler: (accountId: string, status: AccountStatus) => void): void
}
```

### 5.1 Telegram — TDLib

- 一账号一 TDLib client 实例，实例池按 accountId 索引
- session 目录持久化到 `data/tdlib/<accountId>/`
- 登录：手机号 + 验证码，二次验证密码走客户端交互式输入
- 最干净的平台，用它验证整条链路

### 5.2 Signal — signal-cli（link 模式）

- signal-cli 以 daemon 模式运行，JSON-RPC over unix socket，一个 daemon 管多账号
- 接入流程：服务端 `startLink` → 得到 `sgnl://linkdevice?uuid=...&pub_key=...` → 渲染成二维码 → 员工手机 Signal 扫码确认
- **硬约束：linked device 拿不到关联之前的历史消息。** 客户档案必须标注「数据起始于 <关联日期>」，此前信息只能人工补充
- Signal 单账号最多 5 个 linked device，员工自己手机可能已占用若干

### 5.3 Zoom — OAuth + Webhook

- Zoom Marketplace 建 OAuth 应用，申请 Team Chat 相关 scope
- 服务端暴露 webhook 端点接收 `chat_message.sent` 等事件，需校验 Zoom 签名
- 发送走 Zoom REST API
- 注意：Zoom Team Chat 面向团队内部沟通，客户侧覆盖有限

### 5.4 WhatsApp — 客户端网页容器（唯一例外）

消息源在客户端，方向与其他三个相反：

```
web.whatsapp.com（WebContentsView，每账号独立 session partition）
      │ preload 注入抓取
      ▼
   desktop ──WebSocket──► server 归一化入库 ──► 同一条 pipeline
发送：server 下发指令 ──► desktop 注入执行
```

**两条必须接受的后果：**
1. 员工电脑关机时 WhatsApp 收不到消息，其他三平台照常
2. Meta 改版会打断消息抓取，需要跟进维护

**隔离要求：** 独立包 `adapters/whatsapp-webview`，坏掉不得影响其他平台。抓取选择器集中在一个 `selectors.ts`，改版时只改这一个文件。

## 6. 数据模型

```sql
-- 身份与组织
users(id, email, display_name, role, password_hash, created_at, disabled_at)
teams(id, name, created_at)
team_members(team_id, user_id, is_lead)

-- 平台账号（一个员工可有多个）
accounts(id, platform, owner_user_id, team_id, display_name,
         status, credentials_ref, linked_at, history_available_from, created_at)

-- 会话与消息
conversations(id, account_id, platform_conversation_id, contact_external_id,
              contact_display_name, last_message_at)
messages(id, conversation_id, account_id, platform, direction,
         sender_external_id, body, body_lang, media_refs jsonb,
         sent_at, ingested_at, raw jsonb)
message_translations(message_id, target_lang, provider, translated_text, created_at)

-- 客户档案
customer_profiles(id, conversation_id UNIQUE,
                  ai_summary jsonb,      -- 每次重算覆盖
                  manual_fields jsonb,   -- 人工填写，永不被覆盖
                  ai_generated_at, manual_updated_by, manual_updated_at)

-- 关键词告警
keyword_rules(id, scope_team_id NULL, pattern, match_type, severity,
              enabled, created_by, created_at)
alerts(id, message_id, rule_id, severity, status, acked_by, acked_at, created_at)
alert_permissions(user_id, granted, requested_at, decided_by, decided_at)

-- 审计
audit_logs(id, actor_user_id, action, target_type, target_id, detail jsonb, created_at)
```

所有业务表带 `team_id` 或可经 `account_id` 推导出 team，供 scope 过滤器使用。

## 7. 翻译网关

```ts
interface TranslationProvider {
  readonly name: 'deepl' | 'openai' | 'claude'
  translate(text: string, from: string | 'auto', to: string): Promise<TranslationResult>
}
```

- **选择粒度四级 fallback**：会话 → 账号 → 团队 → 全局默认。员工可在会话里自主切换引擎
- **缓存**：`sha256(text + from + to + provider)` → Redis，TTL 30 天，避免重复付费
- **自动降级**：主引擎超时/超额/报错时按配置顺序切下一家，记录降级事件，不阻塞发送
- **选型建议**：DeepL 处理欧洲语系性价比最高，作为默认；需要口语化改写或长上下文时切 Claude（`claude-sonnet-5`）
- API key 存服务端，客户端永不接触

## 8. 客户档案与摘要

### 8.1 字段

| 字段 | 说明 |
|---|---|
| `name` / `preferred_name` | 姓名、称呼 |
| `age_range` | 年龄段 |
| `location` / `timezone` | 居住地、时区 |
| `language` | 常用语言 |
| `occupation` | 职业 |
| `family` | 家庭情况 |
| `interests` | 兴趣偏好 |
| `category_preference` | 品类偏好 |
| `budget_level` | 预算区间 / 客单价水平 |
| `stage` | 决策阶段 |
| `next_followup_at` | 下次跟进时间 |
| `taboo_topics` | 禁忌话题 |
| `interaction` | 互动情况：首次接触、最近互动、消息频次、平均响应时长 |
| `notes` | 自由备注 |

### 8.2 AI 与人工物理分离

`ai_summary` 与 `manual_fields` 分两列存储。重算只写 `ai_summary`；读取时按字段名做 `manual_fields` 覆盖 `ai_summary` 的合并。UI 上每个字段标注来源（AI 推断 / 人工确认）。人工改过的字段永不被自动覆盖。

### 8.3 生成

- **触发**：会话静默 10 分钟后入队 + 每日兜底全量 + 手动「重新生成」按钮
- **模型**：Claude 结构化输出（JSON schema 约束），保证字段稳定
- **上下文**：取该会话最近 N 条消息（原文优先，缺失时用译文）
- **历史缺口**：`accounts.history_available_from` 有值时，prompt 中声明记录不完整，UI 提示员工手动补充

## 9. 关键词告警

- **匹配**：字面量规则统一编译成 Aho-Corasick 自动机（规则变更时重建）；正则规则单独逐条跑
- **命中**：写 `alerts`，按 severity 分级
- **通知对象**：
  - `manager`（本组）、`auditor`、`owner` 默认接收
  - `agent` 默认**不**接收；员工可在客户端提交「申请获取告警权限」，由 `owner` 审批，写入 `alert_permissions`
- **通道**：客户端 WS 实时推送 + 管理后台告警列表 + 可选邮件 / 企业微信 webhook
- **必须支持确认闭环**：`status` 从 `open` → `acked`，记录 `acked_by` / `acked_at`。没有闭环的告警列表两周后就没人看

## 10. 客户端界面

```
┌────────┬──────────────────────────┬─────────────┐
│ 账号   │  会话消息                │  客户档案   │
│ 列表   │  原文 / 译文双栏         │  AI 摘要    │
│ 多平台 ├──────────────────────────┤  + 人工编辑 │
│ 多开   │  智能输入区              │             │
│        │  中文输入 → 实时译 → 发  │  告警提示   │
└────────┴──────────────────────────┴─────────────┘
```

- 左栏按平台分组展示账号，显示在线状态与未读数
- 中栏消息支持原文/译文切换与并排两种模式
- 发送前展示译文预览，员工确认后发出
- WhatsApp 账号被选中时，中栏整块替换为 `WebContentsView`
- 右栏档案面板每个字段可就地编辑，编辑即写入 `manual_fields`

## 11. 错误处理与降级

| 故障 | 行为 |
|---|---|
| 翻译引擎不可用 | 按顺序降级到下一家；全部失败则发原文并标记「未翻译」 |
| TDLib 掉线 | 指数退避重连，账号状态置 `reconnecting`，客户端显示黄色状态点 |
| signal-cli daemon 崩溃 | 进程守护自动重启，重启后重新 attach 所有账号 |
| WhatsApp 注入失效 | 上报 `selector_mismatch` 事件，账号置 `degraded`，其他平台不受影响 |
| 摘要生成失败 | 保留上次 `ai_summary`，不清空；记录失败次数，连续 3 次告警 |
| Postgres 不可用 | 消息暂存 Redis 队列，恢复后回放，不丢消息 |

## 12. 测试策略

- **适配器层**：录制真实消息作为 fixture，离线回放做归一化断言。不依赖真实网络
- **pipeline**：翻译/关键词/摘要的核心逻辑写成纯函数，单元测试覆盖
- **翻译与摘要**：mock provider，断言调用参数与 fallback 顺序，不烧真实额度
- **RBAC**：scope 过滤器逐角色断言可见集合，这是安全边界，必须有测试
- **E2E**：Playwright + Electron，覆盖登录 → 选账号 → 收消息 → 翻译 → 发送 → 档案生成主链路

## 13. 交付阶段

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0** | 服务端骨架 + RBAC + Telegram 适配器 + 消息表 + 翻译网关 + 客户端基础 UI | 单个 Telegram 账号能收发并自动翻译，权限过滤生效 |
| **P1** | Signal 扫码接入 + 关键词监控 + 告警闭环 + 员工申请权限 | Signal 多账号在线，关键词命中推达管理员并可确认 |
| **P2** | 客户档案（自动 + 人工）+ 管理后台 + 审计日志 | 档案自动生成且人工编辑不被覆盖，auditor 查阅留痕 |
| **P3** | WhatsApp 网页容器 + Zoom 接入 | 四平台全部可用 |

P0 必须先跑通。Telegram 是四个平台里最干净的，用它验证「多开 → 入库 → 翻译 → 前端」整条链路，后面三个平台只是往同一个接口填实现。

## 14. 已知约束与风险

1. **Signal 无官方 API**，signal-cli 是社区项目，Signal 改协议时需跟进升级
2. **Signal link 模式无历史消息**，档案完整性依赖人工补充
3. **WhatsApp 网页容器违反其服务条款**，存在账号被封风险，且需跟随 Meta 改版维护
4. **员工通讯监控**需事先书面告知并取得员工同意（GDPR / 个人信息保护法 / 部分辖区的双方同意要求）。产品内置员工首次登录时的知情确认流程，确认记录写入 `audit_logs`
5. **TDLib 需编译原生模块**，需为目标平台预构建或提供构建镜像
