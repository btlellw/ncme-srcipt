# NCME Auto Play Helper 浏览器扩展

这是从根目录 `ncme_autoplay.user.js` 重构出来的 MV3 浏览器扩展版本，并参考了 `ai-answer-assistant` 的侧边栏、后台代理和 AI 配置思路。

## 加载方式

1. 打开 Chrome/Edge 的扩展管理页。
2. 开启「开发者模式」。
3. 选择「加载已解压的扩展程序」。
4. 选择本目录：`extension`。
5. 打开 `https://www.ncme.org.cn/` 后点击扩展图标，侧边栏会显示运行状态与 AI 配置。

## 目录

- `manifest.json`：MV3 扩展清单。
- `src/legacy/ncme_autoplay.user.js`：迁移后的 NCME 自动化主逻辑，运行在页面 MAIN world。
- `src/content/page-bridge.js`：页面侧桥接，提供 `GM_xmlhttpRequest` 兼容层和调试命令入口。
- `src/content/extension-bridge.js`：扩展侧桥接，连接页面、侧边栏和后台代理。
- `src/background.js`：后台 service worker，负责跨域 AI/Webhook 请求代理。
- `panel/`：侧边栏 UI。

## AI 配置

侧边栏保存的 AI 配置会写入当前 NCME 页面的：

```text
localStorage["ncme.auto.aiConfig"]
```

示例：

```json
{
  "enabled": true,
  "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  "apiKey": "REPLACE_ME",
  "model": "glm-4-flash",
  "timeoutMs": 30000,
  "temperature": 0,
  "maxTokens": 32,
  "maxQuestionsPerRequest": 10
}
```

如果题库命中失败，主脚本会通过后台代理请求 AI，并将答案写回考试模型。
