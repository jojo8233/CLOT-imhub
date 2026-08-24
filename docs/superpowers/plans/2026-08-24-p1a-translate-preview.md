# P1a：发送前译文确认

> 员工输入中文 → 翻成客户语言 → **看一眼、能改** → 再发出去。
> 现在是点了发送才在下面看到译文，看到的时候已经发出去了，没有挽回余地。

## 已定的设计决策

| 问题 | 决定 |
|---|---|
| 悬停显示什么 | **原文与回译并排**。只给回译没有参照物，员工判断不了 |
| 触发方式 | 按钮 **和** 回车都要。按钮负责可发现性，回车负责熟练后的速度 |
| 误发防护 | 翻译完成后发送键锁 300ms + 焦点移到预览框 |
| 英文预览可编辑 | 是。看出问题却只能回去改中文再重译，很别扭 |
| 目标语言 | **自动跟随客户语言，可按会话锁定**（方案 D） |

## 关于回译的诚实说明

回译**不能证明**翻译正确，它是气味测试：

- 回译通顺 ≠ 翻对了（错译也可能回译得很顺）
- 回译别扭 ≠ 翻错了（正常语序调整回来就会怪）

真正有用的是**和原文对比**，看关键信息有没有丢：价格、数量、否定词、时间、人名。UI 必须把两句并排放，不能只给回译。

---

## Task A：数据模型与服务端

### A1. 持久化检测到的源语言

`messages.body_lang` 这一列从 Task 3 就存在，翻译网关一直返回 `detectedLang`，但从来没人写回去。自动跟随客户语言就靠它。

`pipeline/translate-job.ts` 的 `TranslateJobDeps` 加一个方法：

```ts
saveDetectedLang(messageId: string, lang: string): Promise<void>
```

在 `saveTranslation` 之后调用。**`'und'` 不写**——那是模型没给出语言时的占位值（见 Task 6 的 provider 实现），写进去会污染语言推断。

### A2. migration 0002：会话级语言锁

```ts
await db.schema.alterTable('conversations')
  .addColumn('target_lang', 'text')
  .execute()
```

可空。**null 表示自动跟随客户语言**，有值表示员工锁定了。

### A3. 目标语言解析

新建 `packages/server/src/translation/target-lang.ts`：

```ts
/** 客户语言未知时的兜底。改这个值等于改变所有新会话的默认行为。 */
export const FALLBACK_TARGET_LANG = 'en'

export interface TargetLangSource {
  lockedLang: string | null
  latestInboundLang: string | null
}

/**
 * 决定回复该用什么语言。
 *
 * 优先级：员工锁定 > 客户最近一条消息的语言 > 兜底。
 * 'und' 视为未知——那是模型没能识别时的占位值，不是一种语言。
 */
export function resolveTargetLang(src: TargetLangSource): string {
  if (src.lockedLang) return src.lockedLang
  if (src.latestInboundLang && src.latestInboundLang !== 'und') return src.latestInboundLang
  return FALLBACK_TARGET_LANG
}
```

严格 TDD，测这几条：锁定优先于检测、检测优先于兜底、`und` 被跳过、全空时兜底、锁定为空字符串时不算锁定。

### A4. `POST /api/messages/translate-preview`

只翻译，不发送。

请求：`{ conversationId: uuid, text: string(trim().min(1)) }`
响应：`{ translated, backTranslated, targetLang, provider }`

流程：
1. 经 `req.scoped` 确认会话可见，查不到返回 404
2. 解析目标语言（A3）
3. 正向翻译：中文 → 目标语言
4. 回译：目标语言 → `zh`
5. 两次都走 `gateway`，命中缓存则不花钱

**回译失败不能让整个预览失败**——回译只是辅助。catch 住，`backTranslated` 返回 null，前端显示「回译不可用」。

### A5. `send` 接口支持直发已翻译文本

现在的 `send` 收中文然后服务端翻译。预览流程要求**发出去的就是员工看到并确认过的那段文本**，不能再翻一次（重译结果可能和预览不同）。

`sendBody` 改成：

```ts
const sendBody = z.object({
  conversationId: z.string().uuid(),
  body: z.string().trim().min(1, '消息内容不能为空白'),
  /** true 表示 body 已经是目标语言，原样发出不要再翻译 */
  preTranslated: z.boolean().default(false),
  targetLang: z.string().min(2).optional(),
})
```

- `preTranslated: true` → 跳过翻译，直接 `adapters.send(body)`
- `preTranslated: false` → 保持现在的行为（向后兼容）
- `targetLang` 不传时由 A3 解析

### A6. `PATCH /api/conversations/:id/target-lang`

请求：`{ targetLang: string | null }`（null 表示解锁、回到自动跟随）
经 `req.scoped` 鉴权，更新 `conversations.target_lang`。

---

## Task B：客户端输入区重做

### 交互流程

```
┌────────────────────────────────────────────┐
│ 中文输入框                                  │
│ [回车 或 点「翻译」]                        │
├────────────────────────────────────────────┤
│ 英文预览（可编辑）   ← 悬停显示原文/回译对比 │
│ [回车 或 点「发送」] ← 翻译后锁 300ms       │
└────────────────────────────────────────────┘
   语言：English ▾  [🔒锁定]
```

### 要点

1. **翻译后焦点自动移到英文预览框**——你要按第二下回车，光标已经在该读的内容上
2. **发送键锁 300ms**：正常阅读译文要一两秒，完全感觉不到；连击必然被挡
3. **悬停并排显示**：
   ```
   你输入的：明天下午3点前必须付款
   回译结果：付款必须在明天下午3点之前
   ```
4. **编辑英文后回译要跟着更新**（防抖 600ms），并标记「已手动修改」
5. **语言选择器**显示当前目标语言；锁定图标切换 `target_lang` 的 null / 具体值
6. 发送时一律传 `preTranslated: true` + 预览框里的最终文本

### 状态机

```
空闲 → (输入中文) → 待翻译 → (回车/按钮) → 翻译中 → 已就绪
                                                    ↓ (编辑英文)
                                                 已修改 → (防抖) → 回译更新中 → 已就绪
                                                    ↓ (回车/按钮，且已过 300ms)
                                                  发送中 → 空闲
```

---

## 验收

- [ ] 中文输入 → 回车 → 出现英文预览，焦点在预览框
- [ ] 悬停预览 → 同时看到原文和回译
- [ ] 改英文 → 回译跟着变
- [ ] 再回车 → 发出的是预览框里的文本，不是重新翻译的
- [ ] 翻译完成瞬间连击回车 → 发不出去
- [ ] 客户用日语发来消息 → 目标语言自动变成日语
- [ ] 锁定成英语 → 客户再发日语也不改了
- [ ] 解锁 → 恢复自动跟随
- [ ] 回译服务失败 → 预览仍可用，只是提示回译不可用
