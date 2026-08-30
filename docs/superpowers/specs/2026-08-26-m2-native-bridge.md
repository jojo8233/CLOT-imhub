# M2 原生客户端宿主与消息桥接

日期：2026-08-26
状态：通用协议与宿主已实现；Telegram/Signal/WhatsApp 平台接线分别属于 M3/M5/M6

跨对话恢复与当前 Git/PR 状态见
`../plans/2026-08-26-m2-native-bridge-handoff.md`。

## 1. 范围

M2 只建立平台无关基础，不宣称任何一个平台已经完成原生闭环：

- Electron 受控宿主基础与受控 guest preload（不是完整生产授权闭环）
- 当前会话、原生草稿与原生发送命令
- 入站、出站、编辑、删除和消息 id 重映射事件
- 服务端账号归属校验、归一化、去重和长期存档入口
- 固定翻译输入坞的 translating / ready / sending / failed 状态

Telegram fork 在 M3 实现协议适配并做真实多开、媒体、发送和存档验收。现有 TDLib
与 signal-cli 适配器继续保留为后台归档/回退链路，不能因通用入口已经存在就退出。
用户界面已经只有原生会话入口，不存在“自绘工作台与原生客户端同时给用户使用”的
双 UI。M3-4 已让 telegram-tt 发消息事件；TDLib 与原生链路现在可能形成双来源，服务端按
canonical key 幂等处理，但真实 fixture/shadow 对账尚未完成，不能提前宣称没有重复风险。

## 2. 协议

协议定义集中在 `packages/shared/src/native-bridge.ts`。M2 初始版本为 1；M3-1 升级到版本 2，
引入 canonical Telegram ID、`account.identity`、发送 `attemptId` 与单调 `editVersion`。
M3-4 当前版本为 3，新增 `outbox.status` 的非敏感队列指标；详细规则分别见
`2026-08-26-m3-telegram-message-identity.md`、`2026-08-26-m3-account-control.md` 与
`2026-08-27-m3-telegram-outbox.md`。

guest → host：

- `bridge.ready`
- `account.identity`（v2）
- `account.signed-out`（M3-2）
- `context.changed`
- `composer.state`
- `command.result`
- `bridge.error`
- `outbox.status`（v3）
- `message.upsert`
- `message.deleted`
- `message.id-remapped`

host → guest：

- `bridge.request-state`（M3-3，账号授权完成后请求重发当前 context/composer 事实）
- `composer.set-draft`
- `composer.get-draft`
- `composer.send`
- `event.ack`

草稿命令带 `requestId` 与 `contextRevision`；v2 的 `composer.send` 另带稳定
`attemptId`。会话改变后旧 revision 的结果必须拒绝，
避免异步翻译或发送落到后来打开的会话。消息事件带稳定 `eventId`；服务端失败时
外壳回 `event.ack { accepted: false, retryable: true }`，补丁客户端以同一 eventId 重试。

协议明确区分：

- `platformConversationId`：平台客户端使用的会话标识
- `conversationId`：服务端 `conversations.id` UUID

两者不能共用字段或互相猜测。

Issue #5 中“上报 accountId 与 conversationId”的安全落地是：guest **不自报 accountId**；
host 按事件所属常驻 webview 绑定 accountId，guest 只上报 `platformConversationId`，再由
服务端校验 owner 后解析内部 `conversationId`。这三个值的来源不能合并成页面自报字段。

`platformMessageId`、reply id、delete id 和 remap 两端都是**账号范围内稳定且唯一**的
规范消息键。平台原始 id 若只在会话内唯一，必须把规范 conversation/chat id 编入键中，
所有消息来源必须使用同一算法。Telegram 当前 TDLib `message.id` 与 telegram-tt MTP id
编码不同且都带 chat-local 语义；M3-1 已实现同一 `chatId:serverMessageId` 算法与
`0005` 历史迁移，真实账号 fixture 和 shadow 对账仍是后续验收项。alias 只处理同一规范
体系内的临时/最终 id，
不能替代跨来源规范化。

## 3. Electron 安全边界

- 主进程在 `will-attach-webview` 再次校验 URL origin 和
  `persist:native-<accountId>` partition，并强制 guest WebPreferences 与默认拒绝权限。
- 主进程强制指定 `out/preload/native-bridge.mjs`，并保持 guest 的
  `nodeIntegration: false`、`contextIsolation: true`。
- 新受控 preload 只新增 `window.imHubNativeBridge`，不通过该接口暴露 `ipcRenderer`、
  Node.js、外壳 `window.imHub`、用户 JWT 或 control grant。
- guest 上报不包含 `accountId`。主进程根据事件来自哪个常驻 webview 绑定账号，并用
  服务端签发的五分钟 grant 实时复核 owner、账号撤销版本，以及 Telegram self user id 或
  Signal ACI。
- manager/auditor 的“可见”范围不等于可操控平台账号。当前桥接只接受实际账号归属人。
- 非白名单主框架导航被阻止；新窗口只允许交给系统打开 http/https 链接。

M3-2 已删除 Telegram fork 的 `window.__IM_HUB__` 和 `executeJavaScript` JWT 注入。气泡
翻译与语言检测改由 guest preload → 主进程 → 服务端的窄代理完成。主进程在开放能力前
核对短时 grant、partition/account 绑定和 guest 实际 Telegram self user id；过期、撤销、
不匹配与退出都会阻断并显示明确状态。生产构建仍不显示 guest DevTools。

## 4. 服务端入口与存储

- `POST /api/native/context`：把平台会话解析/upsert 成内部会话 UUID
- `POST /api/native/events`：接收消息 upsert、删除和 id remap

服务端从已校验账号行取得真实 platform，不接受客户端自报 platform。新增 migration
`0004_native_bridge_message_events`：

- `messages.reply_to_platform_message_id`
- `messages.edited_at`
- `messages.deleted_at`
- `message_id_aliases`

`message_id_aliases` 保留临时 id 到规范消息行的映射。即使 remap 后还有迟到事件继续带
临时 id，也会命中同一个 `messages.id`。平台确认编辑后旧译文删除，并使用带编辑 revision
的新 BullMQ job id 重新翻译；译文在消息行锁下复核 revision 后才写入，WebSocket 消费端
也会拒绝迟到的旧 revision。消息生命周期先按账号在单进程内排队，再以 PostgreSQL
transaction advisory lock 覆盖多实例；发布前在行锁内重读规范消息与当前译文，避免旧
事件覆盖新编辑。纯媒体消息存档但不派发空正文翻译。

v2 消息事件已增加单调 `editVersion`，数据库和翻译 revision 只接受更大的版本；旧适配器
仍可传 null 并回退到 `editedAt`。M3-4 已把 Telegram edit update 的 MTProto `pts` 写入
telegram-tt outbox；真实快速连续编辑仍要在 M3-4 故障矩阵和 M3-5 对账后才能宣称闭环。

## 5. 输入坞状态与隔离

外壳草稿按 `accountId + conversationId`（服务端 UUID）存放。只有同时满足以下条件才启用：

1. 当前平台有明确账号
2. bridge 已报告 ready
3. 原生客户端已报告当前会话
4. 服务端已解析出内部 conversation UUID

翻译完成后用 `composer.set-draft` 写入原生输入框。发送前先用 `composer.get-draft`
读取员工修改后的最终文本，再调用 `composer.send`；外壳不会拿缓存译文直接调用旧适配器
发送接口。失败保留草稿并显示错误，无会话或桥接断开时禁止发送。

`composer.send` 的 8 秒超时是“结果未知”，不是确定未发送。M3-3 已让 Telegram guest 按
稳定发送 attempt id 缓存结果；外壳在未知后直接以同一 attempt 查询，不依赖已经清空的
原生输入框，也不会生成第二次发送。页面崩溃后的持久恢复仍属于后续 outbox 阶段。

## 6. 验证

- `pnpm typecheck`
- `pnpm test`：30 个测试文件通过，289 passed，1 个既有 todo
- `pnpm --filter @im-hub/desktop build`
- 定向覆盖：协议版本、旧 revision、草稿隔离、owner/manager/auditor 权限、编辑、删除、
  临时 id remap、迟到事件去重和纯媒体消息

## 7. M3 接线清单

Telegram fork 接线状态：

- M3-3 已在 chat/topic 变化时发送 `context.changed`，并以单调 revision 拒绝旧命令
- M3-3 已把原生 rich editor/handleSend 映射到三个 composer 命令
- M3-4 已让收发、编辑、删除和最终 id 事件进入 IndexedDB 持久 outbox；详细语义见
  `2026-08-27-m3-telegram-outbox.md`
- M3-4 只有收到 `event.ack` 后才从 pending outbox 移除事件，永久拒绝进入 dead-letter
- M3-3 已删除 fork 内部旧 `ImHubComposer`，TranslationDock 是唯一翻译入口
- M3-1 已统一 TDLib/fork 的 `chatId:serverMessageId` 规范键并提供历史迁移；开始
  shadow 前仍要用真实 fixture 和账号验证同一消息只落一行，再决定旧后台链路退出时机
- M3-3 已用稳定 attempt id 和最终 Telegram update 解决 Composer 发送幂等；M3-4 的 message
  outbox 按 Telegram self user id 单飞并有界限流
- M3-2 已完成短时 account-control grant、实际平台账号身份绑定与 guest JWT 移除
- M3-2 已完成 Telegram 退出/账号删除时对应本地 partition 与 bridge 能力清理

## 8. M5 Signal 入站消息接线

Signal Desktop 不能复用 `<webview>` attach 流程；补丁版 Signal 主进程把原生 renderer 放在
同窗口 `WebContentsView` 后，显式将其 webContents 注册进同一个 `NativeControlHost`。guest
仍不自报 im-hub `accountId`，只上报实际 Signal ACI；服务端 owner-only grant 首次绑定
`native_desktop` 账号的实际 ACI，registry 必须同时匹配注册的 WebContents、账号和 ACI 才转发。

第一阶段从 Signal 自身持久化后的 `ConversationModel.onNewMessage` 产生入站文字、图片和贴纸
`message.upsert`。图片读取 `attachments[]`，贴纸读取独立 `sticker` 字段；桥内只保留类型、
文件名、MIME、大小和由本地消息 id + 槽位生成的稳定 `remoteId`，不读取或导出本机路径、附件
密钥、pack key 或二进制。视频、音频和文件尚未接入，包含这些附件的消息整条拒绝，不能只落
caption。单条消息归一化错误只产生可见的非致命提示，下一条成功事件继续正常处理。

Signal Desktop 与 signal-cli 共用 `u:` / `g:` 会话键和
`<normalized-sender>:<sent-at-ms>` 消息键，服务端拒绝非规范键并沿用数据库唯一约束。事件用
稳定 `eventId` 先写入专用 IndexedDB，再严格顺序重试到 `event.ack`；接受后删除，永久拒绝进入
有界 dead-letter，存储和容量故障经非敏感 UI 提示。自动化已覆盖 outbox 对象重建后的同键重放，
真实 Signal 进程重启后的未 ACK 恢复也已通过隔离 503 故障取证。图片/贴纸结构化元数据代码与
自动化已完成，真实入站唯一落库仍待续验；附件二进制、其他媒体、编辑/删除/回应、
context/composer 和翻译仍未接线。
