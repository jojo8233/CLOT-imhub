# Signal Desktop fork 补丁存档

2026-08-26 从 Signal-Desktop 实验仓库导出的 im-hub 原型补丁。实验基线为
v8.27.0-alpha.1（commit 57194b0），原实验仓库当前不属于 im-hub workspace。

- `0001-气泡双语与翻译对接.patch` — 已提交的补丁(8c87fe7):气泡内原文下方
  显示中文译文、翻译走 im-hub 网关、preload 暴露 window.ImHub
- `0002-嵌入模式未提交补丁.patch` — 未提交的「窗口覆盖」嵌入补丁:
  app/imhub_embed.main.ts(宿主 socket 控制无边框窗口)+ app/main.main.ts
  的 7 处修改 + config/local-imhub.json(生产服务端点 + 独立 storageProfile)

这些补丁只用于保留技术探索结果，不代表当前可运行或可交付。M5 开始 Signal
原生接入时应基于最新上游重新实现并逐项审计；可参考这里的翻译和窗口控制思路，
不能直接套用旧构建。Signal Desktop 的版本过期、AGPL 源码交付、多 profile 多开、
消息回传和安装包更新仍需重新验证。
