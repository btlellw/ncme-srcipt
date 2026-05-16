# NCME Auto Play Helper

本项目已从 Tampermonkey/Violentmonkey userscript 重构为 Chrome/Edge MV3 浏览器扩展。

## 当前入口

- 扩展目录：`C:\Users\btlellw\Documents\Codex\2026-05-11\ctf-https-www-ncme-org-cn\extension`
- 原 userscript 归档：`C:\Users\btlellw\Documents\Codex\2026-05-11\ctf-https-www-ncme-org-cn\ncme_autoplay.user.js`
- 参考项目：`C:\Users\btlellw\Documents\Codex\2026-05-11\ctf-https-www-ncme-org-cn\ai-answer-assistant`

## 加载方式

1. 打开 `chrome://extensions/` 或 `edge://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择 `extension` 目录。
5. 打开 `https://www.ncme.org.cn/`，点击扩展图标打开侧边栏。

## 功能

- NCME 课程列表自动展开与自动播放。
- 视频播放页自动续播、结束后跳转下一节或返回列表。
- 考试页自动识别试卷、按题库/答案表作答、提交。
- 参考 `ai-answer-assistant` 的后台代理模式，支持在题库缺失时调用 OpenAI-compatible API 兜底作答。
- 侧边栏提供运行状态、AI 配置和调试动作。

## 主要目录

- `extension/manifest.json`：MV3 扩展清单。
- `extension/src/legacy/ncme_autoplay.user.js`：迁移后的 NCME 自动化核心逻辑。
- `extension/src/content/page-bridge.js`：页面 MAIN world 桥接，兼容 `GM_xmlhttpRequest`。
- `extension/src/content/extension-bridge.js`：扩展 isolated world 桥接。
- `extension/src/background.js`：后台 service worker，用于 AI/Webhook 跨域请求代理。
- `extension/panel/`：扩展侧边栏。
- `config/ai-config.example.json`：AI 配置示例。
- `data/exam-answer-bank.example.json`：题库结构示例。

## AI 配置

侧边栏会将配置写入 NCME 页面 localStorage：

```text
ncme.auto.aiConfig
```

可参考 `config/ai-config.example.json`。
f90ec202fcc84a83acd0f1c9e6c793ab.tWa5JBlQVmjcxJr3
GLM-4-FlashX-250414
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=941705ed-35d5-4327-ad00-ffc4d9e756fe
