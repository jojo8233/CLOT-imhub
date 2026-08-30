# M5/M6 Signal 与 WhatsApp 并行首检点

日期：2026-08-29
状态：执行中；2026-08-30 Signal 已通过同一物理窗口原生发送首检，入站文字桥接已实现并待真实落库续验

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
- 原生窗口第一阶段保持 Signal 自身的文字、图片与贴纸能力；当前已实现入站纯文字的中央
  回传，入站媒体、编辑、删除、回应、翻译、正式多开与安装包仍属于后续 M5。
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

Signal 的独立 profile、同窗口承载和原生发信矩阵已完成，下一 checkpoint 从入站文字唯一
落库和桥接边界继续；WhatsApp 先确定可维护且合规的身份/消息事件边界，再决定补丁客户端或
其他受控方案。没有这层设计与服务端 owner 复核前，禁止给官方 WhatsApp 页面注入 Telegram
的通用 preload，也禁止用 DOM scraping 冒充稳定消息协议。

## 5. 最新续验 checkpoint（2026-08-30）

- 外部无边框窗口覆盖方案已由用户明确判定“不算内嵌”，运行时代码已移除。
- Signal Desktop 8.25.0 现在用自身 Electron 43.4.1 进程承载 im-hub 主窗口；Signal renderer
  是同一窗口内容区内的 `WebContentsView`，不是 `<webview>`，也不是第二个 OS 窗口。
- 已复用一个隔离真实账号完成：钥匙串授权、冷启动恢复、Telegram → WhatsApp → Signal 往返
  切换、原生文字发送、原生图片发送、原生贴纸发送；用户截图确认顶栏、功能区和客户栏保持
  在同一 im-hub 窗口。
- 当前只支持一个 Signal Desktop 原生账号；本 checkpoint 尚未取得 Signal 入站唯一落库、
  编辑/删除/回应、翻译或中央回传证据，不能越级标记 M5 完成。
- WhatsApp 已完成官方页面登录与可见性首检；继续沿用已登录 partition，不重复扫码矩阵。

续接时先验证最新同窗口开发包仍能恢复，再从“Signal 入站文字唯一落库/桥接设计”继续；不要
重做上述窗口切换和原生文字/图片/贴纸发送矩阵。

## 6. Signal 入站文字桥接实现 checkpoint（2026-08-30）

本轮从 `539fb7e` 复用既有隔离 worktree 续接，没有重做三平台切换和 Signal 发送矩阵。
实现边界如下：

- Signal Desktop 8.25.0 的原生 preload 在 `ConversationModel.onNewMessage` 完成自身持久化后
  触发受控 hook；启动顺序会先安装 im-hub bridge，再启动 Signal renderer，避免冷启动竞态。
- Signal guest 不上报 im-hub `accountId`、JWT 或 control grant。Signal 的
  `WebContentsView` 由主进程绑定账号 UUID；guest 只上报实际 ACI。服务端 owner-only grant
  首次把该 ACI 绑定到 `connection_mode=native_desktop` 账号，主进程随后继续用实际
  WebContents 与 grant 中的 ACI 逐次匹配。
- Signal Desktop 与 `signal-cli` 共用 `packages/shared/src/signal.ts` 的规范身份算法。私聊
  会话键为 `u:<normalized-aci>`，群会话键为 `g:<group-id>`，消息键为
  `<normalized-sender>:<sent-at-ms>`；服务端拒绝非规范键、入站私聊发送者不匹配和 Signal
  remap，数据库仍按 `(account_id, platform_message_id)` 幂等落库。
- 当前只桥接 `type=incoming` 且正文非空的纯文字 `message.upsert`。媒体、贴纸、回应、编辑、
  删除和 composer/context 命令均未开放；这些事实不能从 Signal DOM 推断或伪造。
- 事件在 Signal 进程内使用稳定 `eventId`、两秒重试和 `event.ack`。服务停机但 Signal 进程
  仍在时可继续重试；队列当前是最多 1000 项的内存队列，Signal 进程自身退出时尚不能恢复，
  因而不能把它写成 Telegram IndexedDB outbox 同等级的持久可靠性。

自动化证据已通过：`pnpm typecheck`、46 个测试文件（414 passed、1 todo）、desktop build，
以及新生成开发包的补丁锚点计数与严格 codesign 校验。同窗口开发包已完成过外壳会话冷恢复；
当前桥接修正版仍待 Safe Storage 授权后的真实续验。
截至本节更新时，仍待从另一台已关联设备发送一条新的纯文字消息，以只读计数确认该事件在
重试条件下只产生一个 `(account_id, platform_message_id)`；取得该证据前不得把“入站文字唯一
落库”门槛标记为完成。
