# 架构转向：从「自建界面」改为「分发打过补丁的开源客户端」

日期：2026-08-25　状态：已决定，执行中

> 2026-08-26 范围校正：Telegram、Signal、WhatsApp 都保留，Zoom 延后；
> 统一界面只保留一个“会话”入口，中间区域使用平台原生客户端。完整产品基线见
> `2026-08-26-m0-product-scope.md`。Signal Desktop 的跨进程窗口覆盖原型已于
> 2026-08-30 被真实验收否决；当前基于 Signal Desktop 8.25.0 改成同一物理窗口内的
> `WebContentsView`；现有
> `signal-cli` 适配器继续保留为后台基线和回退路径，但不再作为用户可见的扫码、
> 会话或媒体发送入口。

## 为什么转

自建界面这条路，消息要先经适配器归一化成统一形状再落库。好处是数据在我们
手里、客户档案与关键词告警可以直接接；代价是**平台的每一样能力都要重新实现
一遍**：群名、联系人名、图片、文件、语音、回复引用、表情回应、贴纸……

实测下来，跑了一段时间的库里是这样的：

| 会话 | 消息数 | 界面上显示成 |
|---|---|---|
| Telegram 群 `-1004429183741` | 36 | `-1004429183741` |
| Signal 群 `g:z64U…smU=` | 1 | 发言人的名字（不是群名） |
| Telegram 私聊 `1847421336` | 5 | `1847421336` |

数据全都在，但因为没做名称解析，界面上只能甩原始 ID 出来。图片则是在归一化
那一步直接丢弃。**功能补得完，但要一样一样补，而且永远落后于平台。**

改成分发打过补丁的开源客户端后，这些能力**天生就有**——因为跑的就是官方客户端
本身。代价见下面「必须接受的代价」。

## 技术选型

| | Telegram | Signal |
|---|---|---|
| 基座 | [telegram-tt](https://github.com/Ajaxy/telegram-tt)（Telegram Web A） | [Signal-Desktop](https://github.com/signalapp/Signal-Desktop) |
| 许可 | GPL-3.0 | AGPL-3.0 |
| 形态 | 网页应用，构建产物用 webview 加载 | Electron 应用 |
| 构建过期 | 无 | **有，见下** |

**不去扒 `web.telegram.org` 的 DOM。** 那份代码是混淆过的，选择器一改版就失效，
而且失效时不报错、只是悄悄不翻译了。改源码则是在类型系统和构建流程的保护下
进行的。

## 必须接受的代价

1. **Signal Desktop 的构建会过期。** 距该版本最后一次提交约 90 天后，客户端会
   停止发送消息。fork 出来不是做完就完事——**必须至少每 90 天跟一次上游、
   重新构建、重新分发**，否则员工手上的客户端会集体失效。上游大约每周一个正式版。
2. **许可义务。** 两个基座都是 GPL 家族；把改过的版本分发给员工，需要向接收方
   提供对应源码。AGPL 的触发条件比 GPL 更宽。
3. **多开的内存代价。** 每个账号一个独立会话的客户端实例。
4. **非官方客户端。** 与各平台的服务条款关系需要自行评估。

## 什么保留、什么替换

**保留**（这一层跟消息从哪来无关）：
- 翻译网关与多引擎选择、翻译缓存
- 用户 / 团队 / 角色与可见范围（RBAC）
- WebSocket 推送、客户档案与关键词告警的数据层
- 客户端外壳：顶栏账号标签页、功能中心、可拖拽布局

**逐步替换**：
- 打过补丁的客户端完成消息回传、去重、权限校验和故障降级后，成为对应平台的
  主交互入口和候选主消息来源
- `normalize.ts` 的统一消息形状继续作为落库边界；归一化可以发生在适配器中，
  也可以发生在服务端接收补丁客户端上报时
- TDLib 与 signal-cli 适配器暂时保留，不能在原生链路验收前删除

也就是说，**打过补丁的客户端成为新的平台接入端**。服务端仍负责重新校验账号权限、
统一消息、去重、翻译、长期存档、客户档案和告警，不能直接信任客户端上报。

## 执行顺序

1. **M1 先统一外壳**：删除用户可见的“会话工作台 / 原生界面”双入口，建立平台
   一级、平台内账号二级导航，并保留右侧客户档案。
2. **M2 建立通用桥接（已实现）**：受控 preload、版本化命令/事件、当前会话、固定
   输入坞状态机、服务端 owner 校验、归一化、编辑/删除与 id alias 去重。协议和边界见
   `2026-08-26-m2-native-bridge.md`。
3. **M3 完成 Telegram 闭环（执行中）**：持久化 partition webview、账号控制、原生 Composer
   与 IndexedDB 消息 outbox 已接入通用桥接，约定范围的真实故障矩阵已完成。M3-5
   已建立 TDLib/telegram-tt 来源观测账本和离线报告；仍须完成真实 shadow fixture、历史缺口
   修复、长期观察和切换/回滚门槛，不能把观测接线写成已验收闭环。
4. **M5/M6 并行推进 Signal 与 WhatsApp（执行中）**：按 2026-08-29 的产品优先级调整，
   不再等待 M3 生产观察全部结束才启动。Signal 已改用补丁版 Signal Desktop 作为用户可见
   入口，同窗口、真实关联、冷启动恢复、账号切换以及文字、图片和贴纸发送已通过；入站
   文字、图片与贴纸结构化元数据 bridge、编辑/删除/回应及真实唯一落库均已通过；当前会话
   与原生草稿读写已接入既有 control grant，自动发送仍保持关闭；
   `signal-cli` 只保留后台回退，不再由
   添加/重关联弹窗触发。WhatsApp 首检点只在 owner 的隔离
   partition 中承载官方 `web.whatsapp.com`，验证扫码、多开和页面内原生文字收发。WhatsApp
   尚未注入 im-hub preload、桥接或翻译能力，不能写成统一消息闭环。两条路线后续再分别补齐
   原生桥接、身份绑定、消息回传和安装包；Zoom 延后。

## Signal 同窗口宿主的历史与边界

Signal Desktop 的主体依赖原生 SQLCipher/libsignal 模块和完整主进程 IPC，不能作为普通网页
塞进 im-hub Electron 33 的 `<webview>`；Signal Desktop 8.25.0 又使用 Electron 43.4.1，直接
跨版本加载其打包页面会产生原生模块 ABI 风险。此前用第二个无边框进程覆盖 im-hub 占位区的
方案虽然能对齐坐标，但用户真实验收确认它仍是独立窗口，因此已经退出运行时。历史补丁只保留
在 `docs/attic/signal-desktop-patches/`。

2026-08-30 第一阶段改为反向宿主：让补丁版 Signal Desktop 进程创建唯一物理
`BrowserWindow`，该窗口的主 webContents 加载 im-hub 外壳，Signal 原始 renderer 则放进
同进程 `WebContentsView`。Signal 主进程通过一个最小 BrowserWindow facade 继续把
`.webContents` 和 `.loadURL()` 指向自己的 view，其余显示、尺寸和焦点操作仍作用于同一物理
窗口：

- `packages/desktop/scripts/prepare-signal-desktop.mjs` 从一份官方 `.app` 生成新的开发包，
  不原地修改官方客户端；补丁锚点与版本不符时立即失败。
- 准备过程重新生成 `app.asar`、同步 `ElectronAsarIntegrity` header hash 并重新签名，
  原生 `.node` 模块保持在 `app.asar.unpacked`；可用 `--profile-source` 将上一开发包的本机配置
  作为不透明字节复制，脚本不解析或打印其中的隔离资料位置。
- im-hub 主页面使用独立、非持久 Electron session；Signal 原始 renderer 保持 Signal 自己的
  session、preload、数据库和 IPC。这样不会关闭 `webSecurity`，也不会让 Signal 的默认 session
  导航过滤器阻断 im-hub。
- im-hub 静态页面由只监听 `127.0.0.1` 随机端口的临时服务提供，并设置 CSP；API/WS 默认只
  允许 `127.0.0.1:4000`，若设置 `IM_HUB_SERVER_URL`，则只允许其精确 HTTP/WS origin。
  Telegram/WhatsApp guest 继续经过精确来源、partition、权限和 preload 校验。
- 渲染层只上报账号 UUID、内容区相对矩形和可见性；主进程裁剪到同一窗口内容区后才调整
  Signal `WebContentsView`，不再存在控制 socket 或第二个平台窗口。
- 账号表使用显式 `connection_mode` 区分 `native_desktop` 与 `adapter`。添加 Signal 原生账号
  只登记 UUID 并交给桌面主进程，不写伪造的 `credentials_ref`；服务启动、重关联、鉴权输入
  和删除都不能把原生账号转交给 signal-cli。
- Signal 添加与重关联 UI 不再触发 `signal-cli` 二维码。CLI 代码尚未删除，以便原生链路
  完成消息回传和回滚验收前保留后台回退。
- Signal 原生 preload 只在 Signal 自身完成对应数据库写入后上报：普通文字、图片与贴纸来自
  `ConversationModel.onNewMessage`，编辑来自 `saveEditedMessage` 之后，删除来自删除持久化之后，
  回应来自回应数据库与消息缓存保存之后。guest 不自报 im-hub 账号；主进程把实际
  `WebContentsView` 绑定到账号，服务端
  owner-only grant 首次绑定实际 ACI，后续每次代理都复核账号撤销版本与实际 ACI。
- 图片只读取 `attachments[]`，贴纸只读取独立 `sticker` 字段；桥接事件不携带本机路径、附件
  密钥、pack key 或二进制，只用 Signal 本地消息 id + 消息内槽位生成稳定媒体引用。视频、音频、
  文件及任何结构异常的媒体整条拒绝，不能落成只有 caption 的不完整消息；单条失败只显示非致命
  提示，不撤销账号 grant，后续成功消息会恢复状态。
- Signal Desktop 与 `signal-cli` 使用同一个规范键实现：私聊 `u:<normalized-aci>`、群聊
  `g:<group-id>`、消息 `<normalized-sender>:<sent-at-ms>`。服务端只接受规范 Signal 键并继续
  依赖 `(account_id, platform_message_id)` 去重。
- Signal 入站事件先按实际 ACI 写入独立 IndexedDB，再以稳定 `eventId` 严格顺序重试到 ACK；
  接受后删除，永久拒绝进入有界 dead-letter，存储或容量故障必须显示非敏感提示。自动化已覆盖
  outbox 对象重建后的同键重放；真实未 ACK 消息经隔离 503、Signal 进程退出和正常进程重开后，
  已用同一事件完成一次回传、ACK 清队列与数据库唯一落库。

当前只允许一个 Signal Desktop 原生账号。真实关联、冷启动恢复、Telegram/WhatsApp/Signal
标签切换，以及 Signal 文字、图片和贴纸发送已经通过；入站文字 bridge 的代码、自动化验证
和一条真实消息的唯一落库证据也已完成。持久 outbox 代码、自动化、打包与空队列运行态初始化
以及真实未 ACK 进程重放均已通过。入站图片/贴纸结构化元数据的真实唯一落库也已通过；附件
二进制和其他入站媒体仍未接入。编辑/删除/回应的代码、数据库迁移、自动化和真实客户端续验
均已完成。翻译输入坞现已接入 Signal 当前会话和原生草稿读写，但尚待真实客户端续验；自动发送、
正式多开、正式安装包、
上游更新流程以及 AGPL 源码交付仍未完成，不能把当前开发包写成可发布实现。
