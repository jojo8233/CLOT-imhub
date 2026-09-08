# Production App Alignment Design

## Goal

让生产安装包的实际能力、服务端配置检查和用户看到的错误状态保持一致，避免“测试通过但安装后不可用”的错位。

## Scope

本阶段只处理三个可独立验证的根因：

1. 生产环境 DeepL 端点必须可配置，并在预检中进行真实的无敏感输出探测。
2. 独立安装包不能把未打包的 Telegram 开发端口和未注入 Signal 宿主桥接误报为已可用。
3. 翻译服务失败与原生输入框写入失败必须在桌面端显示不同错误，便于定位。

Telegram 静态资源打包、Signal Desktop 宿主补丁和真实安装包 E2E 留到下一阶段，不在本次混合实现。

## Design

服务端保留 `DEEPL_ENDPOINT` 环境变量，但生产初始化脚本不再强制写入 Free endpoint；若操作者未显式选择端点，则使用 `.env.example` 的默认值并在预检中探测当前端点。生产预检只报告状态类别和 HTTP 状态，不输出 key、响应体或翻译文本；当端点返回认证/权限失败时，提示切换另一个官方端点。预检测试使用可控的 HTTP mock，验证探测逻辑而非真实凭据。

桌面端新增一个由构建注入的能力描述：独立安装包声明 WhatsApp Web 可用，Telegram 只有当静态客户端资源存在时才可用，Signal 只有集成宿主模式才可用。现有开发环境行为保持不变。新增账号界面和原生客户端入口共同读取该能力描述，禁止创建或打开当前包无法承载的平台。

翻译停靠条将服务端翻译调用与 `nativeComposerBridge.setDraft` 分成两个错误边界：前者显示服务端/供应商错误，后者显示原生输入框写入错误。WhatsApp DOM 气泡继续保留重试入口，但错误文案不再暗示两种失败混在一起。

## Compatibility and Safety

- 不读取、打印或持久化任何 secret；日志只允许输出 provider 名称、端点主机和 HTTP 状态。
- 不改变现有数据库结构、账号会话或生产数据。
- 开发环境 Telegram `http://localhost:1234/` 与 Signal 集成宿主测试保持兼容。
- 生产安装包默认只承诺当前确实具备的能力，不影响已有 WhatsApp Web 账户。

## Verification

- 先新增并运行失败回归测试：生产预检端点行为、独立包能力门控、翻译错误分层。
- 实现后运行相关 Vitest、`pnpm typecheck` 和 desktop build。
- 通过静态检查确认构建产物和测试输出不包含 `.env`、token、session、QR 或验证码。
