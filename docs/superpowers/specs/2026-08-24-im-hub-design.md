# im-hub 跨境私域 IM 聚合工作台 — 设计文档

日期：2026-08-24
状态：已定稿，待实现计划

## 1. 目标

给跨境电商/私域运营团队一套自托管的多平台 IM 工作台，解决四件事：

1. **多平台多开** — 一个员工同时经营 Telegram / Signal / Zoom / WhatsApp 上的多个账号，互不串号
2. **多引擎翻译** — DeepL / OpenAI / Claude 自主切换，收到的消息自动译成中文，发出的中文自动译成客户语言
3. **团队管理** — 管理员分组带队，看得到组内员工的账号状态、客户档案与告警
4. **客户沉淀** — 员工按会话维护客户档案；关键词命中时提醒当前有权限的内部接收人，避免销售漏接关键信号

## 2. 非目标（明确不做）

- 浏览器指纹伪造 / 防关联
- AI 人设扮演、语音克隆
- 客户资产、投资账户、退休金等财务状况画像
- 多租户 SaaS（当前只服务单个企业，但表结构预留）

## 3. 角色与权限

单租户，四个角色：

| 角色 | 数据范围 | 配置权限 |
|---|---|---|
| `owner` | 全局 | 建账号、配平台、维护全公司关键词规则、确认本人的告警 |
| `auditor` | 全局**只读**兼容角色 | 只读全公司告警流，不确认告警 |
| `manager` | 仅本人所带 team 内的员工 | 无规则配置权限；确认本人的告警 |
| `agent` | 仅本人 | 无规则配置权限；确认本人账号的告警 |

查询层统一 scope 过滤器：

```
agent    → WHERE owner_user_id = :me
manager  → WHERE team_id IN (SELECT team_id FROM team_members WHERE user_id=:me AND is_lead)
auditor  → 不过滤，只读
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
│  ├── pipeline/  translate keyword            │
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

### 5.4 WhatsApp — 官方网页壳与 Business Platform 双边界

> 2026-08-31 校正：本节原先提出的 preload/selector 抓取方案已废弃，不能作为实现依据。
> WhatsApp Business 条款明确限制未授权的抓取、逆向和交互应用；网页改版也不存在可维护的
> 消息事件合约。当前决定以 `2026-08-29-signal-whatsapp-parallel-checkpoint.md` 第 14 节为准。

两种账号必须显式分开：

1. `connection_mode=web_shell`：每账号一个隔离 Electron partition，只承载官方
   `web.whatsapp.com` 页面和页面内原生操作；不注入 im-hub preload、不读取 DOM、不声称有
   消息回传、翻译或中央归档。历史 `adapter` 账号暂时保留兼容，不在本轮批量改写。
2. `connection_mode=cloud_api`：未来统一消息链只能使用 WhatsApp Business Platform 官方
   Graph API、WABA Webhook 与 Embedded Signup。当前只预留连接模式，官方授权和 Webhook
   尚未实现时创建接口必须明确拒绝，不能生成假凭据或把浏览器 session 冒充 API token。

Cloud API 的账号身份以 WABA 与 phone-number id 为边界；入站消息使用 Webhook 的平台消息 id，
出站消息只接受 Graph API 成功响应返回的平台消息 id，并由后续状态 Webhook 按同一 id 更新。
不得复用 Telegram 临时 id 或 Signal sender/timestamp 规范键算法。

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

-- 客户档案（人工维护）
customer_profiles(conversation_id PRIMARY KEY,
                  name, age_location, occupation, family, interests, other,
                  revision, updated_by_user_id, created_at, updated_at)

-- 公司内部关键词告警（migration 0015）
keyword_rules(...)
keyword_alert_scan_jobs(...)
keyword_alerts(...)
keyword_alert_recipients(...)

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

## 8. 客户档案

### 8.1 字段

| 字段 | 说明 |
|---|---|
| `name` | 姓名、称呼 |
| `age_location` | 年龄、居住地 |
| `occupation` | 职业 |
| `family` | 家庭情况 |
| `interests` | 兴趣偏好 |
| `other` | 其他人工备注 |

### 8.2 人工资料是唯一权威来源

客户档案不分析聊天正文，也不调用模型自动生成。员工在当前内部会话右栏填写六个字段，保存时携带
`revision` 做乐观并发控制；发生冲突时保留员工实际修改并展示服务器最新值，不能静默覆盖其他人的更新。

### 8.3 维护与检索

- **触发**：员工显式点击“手动补充”并保存，不设后台自动任务
- **权限**：owner、当前带队范围内的 manager 和账号所有者可写，auditor 只读
- **检索**：独立档案库按相同 RBAC 范围搜索六字段、会话名称和账号名称，可按平台/账号筛选
- **范围**：不提供“自动提取”或“重新提取”入口，不因档案功能上传 WhatsApp Web 可见 DOM 正文

## 9. 关键词告警

M4-3 已实现公司内部关键词告警闭环，详细边界以
`docs/superpowers/specs/2026-09-03-m4-keyword-alerts-design.md` 为准：

- **规则**：只支持全公司字面量规则，由 `owner` 创建、编辑、启停和软删除；不支持团队级规则或正则。
- **消息入口**：只匹配进入中央 `messages` 表的新客户入站文字与后续有效正文编辑；不回扫历史，
  不匹配员工出站消息。WhatsApp Web 的 DOM 气泡不进入中央告警；配置并启用后的 WhatsApp
  Business Platform Cloud API Webhook 入站文字会参加匹配。
- **接收与确认**：所有 `owner`、账号所属团队的 lead `manager`、账号 owner 为 `agent` 时的本人，
  都保存各自独立的确认状态；`auditor` 有全局只读告警流，但不需要确认，也没有未确认徽标。
- **通道**：通过桌面 renderer 的 WebSocket 通用提示、列表和徽标形成应用内闭环；macOS 与 Windows
  使用相同行为。不调用操作系统通知、不播放声音，也没有点击告警跳转平台会话的 deep-link。
- **明确未实现**：邮件、企业微信 webhook、公开订阅、agent 申请/owner 审批告警权限均不存在。
- **数据**：`0015_keyword_alerts` 创建四张表，不读取旧消息或生成历史扫描任务。

当前用户告警接口为 `POST /api/keyword-alerts/search`、
`GET /api/keyword-alerts/unacknowledged-count`、
`PATCH /api/keyword-alerts/:id/acknowledge`。规则与异常扫描维护仅限 `owner`：
`GET /api/keyword-rules`、`POST /api/keyword-rules`、
`PATCH /api/keyword-rules/:id`、`DELETE /api/keyword-rules/:id`、
`POST /api/keyword-alert-scans/retry`。

## 10. 客户端界面

```
┌────────┬──────────────────────────┬─────────────┐
│ 账号   │  会话消息                │  客户档案   │
│ 列表   │  原文 / 译文双栏         │  人工档案   │
│ 多平台 ├──────────────────────────┤  手动维护   │
│ 多开   │  智能输入区              │             │
│        │  中文输入 → 实时译 → 发  │  告警提示   │
└────────┴──────────────────────────┴─────────────┘
```

- 左栏按平台分组展示账号，显示在线状态与未读数
- 中栏消息支持原文/译文切换与并排两种模式
- 发送前展示译文预览，员工确认后发出
- WhatsApp 账号被选中时，中栏整块替换为 `WebContentsView`
- 右栏档案面板提供显式“手动补充”，保存后写入结构化档案字段

## 11. 错误处理与降级

| 故障 | 行为 |
|---|---|
| 翻译引擎不可用 | 按顺序降级到下一家；全部失败则发原文并标记「未翻译」 |
| TDLib 掉线 | 指数退避重连，账号状态置 `reconnecting`，客户端显示黄色状态点 |
| signal-cli daemon 崩溃 | 进程守护自动重启，重启后重新 attach 所有账号 |
| WhatsApp 注入失效 | 上报 `selector_mismatch` 事件，账号置 `degraded`，其他平台不受影响 |
| Postgres 不可用 | 消息暂存 Redis 队列，恢复后回放，不丢消息 |

## 12. 测试策略

- **适配器层**：录制真实消息作为 fixture，离线回放做归一化断言。不依赖真实网络
- **pipeline**：翻译/关键词的核心逻辑写成纯函数，单元测试覆盖
- **翻译**：mock provider，断言调用参数与 fallback 顺序，不烧真实额度
- **RBAC**：scope 过滤器逐角色断言可见集合，这是安全边界，必须有测试
- **E2E**：Playwright + Electron，覆盖登录 → 选账号 → 收消息 → 翻译 → 发送 → 手动保存档案主链路

## 13. 交付阶段

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0** | 服务端骨架 + RBAC + Telegram 适配器 + 消息表 + 翻译网关 + 客户端基础 UI | 单个 Telegram 账号能收发并自动翻译，权限过滤生效 |
| **P1** | Signal 扫码接入（关键词告警后续由 M4-3 独立交付） | Signal 多账号在线 |
| **P2** | 人工客户档案库 + 管理后台 | 档案人工保存、冲突保护、RBAC 检索与只读角色可用 |
| **P3** | WhatsApp 网页容器 + Zoom 接入 | 四平台全部可用 |

P0 必须先跑通。Telegram 是四个平台里最干净的，用它验证「多开 → 入库 → 翻译 → 前端」整条链路，后面三个平台只是往同一个接口填实现。

## 14. 已知约束与风险

1. **Signal 无官方 API**，signal-cli 是社区项目，Signal 改协议时需跟进升级
2. **Signal link 模式无历史消息**，档案完整性依赖人工补充
3. **WhatsApp 网页容器违反其服务条款**，存在账号被封风险，且需跟随 Meta 改版维护
4. **员工通讯监控**需事先书面告知并取得员工同意（GDPR / 个人信息保护法 / 部分辖区的双方同意要求）。当前没有审计表或知情确认存储，上线前必须另行完成合规设计与实现
5. **TDLib 需编译原生模块**，需为目标平台预构建或提供构建镜像
