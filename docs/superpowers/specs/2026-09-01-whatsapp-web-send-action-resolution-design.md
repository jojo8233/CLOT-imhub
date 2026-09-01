# WhatsApp Web 发送控件解析与单次真实发送设计

日期：2026-09-01  
状态：待用户审阅

## 1. 背景

WhatsApp Web 的 TranslationDock 草稿链已经通过真实无发送验收：译文只写入一份、guest 确认原生
composer 正文、发送按钮在外壳中可用。随后唯一一次发送尝试在 guest 的 `sendButton()` 选择器处返回
`whatsapp_send_unavailable`；草稿未清空，发送前 DOM ID 尚未快照，pending attempt 尚未写入，页面发送
控件也未被点击，因此真实发送数仍为 0。

现有发送安全边界已经存在且不应重写：`attemptId`、初始 `contextRevision` 与最终草稿 SHA-256 绑定；
双击先由进程内 guard 串行化；pending/confirmed attempt 由独立 IndexedDB 账本恢复；点击后只有发送前
不存在、正文匹配、方向为出站且带实际 WhatsApp DOM `data-id` 的消息容器才能确认成功。

本轮只修复原生发送动作解析，使 DOM 变化不能把系统逼到猜测按钮、按 Enter 或放宽最终消息证明。

## 2. 目标与非目标

### 目标

- 从当前 composer 所属 footer 内解析唯一、可用且具有明确 send 语义的原生控件。
- 兼容 send 语义位于交互控件本身或其后代节点的 WhatsApp DOM 形状。
- 发送前和 pending attempt 写入后各解析一次；第二次必须仍是同一个控件。
- 找不到、不可用或语义冲突时在点击前明确失败，且不留下 pending attempt。
- 保留既有 attempt、草稿指纹、会话 currentness、最终出站 DOM ID 和恢复语义。
- 用无 jsdom 的结构化 fake 覆盖选择器变化与安全矩阵。
- 合成验证通过后，从 a50 不透明配置生成 a51；由用户在 TranslationDock 最多手动发送一条无敏感纯文字。

### 非目标

- 不为发送增加 Enter、键盘快捷键、坐标或按钮位置 fallback。
- 不读取按钮周围聊天正文，不记录 aria label、账号标识、具体 DOM ID 或草稿正文。
- 不修改 Telegram、Signal、Cloud API、IPC/native bridge 协议、composer 草稿写入或平台消息 ID 算法。
- 不把 WhatsApp DOM 消息接入中央归档，不新增媒体、引用、回应或删除语义。
- 不为双击、切会话、改稿、超时、结果丢失或重启矩阵重复真实发送。

## 3. 方案选择

采用结构化发送控件解析，不采用“只补 CSS selector”或 Enter fallback。

只补 selector 改动最小，但无法证明选择的是当前 composer 的唯一发送动作，也会继续把生产 DOM 查询藏在
不可测试的 bridge 私有函数中。Enter 可能触发换行、被输入法拦截或在页面状态变化时产生误发，不符合
最多一条真实消息和不确定结果禁止重发的门槛。

结构化解析把 DOM 查询、交互祖先定位、可用性事实与纯选择决策分离，既能覆盖本次直接 send icon 形状，
也能在 WhatsApp 再次变化时安全失败。

## 4. 组件边界

### 4.1 泛型 DOM port

在 `packages/desktop/src/preload/whatsapp-web-send-action.ts` 新增泛型端口，不引用测试 fake：

```ts
export interface WhatsAppSendActionDomPort<Node extends object> {
  query(scope: Node, selector: string): readonly Node[]
  interactiveTarget(signal: Node): Node | null
  isWithin(scope: Node, target: Node): boolean
  isConnected(target: Node): boolean
  isVisible(target: Node): boolean
  isDisabled(target: Node): boolean
}
```

生产 bridge 以当前 composer 的 `closest('footer')` 作为 scope。`query` 只在该 scope 内执行；
`interactiveTarget` 只接受 `button` 或 `[role="button"]` 本身/最近祖先。`isVisible` 同时要求非零 client rect、
`display`/`visibility` 可见和 `pointer-events` 未禁用；`isDisabled` 检查原生 `disabled` 与
`aria-disabled="true"`。

### 4.2 语义信号与可信度

解析器持有集中、可测试的语义 selector 清单：

- 强信号：精确 `data-testid="compose-btn-send"`、精确 `data-testid="send"`、精确 `data-icon="send"`；
- 受控弱信号：交互控件规范化后的 aria-label 必须精确等于 `send`、`发送` 或 `发送消息`；
  不做 substring、正则或未知语言猜测。

`data-icon="send"` 必须直接查询，因此既覆盖 icon 位于 button 内，也覆盖 icon 节点自己就是
`[role="button"]` 的页面结构。不得用颜色、横向位置、footer 最后一个按钮或任意 SVG 作为 send 证据。

### 4.3 纯解析结果

```ts
export type WhatsAppSendActionResolution<Node> =
  | { kind: 'resolved'; target: Node }
  | { kind: 'unavailable'; reason: 'no-scope' | 'missing' | 'unusable' | 'ambiguous' }
```

算法依次：

1. 按可信级别查询 signal；
2. 映射到交互 target，并拒绝 scope 外 target；
3. 按对象身份去重，同一 button 被 test id 与 icon 同时命中只算一次；
4. 过滤未连接、隐藏、禁用 target；
5. 最高非空可信级别只有一个 target 才返回 resolved；同级多个返回 ambiguous；
6. 强信号存在但全部不可用时返回 unusable，不降级到弱信号猜另一个控件。

## 5. 发送数据流

`whatsapp-web-bridge.ts` 不再调用私有 `sendButton()`，而是：

```text
验证 command context
→ guard 绑定 attemptId / 初始 revision / 草稿 fingerprint
→ 恢复既有 attempt（confirmed 返回旧结果，pending 阻止重发）
→ 重验新 attempt revision 与页面草稿 SHA-256
→ 从当前 composer footer 解析唯一 send target
→ 快照当前会话全部既有 DOM IDs
→ 写入 pending attempt
→ 重验 context 与草稿
→ 再次解析 send target，要求仍 resolved 且对象身份与首次 target 相同
→ click 一次
→ 等待新增、正文匹配、方向为 out、带实际 data-id 的容器
→ 写 confirmed attempt 并返回 wa-dom 来源 ID
```

第二次解析失败、变成歧义、控件被替换或会话/草稿变化时，先删除本次 pending attempt，再返回
`attempt_context_mismatch` 或安全的 send-action 错误，不点击。点击后超时、结果丢失或账本更新失败仍保持
unknown/pending，绝不自动点击第二次。

## 6. 错误与诊断

- 首次解析 `no-scope/missing/unusable/ambiguous`：发送前失败，不写账本、不点击。
- 写账本后的第二次解析不再指向同一 target：删除 pending attempt，不点击。
- 错误信息只暴露稳定类别，例如“未找到唯一可用的 WhatsApp 发送控件”；不回显 selector、aria label、
  DOM 属性值、正文、账号或消息 ID。
- 不把一次 send-action 失败升级为气泡翻译 selector 故障；两条诊断通道保持分离。
- 点击后的未知结果继续使用 `whatsapp_send_result_unknown`，让 pending attempt 阻止人工或自动重发。

## 7. 测试设计

### 7.1 发送控件解析器

使用结构化 fake node/port 覆盖：

- send icon 直接位于 `[role="button"]` 本身；
- send icon 是 button 后代；
- 精确 send test id；
- 同一 target 被多个强信号命中时按身份去重；
- 隐藏、断连、disabled、`aria-disabled` 或 scope 外 target 被拒绝；
- 两个不同强信号 target 同时可用时返回 ambiguous；
- 强信号不可用时不降级到弱信号误选；
- 唯一 `send` / `发送` / `发送消息` aria target 可解析，未知或 substring label 不可解析；
- 二次解析 target 身份变化时 preflight 失败。

### 7.2 既有发送矩阵回归

保持并重新运行：

- 同 attempt 双击、不同 binding 改绑；
- 用户改稿、切会话、按钮失联；
- 草稿 SHA-256 页面重算；
- pending/confirmed 的结果丢失和进程重启恢复；
- 发送前已存在、同文入站、异文出站、缺 DOM ID 的拒绝；
- 新增且正文匹配、方向为出站并有实际 DOM ID 的唯一成功。

测试不依赖真实 WhatsApp、jsdom、profile 或数据库正文。

## 8. 验证与真实验收

代码阶段至少运行相关 preload tests、`pnpm typecheck`、desktop production build 和全量 `pnpm test`。
沙箱若只因本机 PostgreSQL `EPERM` 失败，用完全相同命令在沙箱外连接既有隔离测试库，不加载或打印
`.env`。

验证后从 `/private/tmp/Signal-imhub-integrated-a50.app` 不透明配置生成 a51 并执行 deep/strict codesign。
保持服务端和 Telegram 运行，不重做已通过的平台切换、Signal、WhatsApp 登录、气泡翻译或滚动矩阵。

用户在现有 WhatsApp 会话中输入一条无敏感纯文字，经 TranslationDock 得到单份草稿后只点击一次发送。
成功必须同时满足 guest 内部证据：发送前不存在匹配容器、正文匹配、方向为出站、取得最终实际 DOM
`data-id`；用户只反馈发送状态、草稿是否清空、消息是否出现和错误诊断，不回传正文、账号或 DOM ID。

如果点击后结果未知，立即停止，不生成第二次真实发送。双击、切会话、改稿、命令超时、结果丢失与重启
只以合成测试验收。

## 9. 文档与交付

完成后在 `docs/superpowers/specs/2026-08-29-signal-whatsapp-parallel-checkpoint.md` 新增下一节，记录：

- 结构化 resolver 与生产 bridge 接线；
- 合成测试、typecheck、build、全量测试和 codesign 的精确结果；
- a51 最多一条真实发送的实际结果；
- 真实发送数、PR #19 未合并、Issue #12 未关闭；
- 不记录正文、账号标识、具体 DOM ID、profile/session 或秘密。
