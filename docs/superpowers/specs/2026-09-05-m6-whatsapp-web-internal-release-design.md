# M6 WhatsApp Web 公司内部发布设计

日期：2026-09-05
状态：Tasks 1–8 已实现并通过本机自动化/DMG 冒烟；GitHub Windows 包与 macOS/Windows 人工验收待完成

## 1. 背景与目标

WhatsApp 当前同时保留两条技术路线：

- `web_shell`：在每账号独立 Electron partition 中加载官方 `web.whatsapp.com`，通过受控 preload
  提供可见纯文字双语、当前会话、草稿和发送确认；
- `cloud_api`：基于 Meta Business Platform 的 Embedded Signup、Webhook 和 Graph API，代码与
  自动化已经存在，但默认关闭，尚无真实 Meta 配置与平台验收。

公司当前决定只把 WhatsApp Web 作为员工可见入口。M6 本切片把现有开发态 Web 能力收敛成公司
内部可安装、可验证、可回滚的 macOS/Windows 测试版，同时避免删除未来可能复用的 Cloud API
后端资产。

本切片的成功标准是：

1. 员工只能从产品界面创建 WhatsApp Web 账号，不再看到 Cloud API 选项；
2. macOS `.dmg` 与 Windows NSIS `.exe` 使用同一套 renderer/preload 和明确的固定公司服务端；
3. 正常覆盖安装保留每个 WhatsApp 账号的独立登录态；
4. DOM、服务端或授权边界失效时保持官方页面可用，但翻译和受控发送 fail-closed 并明确提示；
5. macOS 完成只读人工复验，Windows 完成真实安装、登录和最多一条无敏感纯文字发送验收；
6. 两个平台都通过前，产物只能标记为内部未签名测试版，不能宣称生产发布完成。

## 2. 已确认产品决策

- 公司内部只使用 WhatsApp Web；不向员工提供 Cloud API 创建或授权入口。
- Cloud API 服务端代码、migration 和测试保留，继续以 `WHATSAPP_CLOUD_ENABLED=false` 为默认值。
- 不自动转换、不隐藏或删除已有 `cloud_api` 账号；它们显示为“旧 Cloud 账号，不可连接”，owner
  仍可在组织管理中心转移或删除。
- 本切片不扩展媒体、回复、删除、回应或中央 DOM 消息归档。
- macOS 和 Windows 共同验收 WhatsApp Web；Signal Windows 宿主属于 M5，不阻断本切片。
- 第一版使用内部手动安装包，不建设自动更新服务。
- 当前没有 Apple Developer ID 或 Windows 代码签名证书。打包流程必须为未来签名留出配置，但本轮
  产物明确标记为 `internal-unsigned`。
- 桌面端只连接公司统一服务器，不在员工电脑安装 Node、PostgreSQL、Redis 或翻译服务。
- 公司服务端 HTTPS 地址在构建时固定，员工不能在首次启动时改填其他服务器。
- Windows 安装包由 GitHub 手动工作流构建，用户在真实 Windows 电脑完成验收。
- Windows 验收最多发送一条由用户确认收件人和草稿后的无敏感纯文字；macOS 不新增真实发送。

## 3. 非目标

本切片明确不做：

- 删除 `cloud_api` 联合类型、数据库列、migration、路由、服务或测试；
- 将已有 Cloud API 账号改写为 `web_shell`；
- 把 WhatsApp DOM `data-id` 冒充官方 Cloud API `wamid`；
- 把 WhatsApp Web 可见消息回传到中央 `messages` 表；
- 让 WhatsApp Web 消息进入客户档案关联或关键词告警；
- 支持 WhatsApp Web 媒体翻译、媒体发送、回复、删除、回应或后台完整历史抓取；
- 为 Signal 建设 Windows 宿主或正式多账号；
- 建设自动更新、强制升级或差分包；
- 在没有证书时伪造签名、公证或“正式版”状态。

## 4. 产品策略与兼容边界

### 4.1 新账号只走 Web

`AddAccountDialog` 的 WhatsApp 分支只显示 Web 版说明与“创建并扫码”。它不再：

- 调用 `GET /api/whatsapp/cloud/config` 探测 Cloud 能力；
- 显示 Web/Cloud 二选一；
- 进入 Meta onboarding 状态机；
- 从普通添加账号流程构造 `cloud_api` 请求。

WhatsApp 创建请求固定携带 `connectionMode: 'web_shell'`。服务端既有 platform/mode 组合校验继续
作为第二道边界，不能只信任桌面端。

平台卡片文案使用“WhatsApp Web 双语页面”，不再把“Cloud API 统一会话”宣传为当前员工能力。

### 4.2 Cloud API 保留但不进入员工流程

`ACCOUNT_CONNECTION_MODES`、`cloud_api` 数据库值、`WHATSAPP_*` 配置、Meta onboarding、Webhook、
Graph client、secret store 和相关测试保留。服务端仍只有在显式完整配置时才注册 Cloud 路线；默认
配置保持关闭。

这项保留是兼容与可逆性边界，不表示 Cloud API 已交付。公共桌面界面不得提供到这些路由的入口。

### 4.3 旧 Cloud 账号

账号列表和 owner 管理中心继续返回旧 `cloud_api` 账号，保留其名称、归属和历史数据。桌面端以
集中产品策略函数判定账号运行模式：

- `web_shell`：进入 WhatsApp Web；
- `cloud_api`：显示“旧 Cloud 账号／当前产品不支持连接”的只读占位；
- 不为旧 Cloud 账号挂载 webview，也不打开 im-hub Cloud 会话工作区；
- owner 仍可通过现有组织管理流程转移或删除；
- 既有中央消息和档案数据按原 RBAC 保留，不做数据清理。

产品策略应集中在一个小模块中供添加账号、布局和会话入口复用，避免三个组件分别判断后发生漂移。

## 5. WhatsApp Web 运行与信任边界

### 5.1 账号和 partition

员工先登录 im-hub，再按现有 RBAC 查看和创建权限范围内的账号。本切片不修改账号所有权、团队、
owner/manager/agent/auditor 权限。

每个 WhatsApp Web 账号继续使用 `persist:native-<accountId>` 独立 partition。cookie、缓存、
local storage 和 IndexedDB 不能跨账号共享。账号切换只改变可见 pane；已挂载的账号保持独立运行，
沿用现有宿主生命周期。

二维码由官方 WhatsApp Web 页面展示。页面登录后，受控 preload 从 WhatsApp 本地状态取得页面身份；
主进程和服务端继续复核精确 partition、im-hub 账号、账号负责人、页面身份和短时 control grant。

### 5.2 页面权限

webview 只允许精确的 WhatsApp 官方 origin。页面脚本不能取得：

- Node 或 Electron 主进程能力；
- JWT、control grant 或翻译提供商密钥；
- `ipcRenderer`、任意外壳 API 或其他账号 partition；
- 本机文件路径或平台会话目录。

宿主只对精确 WhatsApp 主框架允许已审计的持久存储权限。非官方导航、弹窗、下载和权限请求继续
按白名单拒绝，不能为解决一次页面加载问题放宽整个 guest。

### 5.3 翻译与发送

当前可见的纯文字气泡继续在 context-isolated preload 中使用多锚点扫描，单次最多处理现有上限。
正文只存在于页面内存与现有翻译请求中，不写入 WhatsApp Web attempt 账本或日志。

翻译坞写入前后复核当前会话与草稿。发送前先保存不含正文的 `attemptId`、首次 context revision、
正文 SHA-256 和会话键。只有观察到一条发送前不存在、正文匹配、方向为出站并带实际 DOM
`data-id` 的新消息，才能确认成功。超时、结果丢失或重启后的 pending attempt 不得自动再次点击。

DOM `data-id` 只用于 Web 发送确认，不进入中央消息库，也不能作为 Cloud API 消息 id。

## 6. 固定公司服务器

开发环境可继续显式使用 localhost；打包产物必须在构建阶段取得 `IM_HUB_SERVER_URL`，并通过共用
解析器校验：

- 协议必须为 `https:`；
- 只能是 origin，不允许用户名、密码、路径、查询参数或 fragment；
- 由同一 URL 对象派生 `https` API origin 与 `wss` WebSocket origin；
- renderer 不能自行拼接或覆盖来源；
- 打包构建缺少变量或变量非法时立即失败，不能静默回退 localhost。

经过校验的 origin 以构建常量进入桌面产物，主进程再通过现有窄 preload API 提供给 renderer。
GitHub workflow 不在日志中打印该值。由于值最终存在于客户端二进制中，它不能被当作凭据；服务端
仍必须依赖 TLS、登录鉴权、RBAC、速率限制和必要的公司网络策略。

## 7. 失败处理

### 7.1 服务端或授权不可用

公司服务端不可达、JWT 失效、账号控制授权失败或页面身份不一致时：

- WhatsApp 官方页面保持可见，员工仍可直接使用官方网页能力；
- im-hub 翻译、草稿桥接和受控发送关闭；
- 页面上方或翻译坞显示短而明确的应用内提示；
- 不弹操作系统通知，不自动跳转，不自动清除登录态；
- 恢复后重新走身份和 grant 校验，不能沿用过期授权。

### 7.2 DOM 兼容性失效

结构化 resolver 持续找不到已知锚点时采用 fail-closed：

- 不插入无法正确归属的译文；
- 不猜测或点击发送按钮；
- 保留官方页面并显示“页面版本暂不兼容”；
- 提供显式重试；正常虚拟滚动的短暂卸载不能误报为持续失配。

### 7.3 单账号页面故障

一个 webview 崩溃、加载失败或失去响应只影响对应账号。允许用户重新加载该账号，但不得自动清空
partition、其他账号缓存或 im-hub 登录会话。

账号转移、员工停用和删除继续复用 M4 的安装实例清理任务。在线客户端按能力清理目标 partition；
离线客户端保留人工任务和 WhatsApp 官方“已关联设备”解除提示，不把未执行写成完成。

## 8. 跨平台打包

### 8.1 共用构建

在现有 `@im-hub/desktop` 中引入 `electron-builder`，使用同一份 production build 生成：

- macOS：`.dmg`；
- Windows：NSIS `.exe`，默认按当前用户安装，不要求管理员权限。

应用 ID 固定为 `org.imhub.desktop`，product name 固定为 `im-hub`。两者从第一次内部发布起不得
随版本或平台变化，确保 `userData` 与 partition 根目录稳定。Windows NSIS 使用可选择安装目录的
非 one-click、当前用户安装（`oneClick=false`、`perMachine=false`），不要求管理员权限。正常覆盖
安装不要求员工重新扫码。卸载默认不宣称已经解除 WhatsApp 关联；离职、换机或账号转移必须先走
应用内清理和官方已关联设备流程。

产物名包含版本、平台、架构与 `internal-unsigned`，例如：

```text
im-hub-<version>-mac-<arch>-internal-unsigned.dmg
im-hub-<version>-win-<arch>-internal-unsigned.exe
```

每个平台安装包必须同行提供匹配版本/提交/平台/架构的非敏感 manifest，以及
`internal-unsigned-third-party-licenses.json` 生产依赖许可证清单。缺少任一文件都视为构建失败，
不得只分发安装包本体。

专用脚本在 production build 后生成包含版本、固定来源哈希和全部 `out/` 文件哈希的本地证明；
`electron-builder` 的 `beforePack` 钩子必须在同一环境中验证该证明，证明文件本身不进入安装包，
专用脚本退出时必须删除证明，防止后续直接打包复用。
直接运行打包器、使用开发构建残留、改变任一输出或改变来源都必须失败。打包器只写入唯一暂存目录，
当前版本/平台/架构的安装包、manifest 和桌面依赖许可证清单全部完成后才发布；失败路径清理当前
三件套，不得把旧版本或其他架构误写入 manifest。许可证清单去除本机路径，显式包含随包 Electron
和 renderer 运行组件，并拒绝服务端专用依赖。

配置为未来 Apple 签名/公证和 Windows Authenticode 保留环境变量接口。没有对应证书时不得运行
伪签名步骤，也不得去掉 `internal-unsigned` 标记。

### 8.2 GitHub Windows 工作流

新增 Windows 工作流，同时响应同仓库 `pull_request` 和手动 `workflow_dispatch`。新工作流在进入
默认分支前不能被手动调度，因此首个实现 PR 使用 `pull_request` 构建完成合并前验收；合并后保留
`workflow_dispatch` 供后续内部版本使用。仓库是公开仓库，workflow 和构建配置不得包含任何凭据。
公司服务端 origin 固定从 GitHub Environment `internal-test` 的配置变量 `IM_HUB_SERVER_URL` 传入；
变量缺失时工作流失败，日志不打印其值。该地址仍可从最终二进制提取，因此只能是地址，不能带
token。来自 fork 的 PR 不生成带公司 origin 的安装包。

工作流固定执行：

1. checkout 精确提交；
2. 安装 Node.js 22 与 pnpm 10，使用现有 lockfile；
3. `pnpm install --frozen-lockfile`；
4. `pnpm typecheck`；
5. 与 WhatsApp 产品策略、来源校验、preload 和打包相关的定向测试；
6. 完整 `pnpm test`；
7. desktop production build；
8. NSIS 打包与产物存在性检查；
9. 上传保留 7 天的内部测试 artifact。

数据库测试只能连接工作流提供的隔离 PostgreSQL/Redis 服务，不能指向开发库或生产库。artifact
只用于指定员工验收，不发布为 GitHub Release。

macOS 使用同一提交和同一构建配置在本机生成 `.dmg`；两个平台的版本、服务端 origin 和 Git commit
必须可在构建清单中核对，清单不得包含密钥。

## 9. 自动化验证

至少新增或调整以下测试：

- 产品策略：`web_shell` 可运行，`cloud_api` 返回 legacy/unavailable，其他平台不受影响；
- 添加账号：WhatsApp 不调用 Cloud 配置接口、不显示 Cloud 入口、创建请求恒为 `web_shell`；
- 布局与会话入口：旧 Cloud 账号显示只读占位，不能挂载 WhatsApp webview 或 Cloud 会话工作区；
- 账号管理：旧 Cloud 账号仍出现在 owner 管理列表并保留转移/删除能力；
- 服务端来源：开发 localhost 显式可用，打包态只接受无凭据、无路径的 HTTPS origin，并正确派生
  WSS；缺失或非法配置使打包失败；
- 安全失败：服务端离线、授权失效和持续 DOM 失配均关闭翻译/发送但不隐藏官方页面；
- 打包配置：稳定 app ID、product name、macOS DMG、Windows NSIS 和 unsigned artifact 名称；
- 回归：现有 WhatsApp translation/composer/send/attempt/health 测试保持通过；Cloud API 后端测试
  保持通过，证明“隐藏入口”没有误删保留路线。

交付前运行：

```bash
pnpm typecheck
pnpm test
pnpm --filter @im-hub/desktop build
pnpm --filter @im-hub/desktop package:internal:mac
```

Windows workflow 必须对同一提交给出通过结果并生成 `.exe`，不能用 macOS 上的配置解析测试代替
Windows 实际打包。

## 10. 人工验收

### 10.1 macOS 只读复验

1. 安装本次 `.dmg`，确认应用显示内部未签名测试版；
2. 登录 im-hub，确认添加 WhatsApp 账号只出现 Web 说明；
3. 打开既有 WhatsApp Web 账号，确认登录态保留；
4. 核对当前可见入站/出站纯文字双语，向上滚动后新增可见消息继续补译；
5. 在翻译坞生成一份无敏感草稿，确认只写入一次且不自动发送，随后人工清空；
6. 重启应用，确认 im-hub 安全会话策略与 WhatsApp partition 按设计恢复；
7. 用可恢复方式模拟服务端不可达或授权失效，确认官方页面保留、翻译/发送关闭且提示明确；
8. 不发送新的真实 WhatsApp 消息。

### 10.2 Windows 真实验收

1. 从指定 GitHub Actions run 下载 `.exe`，核对提交、版本和 `internal-unsigned` 标记；
2. 安装并处理预期的未签名系统提示；
3. 登录 im-hub，创建 WhatsApp Web 账号并在官方页面扫码；
4. 确认当前可见与滚动新增的入/出站纯文字双语正常；
5. 在翻译坞生成一份无敏感草稿，确认单份写入、会话正确、发送按钮可用；
6. 用户再次确认收件人和草稿后，只点击一次发送；接收端确认精确收到一条，页面草稿清空且没有
   自动重试；
7. 重启应用，确认登录态保留、pending attempt 没有盲目重发；
8. 验证服务端不可达或 grant 失效时的 fail-closed 提示。

人工记录只写布尔结果、错误类别、构建版本和提交，不记录二维码、账号身份、联系人、正文、DOM id、
partition、token 或平台会话路径。

## 11. 发布、回滚与完成定义

第一版仅通过公司内部渠道分发。GitHub Actions artifact 不是正式 Release，未签名产物不得对外宣传。
公开仓库需要保留对应提交、第三方许可证和构建说明；构建产物不包含平台 profile/session。

由于本切片没有数据库 migration，客户端回滚使用上一内部版本覆盖安装。稳定 app ID 和 user-data
目录保证 partition 可继续使用。若新版本发生来源校验、DOM resolver 或安装问题：

1. 停止分发新 artifact；
2. 安装上一内部版本，不删除 user-data；
3. 服务端无需回滚 Cloud schema 或转换账号；
4. 保留应用内清理任务，不能通过删除本地目录冒充平台解除关联。

只有以下条件全部满足，才能把本切片标记为“WhatsApp Web 公司内部测试版闭环完成”：

- Web-only 产品策略与 legacy Cloud 兼容测试通过；
- 类型检查、全量测试、desktop build 和两平台打包通过；
- macOS 只读复验通过；
- Windows 安装、登录、翻译、重启恢复及唯一一条受控发送通过；
- RUNBOOK、产品范围与功能缺口文档同步；
- 分支经代码审查并通过 Pull Request 合并。

完成上述门槛仍不代表 WhatsApp Cloud API、中央消息归档、正式签名、公证、自动更新或公网生产发布
已经完成。
