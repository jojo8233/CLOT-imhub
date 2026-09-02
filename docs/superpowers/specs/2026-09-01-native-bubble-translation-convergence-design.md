# 原生气泡翻译编排收敛设计

日期：2026-09-01
状态：设计已确认，待实施计划

## 1. 背景

Telegram 与 Signal 的原生气泡双语显示已经通过真实验收，但两端的实现基础不同：

- Telegram fork 复用 Teact 上游消息翻译状态，按 500ms 节流、每批最多 20 条入队，维护
  pending/成功/失败状态，再把 im-hub 批量翻译结果按原顺序回填。
- Signal 从中央消息管线接收已保存的译文，应用结果前校验规范消息键、方向、发送者、时间戳和
  revision，避免迟到结果写到错误消息。
- WhatsApp Web 从第三方页面 DOM 读取当前气泡并插入 marker。当前实现已经能显示既有入站与出站
  纯文字译文，也通过了滚动增量真实验收，但队列、并发、marker 状态和 DOM 生命周期仍集中在
  `whatsapp-web-bridge.ts`，与翻译网关编排分离不完整。

提交 `9f27487` 已建立第一层共用基础：

- `packages/shared/src/translation.ts` 统一语言代码规范和中英双向目标策略；
- `packages/desktop/src/preload/native-translation-coordinator.ts` 统一检测、单条翻译、同文并发去重、
  500 条缓存、未知语言纠偏和失败清理；
- WhatsApp 已改用该 coordinator，但仍按单条任务调用，尚未复用 Telegram 已验证的批处理与
  pending 生命周期。

本设计完成第二层收敛：移植已验证的行为契约，而不是复制 Telegram 的 Teact 组件或 Signal 的
消息 ID 算法。

## 2. 目标

1. 抽取无界面的原生气泡翻译控制器，统一可见消息入队、节流、批量、去重、pending、失败和重试。
2. 扩展现有 coordinator，使同一批不同语言的文本能按目标语言分组调用既有批量翻译代理，并保持
   输入输出顺序。
3. 把 Signal 已验证的“结果必须仍绑定当前消息事实”设为控制器契约，WhatsApp 回填前必须确认会话
   generation、DOM 节点、正文快照均未变化。
4. WhatsApp 只实现 DOM 适配：发现消息、创建 marker、应用状态和点击重试，不再私有维护通用队列。
5. 不改变 Telegram、Signal 已验收的运行路径，不触碰 WhatsApp 草稿和发送链路。

## 3. 非目标

- 不把 Teact、Signal React 或 WhatsApp DOM 伪装成同一种 UI 组件。
- 不修改 Telegram fork，也不要求 Telegram fork 在本阶段直接依赖 im-hub monorepo 包。
- 不把 Signal 的 sender/timestamp 消息键、Telegram chat/message ID 或 WhatsApp DOM `data-id` 相互套用。
- 不让 WhatsApp Web 消息进入 Signal 的中央译文 store；完整 WhatsApp 消息入库是独立范围。
- 不修改 `TranslationDock → composer.set-draft → composer.send`，不借本阶段进行真实发送。
- 不增加依赖，不修改翻译服务端协议，不重启服务端或 Telegram。
- 不处理媒体、引用、系统提示、表情回应等非纯文字气泡。

## 4. 方案选择

### 4.1 采用：共用无头控制器 + 平台适配器

共用层只处理与平台无关的状态机；平台层继续拥有消息身份、当前性校验和显示方式。这既能复用
Telegram 的成熟编排，又能沿用 Signal 的防串绑原则，并把 WhatsApp DOM 变化限制在适配层。

### 4.2 不采用：复制 Telegram 源码到 WhatsApp preload

Telegram 的队列依赖 Teact global、chatId/messageId 和上游 translation cache。直接复制会在
WhatsApp DOM 中制造第二套不适配的状态模型，且增加跟随 Telegram 上游变更的冲突面。

### 4.3 不采用：强制 WhatsApp 走 Signal 中央消息管线

该方案要求先完成 WhatsApp 消息规范身份、入库、revision 和 WebSocket 同步，显著扩大范围，也会
重复已经通过的 DOM 可见气泡路径。

## 5. 架构边界

### 5.1 跨端策略层

`packages/shared/src/translation.ts` 继续只负责纯函数与跨端类型：

- provider 语言代码规范；
- 中文译英文、其他语言译中文的目标策略；
- 批量请求/结果的共享形状。

它不依赖 DOM、定时器、Electron 或平台消息 ID。

### 5.2 网关编排层

`packages/desktop/src/preload/native-translation-coordinator.ts` 保持窄代理边界，并增加批量入口：

- 输入为有序文本列表，输出与输入等长且顺序一致的逐项结果；
- 空白文本不请求网关，作为逐项失败返回；
- 相同正文共享正在进行的操作和缓存结果；
- 先规范预检测语言，再按 `(sourceLang, targetLang)` 分组调用现有 `translateBatch`；
- 预检测未知时允许使用批量结果的 detected language 做至多一次目标纠偏；
- 一个分组或单项失败不能抹掉其他成功项；失败项不进入缓存，可由下一次入队重试；
- 每次送入网关的文本数量不超过 20；缓存继续保持最多 500 条；
- 保留现有单条 `translate(text)` 兼容入口，由批量实现提供结果。

这里不知道消息来自哪个平台，也不接触 marker。

### 5.3 气泡翻译控制层

新增 `packages/desktop/src/preload/native-bubble-translation-controller.ts`。控制器接收不透明消息引用、
正文快照和平台回调，负责：

- 新观察到的消息立即进入 pending，并去重同一观察；
- 500ms 聚合窗口，每批最多 20 条；
- 最多 3 个活动批次，保持 WhatsApp 当前并发上限；
- 成功、逐项失败和整批失败都结束 pending；
- 平台当前性回调返回 false 时丢弃结果，不写成功或失败 UI，并请求后续重新扫描；
- `reset()` 清空排队项、定时器与观察状态并推进 generation；已经发出的网络请求可以结束，但结果
  不能跨 generation 回填；
- 失败观察可显式 `retry()`，不会因失败缓存永久阻塞。

控制器只发出 pending/success/failure 生命周期，不包含“翻译中…”等界面文字。

### 5.4 WhatsApp DOM 适配层

`packages/desktop/src/preload/whatsapp-web-bridge.ts` 保留现有选择器、可见性诊断和 marker 渲染，但改为
向共用控制器提供回调：

- 扫描到纯文字行时以 `HTMLElement + 正文快照 + 当前会话 generation` 入队；
- pending 创建 marker 并显示“翻译中…”；
- success 仅在节点仍连接、正文仍相等、会话 generation 未变化时写入译文；
- failure 显示“翻译暂不可用 · 点击重试”，点击后删除失败状态并重新入队；
- 身份退出、账号变化或 `platformConversationId` 真正变化时调用 `reset()`；显示名等同会话元数据变化
  不触发 reset，也不改变 composer `contextRevision` 规则；
- selector/marker 可见性诊断继续留在 WhatsApp 适配层，不进入共用控制器。

旧的 `translationQueue`、`queuedRows`、`activeTranslations` 和手写 drain 逻辑从 WhatsApp controller
移除；DOM marker、`translatedRows` 或等价的已应用快照仍属于适配层。

### 5.5 Telegram 与 Signal

本阶段不修改两端代码：

- Telegram 是行为基线，继续使用 Teact 上游状态和自身固定目标语言配置；
- Signal 继续使用中央翻译消息和 `SignalDesktopTranslationStore`；
- 共用控制器的接口必须允许未来适配两端，但不为了形式上的复用改写已经验收的路径。

## 6. 数据流

1. WhatsApp MutationObserver 或周期扫描发现新的纯文字气泡。
2. DOM 适配层生成观察快照并调用控制器入队；控制器立刻通知 pending。
3. 500ms 到期后，控制器取最多 20 条交给 coordinator。
4. coordinator 对未命中缓存的文本做语言检测，按语言组合并调用现有批量代理；逐项结果恢复原顺序。
5. 控制器逐项询问适配层该观察是否仍为当前事实。
6. 当前且成功的结果写入译文；当前但失败的结果进入可重试失败状态；过期结果静默丢弃并触发重扫。
7. 滚动加载继续走相同流程，不需要页面重载。

## 7. 错误与安全

- 翻译失败必须结束 pending；禁止永久显示“翻译中…”。
- 失败仅显示稳定用户文案和非敏感错误码，不向 DOM 或 host 诊断写 provider 原始异常正文。
- 过期结果不是用户可见错误，不产生误导性“翻译失败”。
- 分组批量失败只影响该分组；其他分组照常回填。
- 页面结构持续失配仍使用现有墙钟防抖诊断，短暂虚拟列表抖动不报错。
- 测试 fixture 只使用合成、无敏感正文；不读取 `.env`、profile/session、数据库正文、账号标识、
  具体消息键、媒体引用、token、二维码或密钥。

## 8. 测试设计

### 8.1 Coordinator 单元测试

- 同目标文本合并为一次批量请求且保持输入顺序；
- 超过 20 条时拆批；
- 中英文混合时按目标语言分组；
- 重复正文复用同一结果；
- 预检测未知后的单次纠偏；
- 单项失败、整组失败与成功项隔离；
- 失败不缓存、成功缓存、`clear()` 后重新请求。

### 8.2 控制器单元测试

- 500ms 前不发送、到期后批量发送；
- 21 条拆成 20 + 1；
- 同一观察不会重复 pending 或重复请求；
- 成功、失败都结束 pending，失败可以单次重试；
- 最多 3 个活动批次；
- 正文变化、DOM 断开、切会话和 `reset()` 后的迟到结果不回填；
- 翻译请求超时、迟到结果和控制器状态重建用合成测试覆盖，不进行真实平台消息制造。

### 8.3 WhatsApp DOM 合成测试

- 既有入站/出站纯文字均创建一个译文 marker；
- 滚动后新增行增量入队，已有行不重复；
- 虚拟列表复用节点且正文变化时不写旧译文；
- 同一会话显示名变化不清空；真正切会话清空 marker 与旧队列；
- 失败 marker 每次点击只生成一个重试观察，连续点击不会并发重复入队；
- selector 短暂失配继续服从现有墙钟门槛。

### 8.4 验证命令与真实门槛

- `pnpm exec vitest run` 执行新增及 WhatsApp/Signal/共享翻译相关测试；
- `pnpm typecheck`；
- `pnpm test`，数据库测试只允许连接隔离 `_test` 数据库；
- `pnpm --filter @im-hub/desktop build`。

因为实现会修改 WhatsApp 气泡翻译边界，自动化通过后需要用新测试包只复验受影响部分：当前可见
既有入站/出站纯文字和滚动加载后的增量译文。复验不得发送消息，也不重复平台切换、Signal、登录、
生命周期、503 outbox 或 composer/send 矩阵。

## 9. 完成标准

- WhatsApp 不再私有维护通用翻译队列，使用可独立测试的无头控制器；
- 对网关的翻译调用按最多 20 条批处理，不因 DOM 行数退化为逐条批量请求；
- pending、成功、失败、重试和 reset 行为由共用测试固定；
- 迟到结果无法跨正文变化、节点复用或会话切换写入；
- 当前可见和滚动新增的既有入站/出站纯文字继续显示单份双语内容；
- 所有自动化、typecheck、desktop build 通过；
- 真实发送数保持 0，PR #19 不合并，Issue #12 不关闭。
