# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

跨境电商 IM 聚合客服工作台。多平台账号多开、消息自动翻译、发送前译文校对、
基于角色的可见范围。用户是中文母语者，**回复一律用中文**，代码/命令/报错保持原文。

## 常用命令

```bash
# 所有服务端命令都要先加载 .env，否则 config.ts 的 zod 校验会直接退出
set -a && . ./.env && set +a

pnpm dev:server                          # 服务端 :4000（tsx watch）
pnpm dev:desktop                         # Electron 客户端（渲染进程 :5173）
pnpm typecheck                           # 全 workspace tsc --noEmit
pnpm test                                # 全量测试
pnpm exec vitest run <文件路径>           # 跑单个测试文件
pnpm exec vitest run -t "用例名片段"       # 按用例名跑

pnpm db:migrate                          # 跑 migration
pnpm --filter @im-hub/server seed        # 幂等 seed（保留已有主键，见下）
pnpm --filter @im-hub/server preflight    # 起飞前体检：8 项依赖与凭据检查
pnpm --filter @im-hub/server reset-account "<账号名>"  # 把某账号退回未登录
```

本机依赖走 Homebrew，不用 Docker：`brew services start postgresql@16 redis`。
`psql` 不在 PATH 里，全路径是 `/opt/homebrew/opt/postgresql@16/bin/psql`。

`docker-compose.yml` 是给部署/CI 用的，本机开发不需要。

## 两条并存的平台接入路线

这是理解整个仓库最关键的一点。同一个产品目标有两套实现，**都还活着**：

**路线 A：自建界面 + 适配器**（P0/P1a，`packages/server/src/adapters/`）
消息经适配器归一化成 `NormalizedMessage` 落库，客户端用我们自己的 UI 渲染。
数据在我们手里，客户档案/关键词告警可以直接接。代价是平台的每样能力都要重新
实现一遍——目前只处理纯文本，图片/群名/联系人名都没做。

**路线 B：套壳打过补丁的开源客户端**（当前主攻方向）
`代码/telegram-tt`（与本仓库同级的独立 git 仓库）是 Telegram Web A 的 fork，
改了源码把翻译接到本仓库的翻译网关，构建产物由 Electron 的 `<webview>` 加载。
群组、图片、语音、回复引用天生就有。

转向的原因、代价与保留/替换清单见
`docs/superpowers/specs/2026-08-25-native-client-pivot.md`，**动这块之前先读它**。
Telegram、Signal、WhatsApp 都保留；Zoom 延后。当前只有 Telegram 原生 webview
骨架可运行，Signal 仍有 signal-cli 适配器，不能把“保留平台”写成“已经完成”。

## 架构

pnpm workspace，三个包：

- `packages/shared` — 跨端类型。`NormalizedMessage` 是落库前的唯一中间表示；
  `WsServerEvent` 是所有 WebSocket 事件的联合类型
- `packages/server` — Fastify 5 + Kysely + BullMQ
- `packages/desktop` — Electron 33 + electron-vite + React 19 + zustand

服务端主要分层：

```
adapters/     平台适配器（telegram/tdlib、signal/signal-cli），实现 PlatformAdapter
ingest/       归一化消息落库 + 去重 + 入翻译队列
pipeline/     BullMQ 翻译任务
translation/  翻译网关：多引擎、四级配置、缓存、降级
rbac/         可见范围
api/          路由、WsHub、Fastify 组装
db/           migration、seed、运维脚本
index.ts      组合根：把上面这些接在一起
```

### RBAC 是结构性的，不是检查性的

路由**不允许 import db 读业务数据**，只能用 `req.scoped`（`ScopedDb`）——
它把当前 actor 的可见范围闭包进去了，漏过滤在结构上不可能发生。

`resolveScope` 的 switch 没有 default 分支，靠 TS 穷尽性检查保证新增角色不会
被漏掉。`Actor.leadTeamIds` 必须每请求实时查，不要缓存进 JWT。

例外：**创建和删除**账号不走 scoped。scoped 的语义是「能看见」，而这些操作
要求「是本人的」——用 scoped 会让 manager 能替下属完成登录、拿走他的账号。
这一层用 `requireOwnedAccount` 按 owner 取。

### 适配器契约

`PlatformAdapter`（`adapters/types.ts`）除收发消息外还有几个容易忽略的通道：

- `onAuthChallenge` / `submitAuthAnswer` — 扫码链接、验证码、二次验证密码
- `onCredentialsUpdated` — 鉴权成功时写 `accounts.credentials_ref`
- `onMessageIdRemapped` — 平台把临时 id 换成最终 id
- `purge` — 删账号时清除本机平台数据

`connect()` 必须建完连接就返回，鉴权异步进行。阻塞式的 `connect` 会让一个
待登录账号卡住整个服务端启动。

## 容易重复踩的坑

这些都是实际踩过并修掉的，改相关代码时留意：

- **测试库必须独立**。`testDatabaseUrl()` 强制在开发库名后加 `_test`，不从环境
  变量读。历史上一次 `vitest run` 清空过开发库，连带 TDLib session 变孤儿
- **seed 必须 upsert 保留主键**。`accounts.id` 是 TDLib session 的目录名，
  重新生成 UUID 会让已登录账号凭空掉线。这个坑踩过两次
- **自动重连看 `credentials_ref` 而不是 `status`**。status 在员工手机上解除
  设备授权后仍是 connected；TDLib 数据目录在鉴权完成前就建好了，也不能拿它判断
- **消息去重靠 `(account_id, platform_message_id)`**。Telegram 和 Signal 都要
  保证同一条消息经不同路径算出同一个 id，否则会存两行
- **`@fastify/cors` v11 的 `methods` 默认只有 GET/HEAD/POST**，必须显式列出。
  curl 不发 Origin、不触发预检，所以 curl 测试会给出假信号
- **Electron `sandbox: false` 是必须的**。ESM preload（.mjs）在沙箱下静默不加载，
  表现是白屏且零提示
- **敏感值不落地**。JWT 只在渲染进程的模块变量里，持久化走 `safeStorage`；
  二次验证密码只活到 `checkAuthenticationPassword` 返回为止，不写库不打日志
- **静默丢弃是最坏的失败方式**。收到未登记账号的消息、注入配置失败、webview
  加载不出来——这几处都必须留下明确日志或界面提示，不要静默

## telegram-tt fork（`../telegram-tt`）

独立 git 仓库，不在本 workspace 内。上游自带一份 `CLAUDE.md`（Teact、SCSS
modules、代码风格），**遵守它**。

```bash
cd ../telegram-tt
npm run dev              # :1234，Electron 的 webview 加载这个地址
npx tsc --noEmit -p .    # 改完必须过，仓库要求零错误
```

补丁原则：**改动压到最小，方便跟上游 rebase**。所有对 im-hub 的调用收在新增
文件里（`src/util/imhub.ts`、`components/middle/composer/ImHubComposer.tsx`），
不得不改上游文件时，每处都加 `im-hub 补丁` 注释写清原因。改动清单见该仓库的
提交记录。

已知需要绕开的上游行为：翻译入口有多道 Premium 门禁；
`chat.detectedLanguage` 全代码库无人写入，所以「整聊天翻译」那条路上游自己
就没通，自动翻译要另外打开。

## 文档

- `docs/features/` — 按模块的功能对照:需求出处、实现状态、代码位置、取舍
- `docs/RUNBOOK.md` — 从零环境到跑通真实链路
- `docs/superpowers/specs/` — 设计决策与架构转向记录
- `docs/superpowers/plans/` — 分阶段实现计划，与代码同步维护

改了架构层面的东西，顺手更新对应文档——这些文件是后来者理解「为什么这么写」
的唯一来源。
