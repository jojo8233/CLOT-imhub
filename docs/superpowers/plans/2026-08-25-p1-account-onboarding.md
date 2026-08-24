# P1：账号自助接入（扫码登录）

> 现在账号只能靠 `seed` 建，登录要在服务端终端里敲验证码。
> 也就是说没法给第二个员工开账号——「多开」这条需求在实操层面还没通。

目标：员工在客户端点「添加账号」→ 选平台 → 弹二维码 → 用手机扫 → 账号上线。
全程不碰服务端终端。

---

## 已定的设计决策

| 问题 | 决定 | 为什么 |
|---|---|---|
| 手机号+短信 还是 扫码 | **扫码** | 员工不用把手机号交给公司；也不用有人守在服务端终端里转发验证码 |
| 用不用 tdl 的 `login()` | **不用** | 它在 `WaitPhoneNumber` 里写死了发 `setAuthenticationPhoneNumber`，没有扫码入口。自己驱动状态机顺带解决「无 TTY 时 `login()` 永久挂起」这个老问题 |
| `connect()` 何时返回 | **建好 client 就返回**，鉴权异步进行 | 现在 `connect()` 会 `await login()`，启动时一个待登录账号就能把整个服务端卡住 |
| 二维码过期 | **不自己计时** | TDLib 的 QR token 过期后会再下发一次 `WaitOtherDeviceConfirmation`，客户端跟着事件刷新就行 |
| 2FA 密码 | **内存直传 TDLib** | 不落库、不打日志、不进 JWT。服务端只在 adapter 里留一个 pending resolver，用完即弃 |
| 谁能建账号 | **auditor 之外都能**，只能给自己建 | auditor 是只读角色。`owner_user_id` 强制为当前登录用户，不接受请求体指定 |

### 关于 2FA 密码这一步

员工的 Telegram 二次验证密码会经由「客户端 → 本机服务端 → TDLib」这条路径。
这是所有 Telegram 客户端都要走的路，但必须守住三条：

1. 不写数据库、不写日志、不进任何错误信息
2. 只在内存里活到 `checkAuthenticationPassword` 返回为止
3. 走已鉴权的 HTTPS/本机接口，且只有账号 owner 本人能提交

做不到就不如不做——让员工去官方客户端关掉 2FA 反而更危险。

---

## Task A：共享类型

`AuthChallenge.kind` 补 `'password'`（2FA 提示语作为 payload）。

新增 WS 事件，让鉴权过程能实时推给发起人：

```ts
export interface WsAuthChallengeEvent {
  type: 'auth_challenge'
  accountId: string
  kind: 'qr' | 'code' | 'password'
  /** qr: 待编码成二维码的链接；code: 提示语；password: 密码提示 */
  payload: string
}

export interface WsAuthDoneEvent {
  type: 'auth_done'
  accountId: string
  ok: boolean
  /** ok 为 false 时的失败原因，已脱敏 */
  reason: string | null
}
```

## Task B：Telegram 适配器的鉴权状态机

不再调 `client.login()`，改成监听 `updateAuthorizationState` 自己处理：

| 状态 | 动作 |
|---|---|
| `WaitPhoneNumber` | `invoke({_: 'requestQrCodeAuthentication', other_user_ids: []})` |
| `WaitOtherDeviceConfirmation` | 发 `{kind:'qr', payload: link}` |
| `WaitCode` | 发 `{kind:'code'}`，等 `submitAuthAnswer` |
| `WaitPassword` | 发 `{kind:'password', payload: hint}`，等 `submitAuthAnswer` |
| `Ready` | 状态置 `connected`，触发 `onCredentialsUpdated` |
| `Closed` | 状态置 `disconnected` |

`createClient()` 本身会处理 `WaitTdlibParameters`（`_handleAuthInit` 挂在 update 分发里，
不依赖 `login()`），所以跳过 `login()` 是安全的。

新增方法：`submitAuthAnswer(accountId, value): Promise<void>`。

## Task C：服务端接口

- `POST /api/accounts` — 建账号并立即开始鉴权。`owner_user_id` 取自 token
- `POST /api/accounts/:id/auth-answer` — 提交验证码或 2FA 密码，仅 owner 本人
- adapter 的 `onAuthChallenge` 经 `hub.publishTo(ownerUserId, ...)` 推给发起人

## Task D：客户端

「添加账号」弹窗接上真接口：填名称 → 创建 → 二维码（跟着 WS 事件自动刷新）
→ 需要时弹 2FA 密码输入 → 成功后关窗、账号出现在顶栏。

二维码用 `qrcode` 包在渲染进程里生成 SVG（纯字符串，不依赖 canvas）。

---

## 验收

- [ ] 点「添加账号」建出账号，顶栏立刻出现，状态待登录
- [ ] 弹出二维码，手机扫码后账号变在线
- [ ] 二维码过期后自动换新的，不用手动重来
- [ ] 开了 2FA 的号会弹密码输入，填对后上线
- [ ] 密码不出现在任何日志、数据库、错误信息里
- [ ] auditor 调创建接口返回 403
- [ ] 服务端启动时有待登录账号不再阻塞


---

# 补记：Signal（2026-08-25）

## 为什么只能用 signal-cli

Signal 没有官方 Node 库，**也没有网页版可以包**——Signal Desktop 本身就是
Electron 应用，不是网站。剩下的选择只有逆向实现协议，既不稳也有封号风险。
所以 `signal-cli`（基于官方的 libsignal-service-java）是唯一可行路径。

`brew install signal-cli`，0.14.7，118MB，自带运行时不需要另装 JDK。

## 已定的设计决策

| 问题 | 决定 | 为什么 |
|---|---|---|
| 进程模型 | **一个 signal-cli 进程服务所有 Signal 账号** | jsonRpc 模式本身多账号，每请求带 account。一账号一进程会白白多出几百 MB 常驻 |
| 关联方式 | `startLink` → 推二维码 → `finishLink` | 两者必须落在同一个进程上：finishLink 按进程内会话查 uuid，换进程直接报 "Unknown device link uri" |
| 联系人标识 | **UUID 优先，号码兜底** | Signal 允许隐藏手机号，号码可能缺失或变更 |
| 会话 id | 加前缀 `u:` / `g:` | 发送时单聊走 recipient、群走 groupId，而群 id 是一串 base64，跟号码/UUID 没有形状差别，不加前缀只能靠猜 |
| 消息 id | `发送者:timestamp` | Signal 没有服务端消息 id，全网通用身份就是这两者 |
| 进程崩溃 | **指数退避自动重启** | 不重启的话所有 Signal 账号会静默地不再收消息——员工照常上班，界面看着正常，客户发来的东西再也不到了。凭据在磁盘上，重启不用重扫 |

### 出站消息的来源与去重

我们是**被关联的次要设备**，员工手机才是主设备。员工在手机上回复的消息不会
以「发出」的形式到达，而是作为 `syncMessage.sentMessage` 同步过来——不处理它，
会话看起来就只有客户单方面在说。

同步消息的 `senderExternalId` 一律取 `params.account`（本账号号码），**不取
envelope 里的 sourceUuid**。因为 `sendMessage()` 拼 id 时用的也是号码；两条路径
必须算出同一个 id，否则 `(account_id, platform_message_id)` 去重认不出是同一条，
同一条消息会存成两行。

## 还没做的

- 附件只记下 `mediaRefs`，不下载（Telegram 那边连记都没记，见下）
- 没有删除账号的接口，建错了只能进数据库删
- Telegram 的 `normalize.ts` 仍然只认 `messageText`，图片/文件/语音全部静默丢弃
