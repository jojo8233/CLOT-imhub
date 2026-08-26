# AGENTS.md

## 沟通与事实来源

- 面向用户的说明、进度和总结一律使用中文；代码、命令、路径和原始报错保持原文。
- 先阅读与任务直接相关的代码和文档再修改。`package.json`、当前源码与测试是实现现状的第一事实来源；`docs/superpowers/plans/` 是阶段计划，可能落后于代码。
- 架构或产品方向发生变化时，同步更新 `docs/superpowers/specs/` 或 `docs/RUNBOOK.md` 中对应内容，不要只改代码。
- 不读取、打印、提交或在日志中暴露 `.env`、平台会话目录、令牌、API key、二维码链接、验证码和 2FA 密码。需要变量名时只看 `.env.example`。

## 项目概览

这是跨境电商 IM 聚合客服工作台。仓库是 Node.js 22+、pnpm 10 的 TypeScript ESM monorepo：

- `packages/shared`：跨端类型与协议。`NormalizedMessage` 是适配器落库前的统一消息形状，`WsServerEvent` 是 WebSocket 事件联合类型。
- `packages/server`：Fastify 5、Kysely/PostgreSQL、BullMQ/Redis，以及 Telegram、Signal 适配器和翻译网关。
- `packages/desktop`：Electron 33、electron-vite、React 19、zustand。
- `docs/superpowers/specs/`：设计决策；`docs/superpowers/plans/`：分阶段计划；`docs/RUNBOOK.md`：本机运行手册。

目前两条平台接入路线并存，不能因为只看到一条就删除另一条：

1. `packages/server/src/adapters/` 的自建 UI + 适配器路线仍在运行。
2. 当前主攻方向是 Electron 外壳加载打过补丁的开源客户端。改这部分前必须读 `docs/superpowers/specs/2026-08-25-native-client-pivot.md`。

`../telegram-tt` 是同级的独立 Git 仓库，不属于本 workspace。只有任务明确包含它时才修改；进入后先读它自己的 `CLAUDE.md`/`AGENTS.md`，沿用 npm，并把 im-hub 补丁集中、最小化，方便跟上游 rebase。

## 常用命令

使用 pnpm，不要生成 npm/yarn 锁文件。服务端、数据库和测试相关命令执行前先加载根目录 `.env`，因为 `config.ts` 不会自动加载 dotenv：

```bash
set -a && . ./.env && set +a

pnpm dev:server
pnpm dev:desktop
pnpm typecheck
pnpm test
pnpm exec vitest run packages/server/src/path/to/file.test.ts
pnpm exec vitest run -t "用例名片段"
pnpm db:migrate
pnpm --filter @im-hub/server seed
pnpm --filter @im-hub/server preflight
pnpm --filter @im-hub/server reset-account "账号名"
pnpm --filter @im-hub/desktop build
```

- 本机开发默认使用 Homebrew 的 PostgreSQL 16 和 Redis；`docker-compose.yml` 主要用于部署/CI。
- `pnpm test` 中的数据库用例会连接由 `testDatabaseUrl()` 派生的 `<开发库名>_test` 并清表。运行前确认测试库存在；绝不能把测试指向开发库或生产库。
- 当前 `seed.ts` 是保留已有主键的幂等 upsert。不要改回 truncate/重建：`accounts.id` 与 TDLib session 目录绑定，换 id 会使已登录会话成为孤儿。
- 变更至少运行 `pnpm typecheck` 和相关测试；跨包、共享类型、RBAC、数据库或消息管线变更再运行全量 `pnpm test`。桌面构建相关变更另跑 desktop build。

## 编码约定

- TypeScript 开启 `strict`；server/shared 还开启 `noUncheckedIndexedAccess`。不要用 `any`、`@ts-ignore` 或非空断言绕过设计问题。
- 保持现有 ESM 习惯：源码内部相对导入使用 `.js` 后缀，类型导入使用 `import type`。
- 遵循邻近代码风格：单引号、无分号、2 空格缩进、显式领域类型。优先小而聚焦的修改，不做与任务无关的重构。
- 测试文件与源码同目录，命名为 `*.test.ts`。修 bug 时先覆盖失败路径或增加回归测试。
- 新增共享 API、平台、角色或 WebSocket 事件时，先更新 `packages/shared` 的联合类型，再处理所有穷尽分支和消费者。
- 数据库结构变化必须新增 migration；不要改写已经提交并可能执行过的 migration。

## 必须守住的架构边界

- RBAC 是结构性边界：业务路由读取可见数据只能使用 `req.scoped`/`ScopedDb`，不能直接 import `db`。账号创建、删除等所有权操作按 owner 校验，不要用“可见”代替“本人拥有”。
- `resolveScope` 保持穷尽性 switch，不添加吞掉新角色的 default；`Actor.leadTeamIds` 每次请求实时读取，不缓存进 JWT。
- `PlatformAdapter.connect()` 建立客户端后必须尽快返回，鉴权在事件通道异步完成；一个待登录账号不能阻塞服务端启动。
- 自动重连以 `credentials_ref` 为准，不能只看 `status` 或磁盘目录。
- 消息去重键是 `(account_id, platform_message_id)`；修改 id 归一化或临时 id 映射时要保证同一条消息经不同路径算出同一个 id，并有测试覆盖。
- Electron 的 `sandbox: false` 是当前 ESM preload 能加载的必要条件，除非同时完成并验证 preload 架构迁移，否则不要改。
- `@fastify/cors` 必须显式允许 PATCH/PUT/DELETE/OPTIONS；只用 curl 验证会漏掉浏览器预检问题。
- WebSocket token 走鉴权首帧，不放 query string。JWT 只保存在渲染进程内存，持久化必须经 `safeStorage`。2FA 密码只能短暂存在内存，不能落库或进入日志/错误文本。
- 未登记账号、配置注入失败、webview 加载失败和适配器崩溃都必须产生明确日志或 UI 提示；禁止静默丢弃。

## 提交前检查

- 检查 `git diff`，确保没有 `.env`、`data/`、构建产物或无关改动。
- 确认受影响的权限边界、失败路径、消息去重和敏感信息处理都有相应测试或明确验证。
- 若修改行为与文档不一致，以修正后的代码为准并同步文档，避免继续传播已经过期的运行说明。
