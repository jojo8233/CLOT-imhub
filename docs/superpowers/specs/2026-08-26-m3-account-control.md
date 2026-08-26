# M3-2 Telegram 账号控制授权与身份绑定

日期：2026-08-26
状态：代码已实现；真实账号联调、消息 outbox 与 shadow 对账仍由后续 M3 Issue 验收

## 1. 目标与信任边界

Electron 主进程是原生账号控制边界。telegram-tt guest 页面始终视为不可信内容：它可以
报告自己的 Telegram self user id、桥接事件和翻译输入，但不能读取 im-hub 用户 JWT、
account-control grant、服务端地址、Node.js 或任意 IPC。

可信外壳 renderer 仍持有普通用户 session，用它向服务端申请按账号签发的短时 grant；
主进程把 grant 与受控 webview 的 `persist:native-<accountId>`、宿主 webContents 和 guest
webContents 绑定。任何命令或代理请求都必须同时通过本地主进程状态与服务端实时校验。

manager/auditor 的“可见”范围不是控制权限。只有 `accounts.owner_user_id` 对应的未禁用、
非 auditor 用户可以签发；服务端每次使用 grant 时重新读取账号 owner、平台身份、控制版本
和用户状态。

## 2. 平台身份来源

migration `0006_native_account_control` 为 `accounts` 增加：

- `platform_account_external_id text null`：Telegram 当前账号的稳定 self user id。
- `native_control_version integer not null default 0`：账号级撤销版本。

后台 TDLib adapter 在 `authorizationStateReady` 后调用 `getMe`，校验正安全整数并上报
`user.id`；`authorizationStateClosed` 上报 null。身份值变化时服务端更新账号行并原子增加
`native_control_version`，使所有旧 grant 立即失效。已有账号在 adapter 再次 ready 前不能
签发 grant，接口明确返回“平台身份尚未就绪”，不会猜测磁盘 session 或 display name。

telegram-tt 从全局状态读取 `currentUserId`，通过 Bridge v2 发
`account.identity { platformAccountExternalId }`。初始鉴权状态未知不等于退出；只有页面曾经
上报真实 self id 后转为非 ready，才发 `account.signed-out`，避免启动恢复期间误清分区。

## 3. Account-control grant

`POST /api/accounts/:id/native-control-grant` 使用普通 Bearer session，按 owner 行锁签发：

- JWT header `typ = im-hub-native-control+jwt`，payload `kind = native-control`。
- 绑定随机 grant id、user id、account id、`platform=telegram`、预期 Telegram self id、
  `native_control_version`、签发时间和过期时间。
- 固定有效期五分钟；每次重新签发先增加版本，因此同一账号只有最新一枚 grant 生效。
- grant 不落库；数据库只保存非敏感的平台 external id 与撤销版本。

`POST /api/native/control-grant/verify` 只返回账号、平台、预期 external id 和过期时间，不
回显 grant 或用户 session。`DELETE /api/native/control-grant` 以 compare-and-increment 撤销
当前版本。native JWT 与 12 小时用户 session 使用不同 typ/kind，彼此不能替代；上线前已
签出的无类型旧 session 只在原有剩余有效期内兼容，新的 session 全部带明确类型。

服务端的 native context/events 与 translate detect/batch 在每次请求时校验 JWT 签名、
过期时间和账号行的 owner/platform/external id/version/用户状态。请求 body 的 accountId
必须与 grant 相同；普通 Bearer session 不能直接调用 native context/events。

## 4. 主进程状态机与代理

主进程的 registry 以 guest webContents id 为键保存：宿主绑定账号、短时 grant、预期与
实际 external id、过期时间和 revoked 状态。

状态流转：

1. grant 已验证但 guest 尚未报告身份：`waiting`，不开放任何能力。
2. 实际 self id 与预期一致：`ready`。
3. 身份不一致、signed-out、过期或服务端返回 401/403：`blocked`，立即停止命令与代理。
4. 身份后来恢复一致但旧 grant 已撤销：回到 `waiting`，由外壳重新申请 grant。

主进程在发送原生命令前再次调用服务端 verify，避免服务端撤销后仍继续发送。同步会话、
回传事件和翻译代理都只从 registry 取得 grant；服务端 401/403 会同时阻断本地状态。所有
blocked 与 webview 加载失败路径向 UI 发固定、无敏感信息的提示，并以账号 UUID 的前八位
写脱敏日志。

guest preload 只暴露：

- `emit` / `onCommand` 的 Bridge v2 typed API；
- `translateBatch` / `detectLanguage` 的窄代理 API。

telegram-tt 不再读取 `window.__IM_HUB__`，也不直接向 im-hub 发 fetch/Bearer 请求。
`executeJavaScript` 注入与回读 JWT 的历史路径已删除。

## 5. 清理语义

- webview reload/unmount：先从 registry 移除能力并尽力撤销 grant。
- im-hub 用户退出：释放所有本地主进程能力。
- Telegram `account.signed-out`：释放该 guest 的 grant/观察身份，并清除对应
  `persist:native-<accountId>` storage 与 cache。
- 删除 im-hub 账号：服务端删除完成后，主进程只关闭该账号 guest，清除对应 registry
  项与 partition；不使用模糊前缀或跨账号清理。若本机清理失败，删除对话明确要求人工处理。

分区清理不代替 Telegram 平台的设备管理；平台侧仍需人工动作时沿用账号删除接口返回的
`manualCleanup` 提示。

## 6. 已验证与剩余边界

自动测试覆盖 token 类型隔离、签名/过期、owner/manager/auditor、身份变更与显式撤销、
Bearer 绕过、跨账号 grant、翻译代理、主进程等待/匹配/不匹配/过期/signed-out 状态，以及
partition/account 解析。`0006` 只在按规则派生的测试库执行验证。

M3-2 不宣称完成 telegram-tt 的 context/composer/message outbox 接线、发送 attempt 幂等、
真实 Telegram fixture、TDLib + fork shadow 对账或安装包分发；这些仍按 M3-3 至 M3-5
及后续发布任务验收。
