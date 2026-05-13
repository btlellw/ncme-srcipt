# 后续开发路线

## 已完成

- 建立 `extension/` MV3 扩展骨架。
- 将原 `ncme_autoplay.user.js` 迁移为扩展内 page-world 运行脚本。
- 增加 `GM_xmlhttpRequest` 兼容桥，AI/Webhook 请求通过 background 代理。
- 增加侧边栏，用于查看状态、保存 AI 配置、暂停/恢复自动化和触发调试动作。
- 清理扩展副本中的默认 Webhook 与 API Key，改为由侧边栏配置。
- 参考 `ai-answer-assistant` 改造 AI 搜题：按题干/选项构造题目块、分批覆盖全部题目、JSON 解析，并对缺失/无效答案逐题重试。

## P0

- 在真实 NCME 页面加载扩展，验证 content script 注入顺序和 MAIN world hook 是否正常。
- 验证 AI 兜底答题链路：题库未命中 -> background 代理 -> 分批/逐题搜题 -> 写入考试模型。
- 验证考试提交链路：答案写入、翻页、提交、报告页回写题库。
- 验证课程列表页和播放页之间的跳转/回退状态。

## P1

- 将 `src/legacy/ncme_autoplay.user.js` 继续拆分为源码模块，减少单文件维护成本。
- 把固定答案表、题库、AI 三种答案源统一为一个答题调度器。
- 在侧边栏增加题库导入/导出。
- 在侧边栏增加通知 Webhook 配置。

## P2

- 增加构建脚本，输出可发布 zip。
- 增加 Playwright 或浏览器扩展自动化冒烟测试。
- 将日志分级，减少页面控制台噪声。
- 将不同专题的 `topicId/paperId/paperNo` 规则抽成可编辑模板。
