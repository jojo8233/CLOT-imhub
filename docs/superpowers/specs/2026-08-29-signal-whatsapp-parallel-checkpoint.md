# M5/M6 Signal 与 WhatsApp 并行首检点

日期：2026-08-29
状态：执行中；Signal 约定的原生与双语门槛已通过；WhatsApp Cloud API 纯文字双语链已完成
代码与自动化，仍等待 Meta 应用、公开 HTTPS Webhook 与最多一条无敏感文字的真实续验

> 续接校正：本文件最初定义的 signal-cli 文字首检点保留为后台基线与回退证据。
> 用户明确要求图片与贴纸能力后，用户可见入口已切到 Signal Desktop 8.25.0；当前实现
> 与安全边界以 `2026-08-25-native-client-pivot.md` 的最新段落为准。

## 1. 决策

Signal 与 WhatsApp 的使用优先级高于继续等待 Telegram 的生产观察周期，因此两条接入
路线从本 checkpoint 起并行开发。Telegram M3 已完成的真实矩阵和 shadow 证据保持原样，
后续 7 天观察与 canary 仍是独立门槛；启动 M5/M6 不表示这些门槛已经通过。

本 checkpoint 只回答两个最小问题：

1. Signal 的后台 signal-cli 基线能否完成文字归档，以及用户可见 Signal Desktop 能否保持
   原生文字、图片和贴纸能力；两条账号模式必须显式隔离。
2. WhatsApp 官方 Web 能否在 Electron 中按 im-hub 账号使用独立持久 partition 完成扫码、
   保持登录、多账号切换和页面内真实文字收发。

## 2. Signal 首检点边界

- 继续保留 `packages/server/src/adapters/signal/`，不删除或伪装成 Signal Desktop；它只接管
  `connection_mode=adapter` 的账号。
- 用户可见会话入口使用补丁版 Signal Desktop。`connection_mode=native_desktop` 的账号只在
  服务端登记归属与 UUID，profile 和同窗口 `WebContentsView` 由 Signal Desktop 基座进程托管，
  不触发 signal-cli 鉴权。
- 原生窗口第一阶段保持 Signal 自身的文字、图片与贴纸能力；入站文字、图片/贴纸结构化元数据、
  编辑、删除和回应桥接及真实唯一落库均已通过。当前会话与原生草稿读写已接入既有 control
  grant；自动发送、附件二进制、其他入站媒体、正式多开与安装包仍属于后续 M5。
- 启动真实测试前必须明确验证本机 `signal-cli` 与所需 Java 运行时。不得因为命令缺失让账号
  无限停在“待登录”而没有诊断。

## 3. WhatsApp 首检点边界

- 只加载精确来源 `https://web.whatsapp.com`，每个 im-hub 账号使用
  `persist:native-<accountId>`；只有账号 owner 能挂载和操控该页面。
- 官方页面不注入 `native-bridge` preload，不注册 control grant，也不能调用 im-hub API。
  页面仍禁用 Node integration，保持 context isolation、web security 和默认拒绝权限。唯一例外是
  精确 `https://web.whatsapp.com` 主框架的 `persistent-storage`：WhatsApp 登录后同步依赖该
  durable-storage 请求；相机、麦克风、通知、剪贴板、第三方 iframe 和其他来源仍拒绝。
- 宿主只把官方页面加载成功视为“壳可用”，不能据此声称 WhatsApp 已登录或服务端已连接。
  登录状态当前由页面本身显示，二维码也只在官方页面中出现。WhatsApp 登录后可能让
  Electron 的 `webview.isLoading()` 长时间保持 `true`；shell-only 宿主以 webContents 已附着且
  精确 origin 匹配作为可显示条件，让官方页面自行呈现同步进度，不能用全局 loading 标志
  生成 20 秒失败遮罩。
- 账号删除时 Electron 清理对应 partition，并提醒用户在手机“已关联设备”中移除会话。
- 本 checkpoint 只测试官方页面中的文字收发和多开。没有统一消息回传、中央存档、翻译、
  客户档案跟随、审计、告警、媒体桥接、发送确认、去重或故障重放。

## 4. 进入下一 checkpoint 的门槛

Signal 至少取得一个真实账号的：二维码关联成功、冷启动自动恢复、入站文字唯一落库、从
im-hub 发出文字且手机端收到、服务重启后继续收信。WhatsApp 至少取得两个独立测试账号的：
二维码登录、冷启动保持、账号切换不串会话、双向文字收发，以及删除其中一个账号后仅清理
对应 partition。

Signal 的独立 profile、同窗口承载、原生发信矩阵、入站文字唯一落库、真实未 ACK 跨进程重放、
入站图片/贴纸结构化元数据、编辑/删除/回应以及当前会话/原生草稿真实续验均已完成。Signal
纯文字自动发送的 attempt 账本、最终消息 ID 确认代码和 a24 测试包已经完成。a24 的唯一一条
无敏感文字已真实送达，但成功后的 ACK 状态回放让翻译坞误显示“操作失败”；a25 已修复并通过
自动化，尚未补发第二条，因此完整 UI 验收仍保持开放。WhatsApp
先确定可维护且合规的身份/消息事件边界，再决定补丁客户端或
其他受控方案。没有这层设计与服务端 owner 复核前，禁止给官方 WhatsApp 页面注入 Telegram
的通用 preload，也禁止用 DOM scraping 冒充稳定消息协议。

## 5. 最新续验 checkpoint（2026-08-30）

- 外部无边框窗口覆盖方案已由用户明确判定“不算内嵌”，运行时代码已移除。
- Signal Desktop 8.25.0 现在用自身 Electron 43.4.1 进程承载 im-hub 主窗口；Signal renderer
  是同一窗口内容区内的 `WebContentsView`，不是 `<webview>`，也不是第二个 OS 窗口。
- 已复用一个隔离真实账号完成：钥匙串授权、冷启动恢复、Telegram → WhatsApp → Signal 往返
  切换、原生文字发送、原生图片发送、原生贴纸发送；用户截图确认顶栏、功能区和客户栏保持
  在同一 im-hub 窗口。
- 当前只支持一个 Signal Desktop 原生账号；入站文字、图片/贴纸结构化元数据及编辑/删除/回应
  均已取得真实证据；当前会话与可见原生草稿写入也已真实续验。纯文字自动发送的唯一一条真实
  消息已送达并确认最终结果；a24 暴露的成功态 UI 竞态已在 a25 修复并自动化验证，但未再发消息。
  附件二进制与其他入站媒体仍未完成。
  持久 outbox 实现、空队列初始化与
  真实未 ACK 消息跨进程重放均已通过，但仍不能越级标记 M5 完成。
- WhatsApp 已完成官方页面登录与可见性首检；继续沿用已登录 partition，不重复扫码矩阵。

续接时只做 Signal 当前会话同步与翻译写入原生草稿真实续验；不要重做上述窗口切换、原生文字/
图片/贴纸发送矩阵、任何已通过的入站生命周期或未 ACK 跨进程重放矩阵。

## 6. Signal 入站文字桥接实现 checkpoint（2026-08-30）

本轮从 `539fb7e` 复用既有隔离 worktree 续接，没有重做三平台切换和 Signal 发送矩阵。
实现边界如下：

- Signal Desktop 8.25.0 的原生 preload 在 `ConversationModel.onNewMessage` 完成自身持久化后
  触发受控 hook；补丁包装 Signal 实际通过 `contextBridge` 暴露的 `startApp`，先安装 im-hub
  bridge 再启动 Signal renderer，避免在 preload 返回后替换函数而错过真实调用方。
- Signal guest 不上报 im-hub `accountId`、JWT 或 control grant。Signal 的
  `WebContentsView` 由主进程绑定账号 UUID；guest 只上报实际 ACI。服务端 owner-only grant
  首次把该 ACI 绑定到 `connection_mode=native_desktop` 账号，主进程随后继续用实际
  WebContents 与 grant 中的 ACI 逐次匹配。
- Signal Desktop 与 `signal-cli` 共用 `packages/shared/src/signal.ts` 的规范身份算法。私聊
  会话键为 `u:<normalized-aci>`，群会话键为 `g:<group-id>`，消息键为
  `<normalized-sender>:<sent-at-ms>`；服务端拒绝非规范键、入站私聊发送者不匹配和 Signal
  remap，数据库仍按 `(account_id, platform_message_id)` 幂等落库。
- 本 checkpoint 当时只桥接 `type=incoming` 且正文非空的纯文字 `message.upsert`；第 8 节已在
  同一事件边界上增加图片/贴纸结构化元数据，第 9 节又从 Signal 自身持久化函数接入编辑、删除
  和普通回应，第 10 节接入当前会话与原生草稿读写。所有边界均来自 Signal 自身状态或 action，
  不能从 Signal DOM 推断或伪造。
- 事件使用稳定 `eventId`，先按实际 Signal ACI 写入专用 IndexedDB，再严格顺序重试到
  `event.ack`。接受后删除，永久拒绝进入最多 1000 项的 dead-letter；pending 也最多 1000 项。
  存储、容量和永久失败只显示非敏感状态，不把正文或 ACI 暴露给外壳。

自动化证据已通过：`pnpm typecheck`、47 个测试文件（419 项中 418 passed、1 todo）、desktop build，
以及新生成开发包的补丁锚点计数与严格 codesign 校验。同窗口开发包已完成外壳会话冷恢复。

真实续验证据也已通过：修正版开发包依次确认 `startApp called → preload import installed →
integrated guest registered`，实际 ACI 首次绑定与 grant verify 成功；随后由另一个 Signal 联系人
向当前账号补发一条纯文字，服务端只接受一次 `/api/native/events` 并回 ACK。只读数据库计数为桥接行 1、
重复规范键 0、入站行 1、规范键格式行 1，未读取正文、ACI 值或具体消息键。因此“Signal 入站
文字唯一落库”门槛已完成；其后的未 ACK 跨进程续收取证见第 7 节。

## 7. Signal 入站持久 outbox 实现 checkpoint（2026-08-30）

- `ConversationModel.onNewMessage` 的补丁 hook 等待标准事件写入 IndexedDB 后才返回，关闭了
  fire-and-forget 写入尚未完成时进程退出的丢失窗口。存储不可用时 Signal 原生客户端仍可启动，
  但入站 bridge 明确显示“持久消息队列不可用”。
- outbox 每次只发送队首事件；发送前持久化 attempt 和下次重试时间，ACK 超时或可重试拒绝使用
  有界指数退避。接受后删除 pending；永久拒绝先写 dead-letter 再删 pending，避免跨存储崩溃时
  先删后丢。人工重试同样先恢复 pending 再删失败副本。
- 新增自动化覆盖同一持久 storage 上销毁/重建 outbox 后沿用原 `eventId` 重放、ACK 删除、
  permanent rejection、dead-letter 恢复和重复入队。`pnpm typecheck`、47 文件 418 passed / 1 todo、
  desktop build、Signal 8.25.0 补丁锚点和严格 codesign 均通过。
- a15 隔离包复用既有已关联 profile 后，外壳会话、Signal grant/verify 和空队列 IndexedDB 初始化
  正常，未显示存储、容量或 dead-letter 故障。a16 又补齐始终可见的非敏感底栏状态、dead-letter
  重试/清除命令目标并通过启动与 grant/verify；没有重复平台切换或原生发送矩阵。
- a17 故障探针只把 Signal 的 `POST /api/native/events` 改为临时 503，其他请求代理到既有 4000；
  Telegram 继续直连 4000/1234。另一个 Signal 联系人发来一条纯文字后，同一事件持续命中 503，
  随后优雅退出 a17 并打开正常 a16。a16 跨进程恢复该 pending，4000 只接受一次事件并回 200；
  一个 ACK 超时窗口内没有第二次回传。
- 只读聚合数据库核验为最近 Signal 行 1、入站行 1、非规范消息键 0、重复键组 0；未读取正文、
  ACI、profile 或具体消息键。因此真实未 ACK 消息跨 Signal 进程退出/重开的持久重放与唯一落库
  门槛已经完成。

## 8. Signal 入站图片/贴纸结构化桥接 checkpoint（2026-08-30）

- 以 Signal Desktop 8.25.0 自身类型为边界：普通媒体来自 `message.attachments[]`，贴纸来自
  独立 `message.sticker`。只接受 `image/*` 普通附件和贴纸；无正文的纯图片/贴纸也会生成
  `message.upsert`。
- `mediaRefs.remoteId` 仅由 Signal 本地消息 id 与消息内 `attachment:<index>` / `sticker`
  槽位构成。事件只可携带 kind、文件名、MIME 和非负大小，不读取或导出 `path`、`localKey`、
  附件 key、pack key、cdn 字段或二进制数据。
- 消息规范键、`eventId`、实际 ACI 分区、IndexedDB outbox、ACK 和服务端数据库唯一约束均沿用
  已续验文字链路，因此同一消息重放仍应命中 `(account_id, platform_message_id)` 唯一边界，
  不为每个附件额外制造消息行。
- 视频、音频、文件或媒体结构异常会整条拒绝，避免带 caption 的消息只落正文形成不完整存档。
  这类单条消息错误在底栏显示非致命提示，不撤销 control grant；下一条成功事件会清除提示。
- 自动化已覆盖图片无正文、贴纸、稳定槽位、路径/密钥/二进制不泄露、缺本地消息 id、未支持
  媒体整条拒绝、非致命错误分类及提示不被身份心跳提前清除。`pnpm typecheck`、47 文件
  423 passed / 1 todo、desktop build、a18 补丁打包与严格 codesign 均已通过。
- a18 真实补发前的原生 Signal 聚合为 3 行、全部入站、图片 0、贴纸 0、重复键组 0。另一个
  Signal 联系人各补发一张无正文图片与一个贴纸后，聚合精确变为 5 行、图片 1、贴纸 1；超过
  10 秒 ACK 窗口后计数不变，非规范键、重复键组、不稳定媒体引用以及 `path`、`localKey`、
  `key`、`packKey`、`data`、`cdnKey` 禁止字段计数均为 0。核验未读取正文、联系人、ACI、
  具体消息键或媒体引用。
- 因此图片/贴纸结构化元数据的真实唯一落库门槛已经完成；附件二进制仍未回传，不能声称附件
  内容已归档或可预览。

## 9. Signal 入站编辑/删除/回应实现 checkpoint（2026-08-30）

- 以 Signal Desktop 8.25.0 自身持久化点为边界：编辑 hook 位于 `saveEditedMessage` 成功之后，
  删除 hook 位于删除目标与消息缓存保存之后，普通回应 hook 位于回应数据库与目标消息缓存处理
  之后；story 回应不在本 checkpoint。准备脚本继续要求每个精确锚点唯一命中，否则拒绝打包。
- 编辑只接收 `type=incoming`，沿用原 sender + 原 `sent_at` 规范键，当前正文/媒体成为新的
  `message.upsert` 快照，`editMessageTimestamp` 写入 `editedAt`。Signal 毫秒时间戳超过共享 int32
  `editVersion` 上限，因此保持 `editVersion=null`，由服务端现有 `editedAt` 单调条件拒绝旧编辑。
- 为所有人删除只接收入站目标；删除事件携带原规范消息键和 `deleteServerTimestamp`。原消息尚未
  落库时服务端按幂等已删除接受；不会伪造正文或从删除模型导出其他字段。
- 回应以 Signal 自身的 `targetAuthorAci + targetTimestamp` 生成目标规范键，回应者从 sender
  conversation 的平台身份取得，绝不使用本地 `fromId`。本账号产生的回应和 story 回应不进入
  入站链路；`emoji=null` 表示删除回应。
- migration `0009_message_reactions` 按 `(account, target, reactor)` 保存唯一当前态，允许回应先于
  目标消息到达，并只接受更晚的 `reacted_at`。删除墓碑会阻止迟到旧新增复活。回应事件继续先入
  Signal IndexedDB outbox，再由相同 ACK/dead-letter 机制送达服务端；没有读取或回传 profile、
  本地会话 UUID、密钥或消息正文以外的模型字段。
- 自动化覆盖规范键、编辑空正文、删除目标时间匹配、回应添加/删除、本账号回应过滤、本地字段
  不泄露、协议有界校验、平台拒绝、回应先于目标消息、不同回应者隔离、墓碑与乱序重放。开发库
  与隔离测试库 migration 已成功；`pnpm typecheck`、47 文件 431 passed / 1 todo、desktop build
  均通过。a19 的普通消息、编辑、删除、回应四个补丁各唯一命中并通过严格 codesign；真实 Signal
  客户端矩阵和只读聚合核验仍待完成，因此不能写成已真实验收。
- a19 首次回应续验暴露了真实边界：同一外部联系人短时间内产生 4 个不同目标的回应事实，中央表
  保持 4 个唯一键、规范键异常 0、重复组 0；随后移除一个回应时却仍为活跃 4、墓碑 0。为覆盖
  平台可能把移除与原新增折叠到同一 revision 的情况，中央 upsert 改为“更晚事件胜出；时间相同
  时墓碑胜出”，同时间旧新增不能再复活墓碑，并增加只记录 add/remove 已写入 outbox 的脱敏主进程
  标记。a20 已通过该数据库回归、类型检查、四个补丁唯一命中和严格 codesign。
- a20 真实续验已关闭上述缺口：桥接启动链完整出现，另一 Signal 账号新增回应后收到脱敏 add
  persisted 标记，中央表从 4 个活跃唯一键变为 5；移除同一回应后收到 remove persisted 标记，
  总行数保持 5、活跃降为 4、墓碑增为 1、重复键为 0，ACK 窗口后仍稳定。入站删除也按两阶段
  实测：新纯文字先唯一落库，再由发送方执行“为所有人删除”，Signal 原生账号范围内总行数保持
  9、删除标记从 0 增为 1、重复键与非规范键均为 0；ACK 窗口后消息 9（编辑 1、删除 1）、
  回应 5（活跃 4、墓碑 1）且两类重复均为 0。续验期间未重启 Telegram 或服务端，也未重复已通过
  的平台切换及 Signal 文字、图片、贴纸发送矩阵。

## 10. Signal 当前会话与原生草稿桥接 checkpoint（2026-08-30）

- 当前会话只读取 Signal Desktop 8.25.0 的 Redux `nav.selectedLocation`；仅 `Chats` 页接受
  `details.conversationId`，再由 `ConversationController` 取得会话模型。外壳只收到规范化后的
  `u:<peer>` / `g:<group>` 平台身份与展示名，本地 ConversationModel id 不跨出 guest。
- guest 订阅 Signal 自身 Redux store，并以 250ms 轮询作为恢复兜底。只有平台会话实际变化时才
  增加 `contextRevision`；外壳拒绝倒退 revision 和同 revision 复用，服务端又对 Signal 私聊/
  群聊会话键与联系人身份做规范匹配后才 upsert 会话。异步同步结果仍按 revision 收敛，不能覆盖
  已切换的新会话。
- `composer.get-draft` / `composer.set-draft` 已开放。写入先用 Signal 自身的
  `reduxActions.composer.setComposerFocus`，再调用 Signal 8.25.0 `CompositionInput` 已有的
  `inputApi.setContents`；其原生 `onEditorStateChange` 路径继续负责持久化，不查询或直接操作
  contenteditable DOM。写入前、聚焦后和确认期间都会重验会话，切换会话时旧命令明确失败。
  草稿最多 1,000,000 字符；可见编辑器正文与 ConversationModel 持久草稿必须在 500ms 内同时
  确认相同文本，否则按失败处理，不能再把“只改模型、可见输入框仍为空”报告成成功。
- `composer.send` 继续返回 `signal_send_not_enabled`，`composer.state.canSend` 始终为 false；本轮只
  把翻译结果写入原生输入框，由客服核对后在 Signal 中手动发送，不引入未具备 attempt 幂等的
  自动发送。
- 打包脚本要求 Signal 8.25.0 的原生草稿 action、Composer 聚焦 action 和可见
  `CompositionInput.inputApi` 锚点各唯一命中，否则拒绝生成测试包。初版自动化通过
  `pnpm typecheck`、49 个测试文件（441 passed、1 todo）和 desktop build；可见编辑器修正又通过
  32 项定向测试、typecheck 与 desktop build，新增“模型变化但可见编辑器不变必须失败”回归。
- a21 首次真实打开暴露 Signal 分支只渲染开发说明条、漏挂翻译坞；a22 修复布局后又暴露旧实现
  只更新 ConversationModel、可见编辑器仍为空，虽然脱敏日志错误报告写入成功。两处都没有当成
  验收证据。a23 改用可见 `CompositionInput.inputApi` 并执行双重确认，生成后通过
  `codesign --verify --deep --strict`。
- a23 真实续验完整出现 `startApp called → preload import installed → integrated guest registered`；
  用户在已同步的当前 Signal 会话输入一条无敏感中文临时文本并点击翻译，目视确认译文出现在同一
  Signal 原生消息输入框，随后出现一次脱敏 `native draft written` 标记。续验没有自动发送消息，
  没有读取或记录译文、ACI、本地会话 id、profile 或 token，也没有重启 Telegram 或服务端、重复
  已通过的平台切换、发送、入站生命周期或 outbox 故障矩阵。因此当前会话同步与可见原生草稿写入
  门槛已经完成；`composer.send` 仍未开放。

## 11. 新会话续接 checkpoint（2026-08-30）

- 继续使用隔离 worktree `/private/tmp/im-hub-m3-outbox` 和分支
  `codex/m5-m6-signal-whatsapp`。交接时 worktree 干净；本轮提交依次为：
  `1dadbfd`（当前会话/草稿桥接）、`a1809fa`（Signal 显示翻译坞）、`c871e3a`（可见
  CompositionInput 双重确认）、`21883d6`（a23 真实证据）。不要另建 worktree 或回退这些提交。
- 自动化基线为 `pnpm typecheck`、49 个测试文件 441 passed / 1 todo、desktop build；最后的可见
  编辑器修正另通过 32 项定向测试、desktop build 和 a23 deep/strict codesign。a23 真实写入已通过
  并已停止。Signal 可能在下次启动时恢复本轮未发送的测试草稿；由用户在原生输入框手动清空，代码
  不替用户删除。
- 当前能力止于 `composer.get-draft` / `composer.set-draft`；`composer.send` 始终返回
  `signal_send_not_enabled`，没有自动发送。下一开发任务从“Signal `CompositionInput.submit` →
  最终平台消息 ID → `attemptId` 幂等账本”设计开始：正文、`contextRevision` 与 attempt 必须绑定，
  覆盖双击、切会话、用户改稿、命令超时、结果丢失和进程重启，只有 Signal 确认最终消息 ID 后才
  能报告成功或清理 attempt。
- 实现发送前先重新核对 Signal Desktop 8.25.0 本机 bundle 的 `inputApi.submit`、CompositionArea
  `onSubmit` 与最终出向消息持久化边界；继续使用精确唯一锚点，禁止 DOM scraping。优先复用既有
  `NativeComposerCommand`、`attemptId`、renderer pending-command 和 Telegram 已验证的结果未知语义，
  但不要把 Telegram 本地消息 ID 算法直接套到 Signal。
- 下一真实续验只允许一条无敏感文字验证新的“翻译坞自动发送”路径；不得重做 Telegram/WhatsApp/
  Signal 切换、Signal 原生文字/图片/贴纸发送、入站文字/图片/贴纸、编辑/删除/回应或 503 outbox
  矩阵，除非新代码实际修改对应边界。继续从 a23 配置生成 a24，不重启 Telegram；若服务端协议未变，
  也不重启服务端。
- 敏感边界保持不变：不读取或输出 `.env`、Signal profile/session、数据库正文、ACI、具体消息键、
  媒体引用、token、二维码或密钥；数据库只做必要的聚合只读验证。不要合并 PR #19，不要关闭
  Issue #12。

## 12. Signal 纯文字发送 attempt 账本实现 checkpoint（2026-08-31）

- 本轮从 `7e58a07` 继续复用原隔离 worktree。重新核对官方 Signal Desktop 8.25.0 程序 bundle 后，
  发送链确定为 `CompositionInput.inputApi.submit(timestamp)` → CompositionArea `onSubmit` →
  Signal `sendMultiMediaMessage` → `ConversationModel.enqueueMessageForSend` → 消息与 send job 的同一
  持久化事务。补丁只在这些 Signal 自身 action/状态和持久化点增加精确唯一 hook，不读取 DOM。
- 当前自动路径严格限于纯文字：可见 CompositionInput 正文必须与 ConversationModel 持久草稿
  完全相同，Redux composer 和模型都不能有附件、编辑、引用或 view-once 状态。图片、贴纸、编辑、
  回应及其他既有发送边界不经过本账本，因此没有重做已通过的原生发送或入站矩阵。
- renderer 为正文计算精确 UTF-8 SHA-256，仅把 fingerprint、`attemptId`、当前会话和首次
  `contextRevision` 交给 Signal guest。持久 IndexedDB 账本不保存正文，只保存实际 Signal 账号、
  规范会话、guest 内部会话引用、首次 revision、fingerprint、提交时间、本地消息引用和最终平台
  消息 ID；最多保留 100 项。首次 revision 以 `attemptContextRevision` 固定，不能被重试时的新
  revision 偷换。
- 新 attempt 在写入账本后才调用原生 `submit`，并在提交前再次核对会话、revision、正文
  fingerprint 和纯文字资格。同一 attempt 的双击与并发请求合并为一次 submit；切会话或用户改稿
  会拒绝旧 attempt；同会话同 fingerprint 尚未得到最终结果时，新 attempt 也会冲突，避免超时后
  以新 ID 重发。
- Signal 创建实际 outgoing model 后、写消息与 send job 之前，prepared hook 先把 Signal 本地
  消息引用绑定到 attempt；事务完成后的 persisted hook 再验证 outgoing 类型、会话、实际
  `sent_at` 与正文 fingerprint。最终平台消息 ID 只使用 Signal 自身“本账号 sender + 实际
  `sent_at`”规范键生成，不套用 Telegram 临时/最终消息 ID 映射算法。
- 只有 persisted hook 确认最终平台消息 ID 后，`composer.send` 才返回成功。命令超时保持
  `result_unknown`，再次点击沿用原 attempt；若 command result 丢失或进程重启，账本可直接重放
  已持久结果，或按 prepared 阶段保存的 Signal 本地消息引用从 Signal 自身 DataReader 重新验证，
  不再次 submit。外壳收到成功后另发 `composer.ack-send`；只有 attempt 和最终平台消息 ID 精确
  匹配时才删除账本，ACK 丢失则留待重启恢复。
- host/guest 命令增加 fingerprint、首次 revision、恢复状态和最终 ID ACK，仍保持 bridge protocol
  version 3；服务端 HTTP、WebSocket、数据库和 `/api/native/events` 合约均未变化，因此本轮没有
  重启服务端或 Telegram。
- 自动化已通过 `pnpm typecheck`、Signal/renderer/host 7 个文件 65 项定向测试、全量 50 个文件
  457 passed / 1 todo，以及 desktop build。准备脚本从官方 8.25.0 程序和 a23 不透明配置生成
  `/private/tmp/Signal-imhub-integrated-a24.app`；submit timestamp、DataReader 恢复、prepared 和
  persisted 四个新增锚点各唯一命中，deep/strict codesign 通过。过程中未读取配置内容或任何
  profile/session 数据。
- a24 启动时发现本机 4000 没有服务进程；服务端从隔离 worktree 启动后，旧外壳不会自动重试首次
  bootstrap，因此只重启了独立 bundle id `org.imhub.SignalDesktop` 的 a24。随后会话恢复、账号/
  会话列表、WebSocket 和原生 control grant 均成功，没有重启 Telegram 客户端。
- 用户只发送了一条无敏感纯文字，接收端确认精确收到一条，证明 submit → Signal 消息/send job
  持久化 → 最终平台消息 ID → command result 的真实主链成功；未读取正文、ACI、本地/平台消息键、
  profile、token 或数据库内容，也没有重复任何既有矩阵。
- 同一次续验暴露纯 UI 竞态：renderer 收到成功并清空翻译坞后，guest 在 ACK 删除账本前回放一次
  “最终 ID 已确认”的 attempt，翻译坞被重新建成“操作失败”；ACK 后的无 attempt 状态原先没有
  收掉它。消息本身没有重复或失败。renderer 现显式记录 `sendAttemptConfirmed`，只在 Signal 的
  后续无 attempt 状态到达时清除该短暂恢复态；待核对或未确认 attempt 不受影响。
- 修正后相关 store/TranslationDock 25 项测试、`pnpm typecheck`、desktop build 均通过；从 a24
  不透明配置生成 `/private/tmp/Signal-imhub-integrated-a25.app` 并通过 deep/strict codesign。
  遵守单条上限，没有用第二条消息重验 a25，因此“真实送达与最终 ID 主链”已通过，“成功后 UI
  收敛”仍只有自动化证据，不能把整个纯文字自动发送标记为完整真实验收。

## 13. 外壳服务端 bootstrap 自动恢复 checkpoint（2026-08-31）

- a24 真实续验时先打开客户端、后发现本机 4000 没有服务进程；服务端启动后，外壳仍保留首次
  `NetworkError` 和空账号/会话列表，只能重启测试包。根因是 `App.bootstrap` 只有一次启动调用，
  失败后虽然进入主界面并创建 WebSocket，却没有重新执行 session、账号和会话 HTTP 快照。
- renderer 新增单定时器 `BootstrapRetryController`：网络错误后按 1/2/4/8 秒退避，此后上限保持
  8 秒；重复错误不会并发排多个定时器。每次重试仍沿用现有 auth generation，开始新 bootstrap
  前关闭旧 WebSocket；成功后清除提示并把退避归零。
- 登出、401 回登录页、用户切换和组件卸载会同步取消定时器并推进 generation，旧用户的迟到回调
  无权重新拉数据或创建连接。非网络 HTTP 错误仍按原有路径报告，不被无限重试伪装成网络故障。
- 新增自动化覆盖单飞、1/2/4/8 秒递增与上限、成功 reset 和取消；bootstrap/store/TranslationDock
  相关 27 项测试、全量 51 个文件 459 passed / 1 todo 与 `pnpm typecheck` 通过。desktop build、从 a25 不透明配置生成的
  `/private/tmp/Signal-imhub-integrated-a26.app` 及 deep/strict codesign 均通过。
- 本修复只涉及 im-hub 外壳连接恢复，不修改 Signal/Telegram/WhatsApp guest、发送 attempt、
  HTTP/WS 合约或服务端。没有停止服务端做真实断线探针，也没有发送第二条 Signal 消息。

## 14. WhatsApp 官方接入边界 checkpoint（2026-08-31）

- 重新核对 WhatsApp 官方条款与 Meta 官方 Business Platform 资料后，M6 不再尝试给
  `web.whatsapp.com` 注入 preload、抓取 DOM 或执行页面脚本。WhatsApp Business 条款明确限制
  未经书面许可的逆向、数据抓取和交互应用；官方网页也没有向 im-hub 承诺稳定的身份/消息事件
  合约。该页面只保留为 owner-only、每账号独立 partition 的原生 UI 壳。
- `AccountConnectionMode` 新增 `web_shell` 与 `cloud_api`。新建 WhatsApp 官方网页账号默认登记为
  `web_shell`，不会启动服务端占位适配器；历史 `adapter` 账号与实现继续保留兼容，不批量迁移、
  不删除。桌面端只为 `web_shell` 和历史 `adapter` WhatsApp 账号加载官方页面，绝不为未来
  `cloud_api` 账号误挂网页 session。
- `cloud_api` 是统一消息链的唯一计划路线：通过 Embedded Signup 取得业务授权，以 WABA id 与
  phone-number id 绑定 im-hub 账号；服务端使用官方 Graph API 发送，使用可公开访问的 HTTPS
  WABA Webhook 接收入站和状态事件。token 必须只存在服务端 secret store，账号行保存引用而非明文，
  renderer/webview 不得接触。
- 平台消息 id 直接来自官方事件/响应：入站使用 Webhook `messages[].id`；出站只有 Graph API
  成功响应返回 `messages[].id` 后才能报告“平台已接受”，之后 `sent/delivered/read/failed` 状态
  以 Webhook 中相同 id 更新。不能套用 Telegram temp/final remap 或 Signal sender/timestamp 键。
- `cloud_api` 当前只完成 schema/protocol 预留，创建接口明确返回未配置，避免产生假账号。公开
  Webhook、Meta 应用/业务授权、回调真实性校验和 secret reference 均未就绪，因此本 checkpoint
  没有发送 WhatsApp 消息、没有重扫二维码，也不能声称统一桥接已接入。
- 未来发送 attempt 必须先持久化正文 fingerprint、目标、账号授权 revision 与 attemptId。Graph
  请求超时或响应丢失时，在选定 API 版本的官方幂等/查询能力没有明确证据前不得盲目自动重发；
  结果未知应保持待对账或人工处置。最终账本只能绑定 WhatsApp 返回的平台 id。
- 官方事实来源：[WhatsApp Business Terms](https://www.whatsapp.com/legal/business-terms)、
  WhatsApp Business Platform 的 Meta 官方 Postman collection（[Messages](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages)
  与 [Webhook Payload Reference](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference)），
  以及 [WhatsApp Business Partner](https://whatsappbusiness.com/partners/become-a-partner/) 页面中
  Tech Provider/Embedded Signup 的说明。实现时仍须锁定具体 Graph API 版本并复核当期官方文档。
- migration 已分别在开发库和按规则派生的隔离 `_test` 库成功应用；账号路由 33 项、全量 51 个
  文件 462 passed / 1 todo、`pnpm typecheck` 与 desktop build 均通过。当前服务端仍在 4000 监听，
  从 a26 不透明配置生成 `/private/tmp/Signal-imhub-integrated-a27.app` 并通过 deep/strict codesign。
  本轮没有重启 Telegram、没有打开第二个服务端实例、没有发送 WhatsApp 或 Signal 消息；a27
  仅生成未启动。

## 15. Signal / WhatsApp 入站双语显示 checkpoint（2026-08-31）

- 产品核心验收明确为对方入站消息同时显示原文与中英译文：翻译引擎检测源语言为中文时译成
  英文，否则译成中文；不按汉字字符猜测，避免把含汉字的日文误判成中文。新消息尚无源语言时
  先译中文取得 provider 检测结果，确认中文后再译英文；已保存的 `body_lang` 可直接选择目标。
  该目标选择进入中央翻译 worker、幂等查询和 REST 会话快照，不再把所有入站正文固定译成中文。
  出向翻译、Signal 发送 attempt、Telegram/Signal/WhatsApp 既有入站生命周期和 outbox 边界没有
  改动，因此不重复真实矩阵。
- 中央 `message` / `translation` WebSocket 事件新增账号、平台和规范 `platformMessageId` 关联；
  会话消息快照也返回同一规范键。Signal renderer 只把当前译文作为最多 500 项的单批命令交给
  已授权 guest，避免逐条触发 control grant 实时校验。bridge protocol 仍是 version 3：这是只有
  Signal 接收的可选新增 host command，不改变旧 Telegram guest 的事件协议。
- Signal guest 不接收本地消息 id。Signal Desktop 8.25.0 的精确唯一 action 锚点使用自身
  `DataReader.getMessagesBySentAt` 和 sender 解析规范消息键，随后重新核对 incoming 类型、sender、
  `sent_at` 与 `editMessageTimestamp` revision；任何不匹配都拒绝显示。译文只保存在 guest 内存，
  编辑/删除 hook 先清旧值；进程重启或结果丢失后由中央 REST 快照再次批量回填。
- 显示层是在 Signal 8.25.0 原生 React 消息正文组件的唯一锚点中订阅上述内存快照，并在原文下方
  渲染分隔线和译文；没有 DOM 查询、选择器、MutationObserver 或正文抓取。官方 8.25.0 程序中
  消息解析、React 组件和正文插入三个锚点已分别确认唯一。
- WhatsApp 必须满足同一验收，但 `web_shell` 继续严格保持官方网页壳，不注入 preload、不抓 DOM、
  不读取官方页面消息。未来 `cloud_api` 收到 WABA Webhook 后，必须以官方 `messages[].id` 关联
  im-hub 自有的双语会话侧栏/记录视图；在 Cloud API、Webhook 和自有视图完成前，不能声称
  WhatsApp 入站双语显示已完成。
- 自动化已通过 `pnpm typecheck`、相关 9 个文件 134 项定向测试（其中数据库边界 71 项）、全量
  53 个测试文件 474 passed / 1 todo 与 desktop build。准备脚本从官方 Signal Desktop 8.25.0
  和 a27 不透明配置生成 `/private/tmp/Signal-imhub-integrated-a28.app`，消息解析、React 组件和正文
  插入三个新增锚点各唯一命中，deep/strict codesign 通过。a28 仅生成未启动，没有发送额外真实
  消息，也没有读取或输出 profile/session、ACI、正文或具体消息键；因此代码与打包证据已完成，
  Signal 原生双语气泡仍等待下一次允许的单条无敏感入站真实续验。

## 16. Signal 双语气泡真实续验修正 checkpoint（2026-08-31）

- a28 启动后只使用了一条无敏感英文入站消息。Signal 原生气泡显示了原文，但没有显示中文译文，
  因此没有把“消息到达”误记成“双语显示通过”，也没有发送第二条消息。只读聚合核验显示近 30
  分钟恰有 1 条 Signal 入站、1 条中文译文且源语言已识别；核验没有读取或输出正文、ACI、具体
  消息键或译文内容，证明中央翻译 worker 与落库正常，故障位于 Signal guest 本地模型解析。
- 复核官方 Signal Desktop 8.25.0 bundle 后确认，初版补丁使用的 `ii(message)` 是 Signal 内部
  `helpers.getAuthorId`，返回本机 `ConversationModel.id`，不是消息的 `sourceServiceId`。把它与
  im-hub 规范 sender 比较必然无法命中；这也是自动化 mock 能通过、真实客户端却不显示的原因。
- 解析补丁改为继续使用官方 `DataReader.getMessagesBySentAt`，再直接按候选消息自身的
  `type=incoming` 与 `sourceServiceId` / `source` 筛选。guest store 仍对规范 sender、`sent_at`、
  incoming 类型和 edit revision 做第二次独立核对，所以时间戳碰撞、错误方向与迟到编辑译文仍
  会被拒绝；没有改用 DOM、Signal 本地消息 id 或 Telegram 消息 ID 算法。
- 修正通过 `pnpm typecheck`、Signal translation/preload/renderer 3 个文件 29 项定向测试、desktop
  build，以及官方 8.25.0 preload 的语法与唯一补丁检查；旧 `ii(t)===e` 解析器在产物中为 0 处。
  从 a28 不透明配置生成 `/private/tmp/Signal-imhub-integrated-a29.app` 并通过 deep/strict codesign，
  已只平滑重启独立 bundle id `org.imhub.SignalDesktop` 的隔离包。Telegram 和服务端均未重启，
  没有再发送消息。
- a29 重启后，同一条既有无敏感英文入站消息在原文下方显示中文译文；更早的已编辑入站消息也由
  中央快照恢复为原文加译文。由此关闭 Signal“英文入站实时显示 + 进程重启历史回填”的真实门槛，
  全程只使用 a28 阶段已经发送的那一条入站消息，没有新增消息。截图中本账号发出的蓝色出站消息
  仍只显示 Signal 保存的单一正文，这是当前 `direction=in` 产品边界，不属于本次入站双语验收；
  若产品要求出站也双语，必须另行定义员工原文与最终平台正文的保存、编辑和删除语义。

## 17. Signal 出站双语与历史回填 checkpoint（2026-08-31）

- 用户确认蓝色出站气泡也需要双语。本轮语义确定为“以 Signal 实际保存并发送的正文为原文”：
  provider 检测中文时译英文，否则译中文。它既适用于 im-hub 翻译坞发送，也适用于 Signal 原生 UI
  手动发送；不尝试从 SHA-256 attempt fingerprint 反推出员工最初输入，也不把发送账本改成保存
  正文。WhatsApp `cloud_api` 尚未实现，本 checkpoint 只改变 Signal。
- 新出站在 Signal 8.25.0 消息与 send job 的原生事务持久化 hook 完成后归一化，复用既有 Signal
  IndexedDB outbox、ACK/dead-letter、`/api/native/events` 和中央唯一键。规范 sender 必须是 control
  grant 绑定的实际账号 ACI，服务端再次拒绝任何不匹配 sender；平台消息键仍是 self ACI + 实际
  `sent_at`，没有套用 Telegram 临时/最终 ID 算法。
- 进程启动或切换当前会话时，guest 只用官方
  `DataReader.getOlderMessagesByConversation` 读取最近 200 条候选，筛选纯文字 `type=outgoing` 后做
  幂等历史回填。查询以 Signal 本地 conversation id 为 guest 内部参数，但该 id 和本地 message id
  都不进入事件、日志、outbox payload 或中央库；带附件、贴纸、空正文和 story 不进入本轮边界。
- 中央 ingestor/worker 只为 Signal 扩展出站翻译，Telegram、WhatsApp 和其他平台出站继续跳过，
  避免未经产品验收扩大调用量。REST 快照、WebSocket 译文事件和 `message.set-translations` 批命令
  现在同时下发 in/out；Signal resolver 对入站核对 source，对出站核对 self ACI，随后 guest store
  仍重验方向、sender、`sent_at` 与 edit revision。原文下方的 React 渲染锚点保持不变且不读 DOM。
- 自动化已通过 `pnpm typecheck`、出站归一化/历史回填/renderer/ingestor/worker/native 路由定向
  回归，以及全量 53 个测试文件 482 passed / 1 todo；desktop build 通过。数据库用例只连接按规则
  派生的隔离测试库，没有读取或输出开发库正文、ACI、具体消息键或凭据。
- 准备脚本从官方 Signal Desktop 8.25.0 与 a29 不透明配置生成
  `/private/tmp/Signal-imhub-integrated-a30.app`；双向 resolver、历史 DataReader action 和 React 渲染
  引用均精确命中，preload 语法与 deep/strict codesign 通过。只平滑替换了独立测试 bundle，未退出
  官方 Signal 或 Telegram，也没有发送新消息。a30 启动后的只读聚合显示近 10 分钟恰有 2 条历史
  Signal 纯文字出站回填、2 条中文译文且 2 条均完成语言识别；核验未读取或输出正文、译文、ACI 或
  具体消息键。
- 用户随后目视确认同一当前会话的两条既有蓝色出站气泡均已显示译文，期间没有发送新消息或重做
  任何既有发送/入站/outbox 矩阵。因此 Signal“新纯文字出站捕获 + 当前会话最近 200 条历史纯文字
  出站回填 + 原生气泡双语显示”真实门槛已关闭；媒体出站和 WhatsApp Cloud API 仍保持未完成边界。

## 18. WhatsApp Cloud API 纯文字双语链 checkpoint（2026-08-31）

- `web_shell` 继续只承载官方 `web.whatsapp.com`：没有 preload、DOM 抓取、页面脚本或统一消息
  bridge。新 `cloud_api` 路线使用显式锁定的 Graph API `v25.0`、WABA Webhook 与 Meta Embedded
  Signup；版本升级必须重新按 Meta 官方 collection 和 changelog 回归，不能漂移到 `latest`。
- owner 从桌面端发起一次性 onboarding session，bearer ticket 只以 SHA-256 落库并通过公开 HTTPS
  页面的 URL fragment 传递，页面加载后立即清除 fragment。Meta code 在同源服务端交换；WABA 与
  phone-number 归属经 Graph API 复核后才建账号并订阅 Webhook。access token 使用每账号 AAD 的
  AES-256-GCM 密文保存，renderer、webview、账号 `credentials_ref`、日志和错误文本均不接触明文。
- Webhook GET challenge 使用常量时间 verify-token 比较；POST 必须按原始请求字节通过
  `X-Hub-Signature-256` HMAC-SHA256。解析器只接受有界且完整的官方 WhatsApp Business Account
  payload。入站纯文字以官方 `messages[].id` 唯一落库，进入既有中央语言识别与翻译 worker：
  中文译英文，其余语言译中文；Cloud API 账号使用 im-hub 自有会话视图显示原文与译文。媒体与
  未支持类型当前只做聚合告警，不读取 `web_shell` 页面，也不伪装成已接入。
- 出站 attempt 在调用 Graph 前持久化，绑定 `attemptId`、账号、会话、员工、目标、正文 SHA-256
  与 authorization revision。双击由本地发送锁挡住；切会话或用户改稿会废弃未发起的旧 attempt；
  网络超时、响应丢失、2xx 无最终 ID 与进程重启后的同键重放都保持 `sending/unknown` 并禁止盲目
  自动重发。只有 `POST /{phone-number-id}/messages` 返回最终 `wamid` 后，消息、attempt 与
  `accepted` 状态才原子落库并向 UI 报告成功；后续 `sent/delivered/read/failed` Webhook 按同一
  官方 ID 单调更新，不套用 Telegram temp/final 或 Signal sender/timestamp 算法。
- 新增两份 additive migration：Cloud 账号/加密 secret/发送与状态账本，以及短时 onboarding
  session；两份 migration 已分别在开发库与按规则派生的隔离 `_test` 库成功应用。Cloud 路由只有
  在所有必需配置通过校验后注册；公开页面采用 nonce CSP、禁止被嵌套并
  只开放 Meta 官方 SDK/Graph origin。当前服务端未配置 Cloud API，故本轮不重启服务端、Telegram
  或 Signal，也没有发送 WhatsApp 消息、打开二维码、读取平台 session 或输出任何平台标识。
- 自动化通过 `pnpm typecheck`、61 个测试文件 512 passed / 1 todo 与 desktop production build；
  新增覆盖原始字节签名、严格 payload、Graph 最终 ID/未知结果、AES-GCM AAD、一次性 ticket、
  attempt 绑定/重放、乱序状态、公开路由权限和 Cloud/Web 布局分流。该 checkpoint 是代码完成，
  不是生产验收；真实门槛仍是 Meta 应用与业务授权、公开 HTTPS 回调，以及最多一条无敏感纯文字
  的入站双语/最终 ID 续验。

## 19. WhatsApp Web TranGPT 式补丁模式 checkpoint（2026-08-31）

- 本节只推翻第 14/15/18 节中“`web_shell` 永不注入或读取 DOM”的产品决定，不改变那些章节已经
  完成的 Cloud API 实现、官方消息 ID 或 Webhook 安全边界。静态解包 TranGPT 3.1.171 后确认其
  WhatsApp 能力来自 Electron preload、DOM 选择器/MutationObserver、页面本地状态与输入事件模拟，
  不是隐藏的官方 Web API。用户已明确选择复刻这条路线，并确认当前可见聊天正文会送往 im-hub
  已配置的翻译提供商，同时接受 DOM 改版、平台条款和账号风控风险。
- `web_shell` 仍只挂载 owner 的 `persist:native-<accountId>`，精确允许
  `https://web.whatsapp.com`。主进程现在给该 origin 注入既有 typed preload；DOM 控制器只在
  context-isolated preload 内持有事件、host command、批量翻译和语言检测四项窄能力，不把原始
  bridge 对象暴露给 WhatsApp 页面脚本。Node、JWT、control grant、外壳 IPC 和其他账号 partition
  仍不可见。相机、麦克风、通知、剪贴板和第三方 frame 权限继续拒绝，只有 WhatsApp 主框架的
  `persistent-storage` 例外保持不变。
- guest 从 WhatsApp 页面本地状态取得并规范当前登录用户标识，周期重放以覆盖 preload 早于 renderer
  listener 的竞态。服务端只允许 owner 对 `web_shell` 首次绑定该身份，后续页面身份、数据库身份、
  短时 grant 或 partition 任一不一致都会阻断能力。日志与 UI 不输出该标识；历史 `adapter` 和独立
  `cloud_api` 账号不迁移、不删除。真实续验使用的是早期创建、migration 后保留为 `adapter` 的网页
  账号；该账号同样挂载 owner-only partition，因此 control grant 兼容 `adapter` 的首次页面身份
  绑定，但不改变其数据库模式，也不扩大到 `cloud_api`。
- 气泡兼容层只扫描当前会话最近 300 个可见纯文字节点，使用 `role=row`、`data-testid`、
  `.message-in/.message-out` 与 selectable-text 多锚点；打开会话时覆盖已存在的可见入/出站消息，
  滚动加载、新消息和正文变化由 MutationObserver 增量触发。语言目标仍以 provider 检测为准：
  中文译英文，其余译中文。译文用 `textContent` 插入独立 marker，不执行平台正文 HTML；单条失败
  显示可点击重试。消息正文只存在于页面内存和翻译请求中，不写 IndexedDB、日志或 attempt 账本。
- 当前会话优先从 WhatsApp 消息 `data-id` 中提取私聊/群聊/LID JID，取不到时才用标题 SHA-256
  作为显式 fallback；服务端只接受 `wa:<jid>` 或 `wa-title:<digest>` 规范键及匹配 contact。翻译坞
  使用当前 context revision 控制 contenteditable，写入后重新读取确认；切会话和用户改稿都会让旧
  命令失败。
- 出站发送要求 `attemptId`、首次 context revision 与最终草稿 SHA-256。guest 在点击原生发送按钮
  前把这些非正文事实写入本 partition 的独立 IndexedDB；随后只接受一条发送前不存在、正文匹配且
  带实际 WhatsApp DOM `data-id` 的新出站消息作为最终确认。双击复用同 attempt；超时、结果丢失和
  进程重启后的 pending attempt 只报告结果未知，禁止再次点击。最终 ID 确认后可以恢复同 attempt
  结果，外壳 ACK 后才删除账本。该 DOM id 只服务于 Web 补丁发送确认，不能冒充 Cloud API `wamid`
  或套用 Telegram/Signal 的消息 ID 算法。
- 当前范围不把 DOM 消息上报 `/api/native/events`，因此没有中央存档、客服档案跟随、关键词告警、
  媒体/引用/回应/删除语义或跨页面版本的稳定协议。Cloud API 继续承担需要可信 Webhook、官方状态、
  中央归档和长期可维护性的生产路线。本 checkpoint 只完成代码与自动化；尚未启动 WhatsApp 页面、
  读取真实账号状态或发送真实消息，真实验收继续遵守最多一条无敏感文字的上限。
- 选择器同时保留 `data-testid`、`role=row` 与方向 class fallback；页面仍出现可见文字候选但连续
  无法解析消息时，guest 会显式报告 `whatsapp_dom_selector_unavailable`，不会静默假装双语能力可用。
  自动化通过 `pnpm typecheck`、63 个测试文件 519 passed / 1 todo 与 desktop production build；
  测试只使用合成身份、JID、正文和消息键，没有读取真实 WhatsApp session、账号标识或聊天正文。
  准备脚本从官方 Signal Desktop 8.25.0 和 a30 不透明配置生成
  `/private/tmp/Signal-imhub-integrated-a31.app`，deep/strict codesign 通过；a31 仅生成未启动，没有
  重启 Telegram 或服务端，也没有触发真实 WhatsApp/Signal 消息。
- a31 首次真实登录后 control grant 成功，但当前会话既有中文气泡没有译文，故没有把“账号已登录”
  误记为“双语显示通过”。复核已解包 TranGPT 3.1.171 的实际 WhatsApp 兼容代码后，确认首版缺少
  `#app div[data-id]` 行 fallback 和独立 `.copyable-text` 文本 fallback；这些锚点已补入，同时继续
  排除引用 mention、限制最近 300 条且不记录正文。a32 仍没有显示译文；a33 的页内安全诊断也没有
  报 selector unavailable，证明消息行与正文已解析，失败边界进一步缩小到 marker 挂载。首版把
  marker 放在正文父层，当前页面会裁切该额外子项；现改为与 TranGPT 相同，直接挂入正文元素并在
  原文读取 clone 中排除 marker。该修正仍需新测试包做只读历史气泡续验。
- a38 的临时安全探针确认当前 `#main` 中存在 3 个同时带实际 `data-id` 与 `conv-msg-*` test id 的
  消息容器，文字锚点也能命中，但旧版 `.message-in/.message-out` 方向 class 数量为 0；此前扫描把
  “可识别消息”错误绑定到“可识别方向”，因此在翻译前丢弃了全部消息。现已把规范消息容器识别与
  方向判断解耦：双语扫描接受 WhatsApp 自身的规范容器；只有最终发送确认继续按方向尾标、送达状态、
  DOM id 的 from-me 前缀与最后的气泡布局 fallback 判断出站。发送前快照改为记录当前会话全部既有
  DOM id，避免方向 fallback 遗漏旧出站。橙色临时探针已经删除，正式的阶段、选择器与 marker 可见性
  错误仍保留且只包含计数，不含正文、账号标识或具体消息键。
- 修正通过 `pnpm typecheck`、定向 4/4、全量 63 个测试文件 520 passed / 1 todo，以及 desktop
  production build；首次沙箱内全量测试只有本机 PostgreSQL 连接被 `EPERM` 阻止，按规则连接隔离
  `_test` 库后全量通过。准备脚本从 Signal Desktop 8.25.0 与 a38 不透明配置生成 a39，deep/strict
  codesign 通过；尚未把只读历史气泡目视结果记为通过，也未发送新消息或重启服务端/Telegram。
- 用户随后在 a39 目视确认同一 WhatsApp 当前会话的既有入站与出站纯文字气泡均已在原文下方显示
  中英译文，且橙色临时诊断框已经消失。该续验只复用了页面现有消息，没有新增真实消息，也没有
  重启服务端或 Telegram；由此关闭 WhatsApp Web 补丁模式“当前可见历史纯文字双向翻译显示”的
  真实门槛。页面滚动增量、发送最终 DOM id 与进程重启 attempt 恢复仍按本节既定边界继续验收。
