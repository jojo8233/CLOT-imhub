# Signal 既有账号身份只读解析

日期：2026-09-14。此切片为 Signal 多开前的旧账号归属契约，不是完整多开交付。

## 原因与实现

旧默认 Signal profile 没有可靠的 im-hub UUID 映射。现有首次授权接口允许空账号绑定上报身份，
因此不能以“拿到授权”循环证明某个新 UUID 就是旧账号。新增只读接口：

`POST /api/accounts/signal-native/resolve-existing`

正常 Bearer 鉴权及实时 actor/scoped；只接受 `platformAccountExternalId`，规范化 Signal ACI。
从 `req.scoped.accounts()` 查询，再显式限制本人 owner、Signal、native_desktop 和已有精确身份。
唯一匹配返回 `{ accountId }`；无匹配 404，歧义 409，非法参数 400，未登录 401，auditor 403。
所有路由响应 no-store，不返回 ACI。无写绑定、改状态、增版本或签发 grant 的路径。
尚未被桌面启动消费者调用；不改变现有账号或用户已验收的应用。

## 代码和验证

`signal-native-owner.ts` 新路由经 `api/server.ts` 登记；shared 成功响应只含 accountId。
新增 25 项真实 Fastify、签名鉴权、actor、ScopedDb、PostgreSQL 回归，相关 107 项通过；
先观察未登记路由返回 404 的 RED，再实现 200。typecheck 通过，独立审查 C/I/M=0。
测试不使用真实平台资料、密钥或聊天，不 source `.env`。

## 打包产物生效说明

源码快照：`/private/tmp/imhub-owner-container.JbRJOa`，仅复制清单与 server/shared 程序。
使用现有 `deploy/Dockerfile.server` 构建镜像 `im-hub-server:signal-owner-20260914-jbrjoa`，
镜像 ID `sha256:7bb5228e51e1e1d25603513cc0cf093428ec84d3a5d259a995f7a4d096ee4ecf`，
本机 arm64 验证镜像，非生产 amd64 发布。首次构建来源为 `52a04ab` 加本切片。
拆分前确认 server/shared、Dockerfile、workspace 和 ignore 与 main 相同，但根 package.json
和 lock 不同。因此重新使用 `origin/main`（15a2217）的两个清单构建
`im-hub-server:signal-owner-prbase-20260914`，镜像 ID
`sha256:1e1f373205881704a9a55534846e8f131909089257d8f82e405c4d484fa17b0c`。
此精确 PR 基线镜像的实际 HTTP 检查及 container smoke 均通过（本机 44090）；
未借用桌面分支的依赖改动充当 PR 的验证。

正常启动入口导入 `/app/packages/server/src/api/server.ts`，再注册同包新路由。
包内与工作树 SHA-256 一致：

- 新路由：`2e1b846572ecc71eeb8c0f7ad59dd1d383f190e0d1dc80dc809acbc32c0c1323`
- server.ts：`b78bc1974b6e38ddf1eff0aa13dcb57c44661d6253bb244bb574a27f549e09fe`
- shared/native-control.ts：`d28c8936f753bfb99448575721bfd1e41edc93fb114131a1fc620d2590971dad`

正式 `pnpm smoke:container -- --image <上述镜像> --health-url <URL>` 两次通过：
生产公开 `/health/ready`，以及精确新镜像自身 `http://127.0.0.1:44089/health/ready`。
前者只证明现有生产健康，不证明新增接口已部署；后者使用独立合成 PostgreSQL/Redis、APP_ENV=test。
另以精确新镜像正常服务入口实测 HTTP 200/401/403/404/409、no-store、前后数据库记录不变，
只使用临时合成账号，不启动真实平台。镜像构建出现可选 msgpackr-extract 编译失败日志，
pnpm 总退出 0，正常服务启动与上述实际 HTTP 检查通过；未将该日志隐瞒为无警告构建。

## 可复跑的镜像 HTTP 验收

仓库脚本 `deploy/scripts/smoke-signal-existing-owner.mjs` 在被测镜像内运行；
它先断言专用合成 DATABASE_URL，避免指向开发/生产库。以下所有值都是测试专用公开占位值，
不需要真实配置或平台登录。容器名已经存在时不要删除未知容器，应先核对是否为自己上次的测试。
在 Docker 可用的环境执行（本机需 `DOCKER_CONTEXT=colima-imhub-runtime`）：

```bash
docker build -f deploy/Dockerfile.server -t im-hub-server:owner-probe .
docker network create imhub-owner-probe-20260914-jbrjoa
docker run -d --name imhub-owner-pg-20260914-jbrjoa --network imhub-owner-probe-20260914-jbrjoa -e POSTGRES_PASSWORD=synthetic-owner-probe-password -e POSTGRES_DB=imhub_owner_probe postgres:16
docker run -d --name imhub-owner-redis-20260914-jbrjoa --network imhub-owner-probe-20260914-jbrjoa redis:7
```

等待 `docker exec imhub-owner-pg-20260914-jbrjoa pg_isready -U postgres` 成功，然后：

```bash
docker run --rm --network imhub-owner-probe-20260914-jbrjoa -e APP_ENV=test -e DATABASE_URL=postgresql://postgres:synthetic-owner-probe-password@imhub-owner-pg-20260914-jbrjoa:5432/imhub_owner_probe -e REDIS_URL=redis://imhub-owner-redis-20260914-jbrjoa:6379 -e JWT_SECRET=signal-owner-container-synthetic-secret-20260914 im-hub-server:owner-probe pnpm --filter @im-hub/server migrate
docker run -d --name imhub-owner-app-probe --network imhub-owner-probe-20260914-jbrjoa -p 127.0.0.1:44090:4000 -e APP_ENV=test -e DATABASE_URL=postgresql://postgres:synthetic-owner-probe-password@imhub-owner-pg-20260914-jbrjoa:5432/imhub_owner_probe -e REDIS_URL=redis://imhub-owner-redis-20260914-jbrjoa:6379 -e JWT_SECRET=signal-owner-container-synthetic-secret-20260914 im-hub-server:owner-probe
pnpm smoke:container -- --image im-hub-server:owner-probe --health-url http://127.0.0.1:44090/health/ready
docker cp deploy/scripts/smoke-signal-existing-owner.mjs imhub-owner-app-probe:/tmp/owner-probe.mjs
docker exec imhub-owner-app-probe node --import /app/packages/server/node_modules/tsx/dist/loader.mjs /tmp/owner-probe.mjs
```

脚本断言 200/401/403/404/409、no-store 和数据库无绑定写入；退出非零即验收失败。
只删除本脚本生成的随机合成账号，不读取平台 profile。验收后停止并移除本次专用容器及网络，
不要使用系统级 prune，也不要操作运行中的正式应用。

## 全量回归边界

隔离测试库及独立 Redis 上执行全量：209 files，201 passed / 8 failed；2023 tests，
2007 passed / 16 failed。失败涉及已删除的 Windows workflow、旧 Signal main 替身缺 ld、
已运行基线应用占用 47831、旧 WhatsApp 尾注期望、Telegram contents.on 替身缺失、
固定测试库名称期望，以及默认 Docker context/Compose 可用性。未修改这些桌面/环境边界来
粉饰全绿；当前整个桌面工作树不能宣称全量通过。新增接口的定向回归和容器验证独立通过。

## 剩余工作

本接口需独立 PR、审阅与正式 amd64 构建部署；不自动合并或部署。
然后接主进程的可信默认身份解析、独立后台按需创建、全部后台退出和真实双账号验收。
Windows 11 x64 原生依赖构建、统一 NSIS 与实机验收仍未完成。
