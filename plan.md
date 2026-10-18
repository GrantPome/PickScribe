# PickCat AI 帖子总结助手 — 项目规划

> 目标站点：`https://pickcat.dao3.fun/`（兼容旧域名 `https://cdsq.dao3.fun/`）
> 归属项目：PickScribe（`github.com/GrantPome/PickScribe`，本地 `pickcat-mdtoword`）
> 文档状态：决策已确认（第 11 节），进入开发（合并进 PickScribe）

---

## 1. 项目定位

一款在 PickCat 论坛帖子页内提供 **AI 一键/自动总结** 的浏览器扩展，不改动站点原有 DOM 结构与业务逻辑，仅在帖子页内注入一块总结面板。

| 维度 | 结论 |
| --- | --- |
| 软件形态 | Chrome / Edge Manifest V3 浏览器扩展（content script 注入） |
| 目标站点 | `pickcat.dao3.fun/*`（含旧域名 `cdsq.dao3.fun/*`） |
| 注入位置 | 帖子详情页（`/forum/post/...`） |
| 核心能力 | 抓取帖子正文 → 调用用户指定的大模型 → 在分隔线下方展示总结 |
| 兼容性 | Chromium 内核（Chrome / Edge），支持亮/暗色主题 |

**为什么选扩展而非桌面软件**：需求中的「获取帖子内容」与「输出放在头像与点赞分割线下方」都要求读写网页 DOM，扩展的内容脚本是唯一能就地注入 UI 的方案；同时与 PickScribe 现有技术栈一致，可复用经验。

---

## 2. 需求拆解（三个核心）

| 编号 | 需求 | 落地要点 |
| --- | --- | --- |
| **R1** | 获取帖子内容（自动 / 手动点击） | 从帖子 DOM 提取正文（Markdown 文本 + 可选图片）。**自动模式**：打开帖子后经 SPA 路由变化自动触发；**手动模式**：面板上的「总结」按钮点击触发 |
| **R2** | 通过用户指定的模型总结 | 支持配置「服务商 / Base URL / API Key / 模型名 / 提示词」，用 OpenAI 兼容协议调用，支持流式输出 |
| **R3** | 输出放在头像与点赞分割线下方 | 定位分隔线元素，把总结卡片插入其**正下方**（正文区顶部） |

---

## 3. 站点结构（已实测，非猜测）

帖子详情页 `/forum/post/<uuid>` 关键结构：

| 用途 | 选择器（实测） |
| --- | --- |
| 帖子主体根节点 | `article.relative` |
| 作者头像 | `img.size-full!.rounded-full!.object-cover` |
| **头像 + 点赞/操作栏（含分隔线）** | `div[aria-label="作者与帖子操作"]`，其内为 `div.flex.items-center.justify-between.gap-2.mb-6.border-b.border-default.pb-4` |
| 分隔线本体 | 上述头行 div 的 **`border-bottom`**（站点未使用 `<hr>`，分隔线是带 `border-b` 的 div 底边） |
| 帖子正文 | `.markdown-body` |
| 页面外层容器 | `div.desktop:grid` |

**关键结论**

1. **「分隔线下方」= 插入到头行（`aria-label="作者与帖子操作"`）之后、`.markdown-body` 正文之前。**
2. 站点是 **Nuxt SPA**（存在 `__nuxt`），站内跳转**不触发整页刷新**，因此不能只依赖 `document_idle` 一次性注入，必须常驻监听 `location.href` 变化（沿用 PickScribe 的「面板存活自动重建」经验）。
3. 站点基于 **Tailwind + Nuxt UI**（`--ui-*` CSS 变量），暗色模式通过 `<html class="dark">` 切换。

**建议的挂载锚点（防御式降级）**：
```
优先级 1：div[aria-label="作者与帖子操作"]  ←  实测存在
优先级 2：.markdown-body 的父容器内的 头行 div（class 含 border-b、pb-4）
优先级 3：article.relative 内第一个 .markdown-body 之前的兄弟节点
```

---

## 4. 系统架构

```
┌───────────────── 浏览器 (Chromium) ─────────────────┐
│  pickcat.dao3.fun 帖子页                            │
│  ┌──────────────────────────────────────────────┐  │
│  │  Content Script (注入)                        │  │
│  │  ├─ Router Watcher  监听 SPA 路由变化          │  │
│  │  ├─ Extractor       提取正文/标题/图片          │  │
│  │  ├─ Panel UI        分隔线下方渲染面板          │  │
│  │  └─ Store Client    读写配置与缓存              │  │
│  └───────────────┬──────────────────────────────┘  │
│                  │ chrome.runtime.sendMessage        │
│  ┌───────────────▼──────────────────────────────┐  │
│  │  Background Service Worker                    │  │
│  │  ├─ Model Router      按配置选择服务商          │  │
│  │  ├─ LLM Client        fetch + SSE 流式解析      │  │
│  │  └─ Cache Manager     帖子 ID → 总结缓存        │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │  Options Page  配置服务商/Key/模型/提示词/模式    │  │
│  │  Popup         当前页开关、快速切换模型           │  │
│  └───────────────────────────────────────────────┘  │
│  chrome.storage.local  保存配置、缓存、开关状态       │  │
└──────────────────────────────────────────────────────┘
```

**分层原则**（沿用用户偏好：清晰分层、便于迭代）：
- **表现层**：`content/panel`（面板 UI 与交互）
- **逻辑层**：`content/extractor`、`content/router-watcher`
- **服务层**：`background/llm-client`、`background/model-router`
- **数据层**：`storage`（配置 + 缓存）

---

## 5. 三大功能模块设计

### 5.1 内容提取（R1）

- **提取源**：优先 `.markdown-body`（正文 Markdown/HTML），回退到 `article.relative` 全文。
- **元数据**：标题、作者、发布时间、帖子 UUID（从 URL 提取，作为缓存键）。
- **图片**：正文内图片转为 `[图片 N]` 占位说明，不随文本发送（默认），避免 token 爆炸；可选开启 Vision。
- **触发方式**：
  - *手动*：面板「总结」按钮 → 立即提取 + 调用。
  - *自动*：`router-watcher` 检测进入帖子页且正文就绪 → 若开启自动模式则自动提取 + 调用。
- **正文就绪判定**：SPA 内容异步加载，需轮询/`MutationObserver` 等 `.markdown-body` 出现且有文本后再提取。

### 5.2 模型调用（R2）

- **服务商抽象**：定义统一 `LLMProvider` 接口（`baseURL` / `apiKey` / `model` / `stream`），内置预设：
  - OpenAI 兼容（DeepSeek、通义、月之暗面、OpenRouter、硅基流动等自定义 Base URL）
  - 本地 Ollama（`http://localhost:11434`，需 host permissions 放开）
- **提示词**：默认模板（如「请用要点总结以下帖子，保留关键信息与结论」）+ 用户可自定义模板；可选长度（短/中/长）与语言。
- **流式输出**：Service Worker 用 `fetch` + `ReadableStream` 解析 SSE，增量 `port.postMessage` 回内容脚本实时渲染。
- **为什么放 Service Worker**：绕开页面 CSP/CORS 限制、集中管理 Key，且页面刷新不中断请求。

### 5.3 输出渲染（R3）

- **插入位置**：头行 `div[aria-label="作者与帖子操作"]` **之后**（即分隔线下方），作为正文区顶部的兄弟节点。
- **面板形态**：一张卡片，含标题栏（「AI 总结」+ 模型名 + 折叠/复制/重试/关闭按钮）与内容区。
- **状态机**：`idle → loading（骨架/流式）→ success / error(带重试)`。
- **样式**：跟随站点亮/暗色（读取 `--ui-*` 变量或监听 `html.dark`），不复用站点会被裁切的容器，避免被 `overflow` 剪裁。
- **可折叠**：默认展开，状态存 `chrome.storage`。

---

## 6. 配置项（Options Page）

| 分组 | 配置项 |
| --- | --- |
| 模型 | 服务商预设、Base URL、API Key、模型名、温度、最大 token |
| 提示词 | 系统提示词、用户模板、输出语言、输出长度 |
| 行为 | 自动总结开/关、手动/自动默认、流式开/关 |
| 外观 | 主题跟随/固定、默认折叠、面板位置微调 |
| 数据 | 清空缓存、导出/导入配置 |

> API Key 仅存 `chrome.storage.local`，只发送给用户配置的接口，不上报任何第三方。

---

## 7. 缓存 / 错误 / 安全

- **缓存**：以「帖子 UUID + 模型名 + 提示词哈希」为键缓存总结，命中即秒出；配置变更时失效重算。支持手动「重新总结」绕过缓存。
- **错误处理**：分类提示 —— 未配置 Key、401/403、429 限流、超时、网络失败、上下文超长（自动截断/分块）。全部提供「重试」。
- **安全**：最小权限（仅目标站点 host permission + 配置的服务商域名）；Key 不回显明文；不做任何数据外传。

---

## 8. 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 扩展规范 | Manifest V3 | Chromium 现行标准 |
| 语言 | 原生 JavaScript（+ 少量 HTML/CSS） | 与 PickScribe 一致，零构建、易维护 |
| UI | 手写 CSS + 复用站点 `--ui-*` 变量 | 避免引入框架体积，样式与站点协调 |
| 通信 | `chrome.runtime.sendMessage` + `Port` 长连接 | 流式传输 |
| 存储 | `chrome.storage.local` | 配置与缓存 |
| 打包 | ZIP（manifest.json 置于根目录，正斜杠路径） | 沿用 PickScribe 发版经验 |
| 构建工具 | 暂无（纯静态目录即可加载） | 降低复杂度 |

---

## 9. 目录结构（合并进 PickScribe 后的实际结构）

```
pickcat-rich-editor-extension/          # 现有扩展，编辑器模块保持不变
├─ manifest.json                        # MV3：新增 background / options / popup / storage 权限
├─ content.js                           # 【原有】富文本编辑器（命名空间 pcr，零改动）
├─ icons/ · fonts/                      # 【原有】图标与鸿蒙字体
├─ ai/
│  └─ content.js                        # 【新增】AI 总结面板（命名空间 pcai）
│                                       #   详情页路由监听 / 正文提取 / 面板注入 / 流式渲染
├─ background/
│  ├─ service-worker.js                 # 【新增】消息中枢：Port 收发、缓存管理
│  └─ llm-client.js                     # 【新增】OpenAI 兼容 fetch + SSE 流式解析
├─ shared/
│  ├─ constants.js                      # 【新增】服务商预设、选择器、默认提示词（ES module）
│  └─ storage.js                        # 【新增】chrome.storage.local 配置读写（ES module）
├─ options/
│  ├─ options.html / options.js / options.css   # 【新增】模型/Key/提示词/触发/外观配置
└─ popup/
   ├─ popup.html / popup.js / popup.css  # 【新增】当前页开关、快速切换模型
```

**命名空间隔离**：`content.js` 用 `pcr` 前缀，AI 模块用 `pcai` 前缀，样式与类名互不冲突；两者同属一个扩展、同一份 `chrome.storage.local` 配置。


---

## 10. 开发阶段规划

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| **P0 骨架** | manifest、目录结构、可加载空扩展、路由监听打点 | 能注入并确认进入帖子页 |
| **P1 提取** | 实现 extractor，稳定拿到正文/标题/UUID | 控制台可打印结构化帖子数据 |
| **P2 模型链路** | 服务商抽象 + LLM Client + SSE 流式 + Options 配置 | 用任意 OpenAI 兼容模型跑通一次总结 |
| **P3 注入渲染** | 面板 UI + 定位分隔线插入 + 状态机 + 亮暗色 | 实现 R3，端到端可用 |
| **P4 模式与缓存** | 自动/手动切换、缓存、重新总结、错误重试 | 完整体验闭环 |
| **P5 打磨** | Popup 快速开关、快捷切换模型、i18n、动效（淡入/折叠） | 体验优化 |
| **P6 发版** | 图标、权限最小化、ZIP 打包、README 使用说明 | 可分发产物 |

> 每个阶段均可独立验证；P0–P3 为最小可用闭环（MVP）。

---

## 11. 决策点（✅ 已确认，2026-10-18）

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 形态 | **浏览器扩展**（Chromium MV3），不做桌面软件 / 油猴脚本 |
| 2 | 服务商范围 | **内置多家预设**（优先带免费额度的）：DeepSeek、豆包（火山方舟）、通义千问、月之暗面、智谱 GLM、硅基流动、OpenRouter、本地 Ollama，外加「自定义 OpenAI 兼容」。统一走 OpenAI 兼容协议；API Key 由用户自行填写 |
| 3 | 默认触发 | **由用户选择**：设置项「手动点击 / 打开即总结」，默认「手动点击」 |
| 4 | 注入范围 | **仅帖子详情页**（`/forum/post/...`） |
| 5 | 自动模式批处理 | **不做**：不对列表页多帖批量总结 |
| 6 | 输出语言 / 长度 | **可配置**：语言（跟随原文 / 中文 / 英文）+ 长度（短 / 中 / 长） |
| 7 | 与 PickScribe 的关系 | **合并进 PickScribe** 现有扩展（`pickcat-rich-editor-extension`），共用一次安装、一处配置、一次更新 |

> 说明：第 2 项只覆盖 OpenAI 兼容协议，暂不内置 Anthropic / Gemini 原生协议（如后续有需求，可按 provider 抽象扩展）。
> 第 7 项落地方式：在现有扩展中新增 AI 子模块（`ai/` 内容脚本 + `background/` 服务 + `shared/` 内核 + `options/` 配置页），编辑器模块 `content.js` **不动**，二者通过命名空间隔离（`pcr` / `pcai`）。

---

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| SPA 站内跳转导致注入时机错过 | 常驻 watchdog 监听 `location.href`，内容就绪后再挂载 |
| 站点改版导致选择器失效 | 选择器集中管理 + 多级降级 + 基于 `aria-label` 等语义锚点 |
| 面板被站点容器 `overflow` 裁剪 | 不嵌入会被裁切的容器，插入为顶级兄弟节点，必要时脱离裁剪层 |
| 长帖超模型上下文 | 自动截断/分块摘要（map-reduce） |
| Key 泄露 | 仅存本地、仅发往用户配置域名、明文不回显 |
| CORS / CSP 拦截请求 | 请求统一放 Service Worker，并在 manifest 申请对应 host 权限 |

---

*下一步：按第 10 节从 P0 骨架开始实现，全部产物并入 PickScribe 现有扩展。*
