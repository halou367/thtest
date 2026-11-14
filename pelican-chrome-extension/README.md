# 鹈鹕模型鉴定器 · Chrome 悬浮窗插件 (v1.4.0)

当你浏览大模型对话页（Arena.ai、Claude、ChatGPT、Gemini、DeepSeek、Kimi、Qwen、豆包等）或本地预览网页时，插件会**自动捕获页面中的 SVG / HTML 绘图代码（涵盖鹈鹕、大嘴鸟、白鸽、摩托车、单车等多主题特征及无注释纯图形代码）**，同时也支持一键复制自动监听，即刻弹出精简悬浮面板完成渲染预览、模型鉴定与纠错入库。

---

## ✨ v1.4.0 更新亮点（Arena.ai 专项优化）

1. **Arena.ai 最新一轮对话的折叠预览小窗代码恢复**：Arena 的大 SVG/HTML 作品常被渲染成对话内的折叠「预览小窗」（`sandbox="allow-scripts"` 的 `blob:` 预览帧），DOM 里既没有 `<pre><code>` 也没有可读的 `srcdoc`，旧版插件无法捕获。v1.4.0 新增双通道恢复：
   - **Blob 预览捕获**：在页面主世界拦截 `URL.createObjectURL(blob)`，当 Arena 生成预览小窗时直接读取 Blob 文本，完整捕获大 SVG/HTML 源码（`对话预览小窗`）。
   - **React Fiber 恢复**：通过 Arena 对话消息的 React Fiber 树（`__reactFiber$`）定位**最新一轮助手回复**（`[data-agent-transcript-message]`，严格限制在最新 3 条、不跨轮串扰），从 `memoizedProps` / `memoizedState` 中提取 `code` / `content` / `srcDoc` / `html` / `artifact` 等字段恢复折叠小窗内的完整代码；同时扫描工作区 Artifact / 预览分屏面板。
2. **开源思考标记识别与开源结果强调**：自动检测 Arena 的开源思考 UI（脑形图标 + `Thought for 1 second` 按钮 + 暴露的思考过程文本），在鉴定结果中以绿色 **`🧠 开源思考 · Thought for 1 second`** 徽章突出标记，并持久化到鉴定历史中，便于区分开源/闭源模型的输出。
3. **多主题视觉评测特征词库 + 智能全捕获双引擎**（v1.3.1 延续）：
   - 全面覆盖 **鹈鹕 (`pelican`)、大嘴鸟/巨嘴鸟 (`toucan`)、白鸽/和平鸽/鸽子 (`dove`, `pigeon`)** 等鸟类主题，以及 **摩托车/机车/踏板车 (`motorcycle`, `moto`, `scooter`)、自行车/单车 (`bicycle`, `bike`)** 与头盔、排气管、引擎、鸟喙、喉囊等结构特征。
   - 代码 + 对话上下文双重特征提取；默认开启「智能全捕获」，命中特征词的样本优先排在第一位并标注 `🎯`。

---

## 🚀 安装 / 更新步骤

1. `git pull` 拉取最新仓库代码后，在 Chrome 地址栏打开：`chrome://extensions/`
2. 打开右上角 **「开发者模式 (Developer mode)」**
3. 点击「鹈鹕模型鉴定器」卡片上的 **「刷新 🔄」** 按钮，再刷新已打开的 Arena 对话页即可生效（Arena 页面需整页刷新一次以注入新版主世界 Hook）。
