# M5/M6 Signal 与 WhatsApp 并行首检点

日期：2026-08-29
状态：执行中，尚未完成真实账号验收

## 1. 决策

Signal 与 WhatsApp 的使用优先级高于继续等待 Telegram 的生产观察周期，因此两条接入
路线从本 checkpoint 起并行开发。Telegram M3 已完成的真实矩阵和 shadow 证据保持原样，
后续 7 天观察与 canary 仍是独立门槛；启动 M5/M6 不表示这些门槛已经通过。

本 checkpoint 只回答两个最小问题：

1. Signal 能否用当前官方兼容的 `signal-cli` JSON-RPC 完成次要设备关联，并通过现有
   归一化管线完成真实文字收发和中央落库。
2. WhatsApp 官方 Web 能否在 Electron 中按 im-hub 账号使用独立持久 partition 完成扫码、
   保持登录、多账号切换和页面内真实文字收发。

## 2. Signal 首检点边界

- 继续使用 `packages/server/src/adapters/signal/`，不删除或伪装成 Signal Desktop。
- 用户可见的唯一“会话”入口在 Signal 激活时临时显示现有三栏 `ChatWorkspace`，从而测试
  服务端会话、归一化消息、发送和归档；这不是最终原生 Signal UI。
- 关联流程使用 `startLink` 与 `finishLink`，二维码 URI 只经现有鉴权事件发给当前发起人，
  不写日志、不落库；关联成功后只保存 signal-cli 的账号寻址值作为 `credentials_ref`。
- 本 checkpoint 只承诺文字。媒体、编辑、删除、回应、完整回复语义、Signal Desktop 多开、
  固定翻译坞和安装包均属于后续 M5。
- 启动真实测试前必须明确验证本机 `signal-cli` 与所需 Java 运行时。不得因为命令缺失让账号
  无限停在“待登录”而没有诊断。

## 3. WhatsApp 首检点边界

- 只加载精确来源 `https://web.whatsapp.com`，每个 im-hub 账号使用
  `persist:native-<accountId>`；只有账号 owner 能挂载和操控该页面。
- 官方页面不注入 `native-bridge` preload，不注册 control grant，也不能调用 im-hub API。
  页面仍禁用 Node integration，保持 context isolation、web security 和默认拒绝权限。
- 宿主只把官方页面加载成功视为“壳可用”，不能据此声称 WhatsApp 已登录或服务端已连接。
  登录状态当前由页面本身显示，二维码也只在官方页面中出现。
- 账号删除时 Electron 清理对应 partition，并提醒用户在手机“已关联设备”中移除会话。
- 本 checkpoint 只测试官方页面中的文字收发和多开。没有统一消息回传、中央存档、翻译、
  客户档案跟随、审计、告警、媒体桥接、发送确认、去重或故障重放。

## 4. 进入下一 checkpoint 的门槛

Signal 至少取得一个真实账号的：二维码关联成功、冷启动自动恢复、入站文字唯一落库、从
im-hub 发出文字且手机端收到、服务重启后继续收信。WhatsApp 至少取得两个独立测试账号的：
二维码登录、冷启动保持、账号切换不串会话、双向文字收发，以及删除其中一个账号后仅清理
对应 partition。

完成上述证据后再分别设计桥接：Signal 回到最新 Signal Desktop 上游验证独立 profile 和
窗口承载；WhatsApp 先确定可维护且合规的身份/消息事件边界，再决定补丁客户端或其他受控
方案。没有这层设计与服务端 owner 复核前，禁止给官方 WhatsApp 页面注入 Telegram 的通用
preload，也禁止用 DOM scraping 冒充稳定消息协议。
