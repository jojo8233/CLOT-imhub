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
