# M5/M6 Signal 与 WhatsApp 并行首检点

日期：2026-08-29
状态：执行中；2026-08-30 Signal 已通过同一物理窗口原生发送、入站文字唯一落库、持久 outbox
真实重放、图片/贴纸结构化元数据、编辑/删除/回应，以及当前会话与可见原生草稿写入真实续验

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
入站图片/贴纸结构化元数据和编辑/删除/回应真实续验均已完成。下一 Signal checkpoint 是当前会话
同步与翻译写入原生草稿。WhatsApp
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
  均已取得真实证据；当前会话与可见原生草稿写入也已真实续验；自动发送、附件二进制与其他
  入站媒体仍未完成。
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
