---
name: pwa-mobile
description: PWA、manifest、Service Worker、移动端适配、离线支持。修改 PWA 配置、manifest 或 sw 时，需保持安装到主屏、离线回退、更新逻辑正常。Use when editing PWA, manifest.webmanifest, or Service Worker.
---

# PWA 与移动端

## 不可变约束（优化时勿破坏）

1. **manifest**：name、short_name、scope、start_url、display standalone、icons、theme_color。
2. **Service Worker**：网络优先、离线回退；install/activate 时 skipWaiting。
3. **移动端**：viewport-fit=cover、安全区、触控 ≥48px、输入 16px 防缩放。
4. **仅 PWA/浏览器**：已放弃 Electron 桌面版，无 Windows exe。

## 代码位置

| 组件 | 路径 |
|------|------|
| manifest | frontend/public/manifest.webmanifest |
| Service Worker | frontend/public/sw.js |
| 注册 | frontend/src/main.tsx |
| index.html | viewport、theme-color、apple-mobile-web-app-* |

## 相关文档

- docs/手机端开发指南.md
- docs/优化与改进总览.md §PWA 完善

## 优化注意

- 改 CACHE_NAME 会触发新缓存，旧缓存需兼容或清理策略。
- 勿恢复 Electron 或桌面安装包（已放弃）。
