# PickScribe 开放接口方案（v1）

> 状态：设计稿 + v1.0 落地记录（本文的命名是设计稿；实际接口以 [INTEGRATION.md](./INTEGRATION.md) 为准）
> 适用范围：PickScribe（`pickcat-rich-editor-extension`，当前 4.0.0）与第三方 Chromium 扩展
> 目标站点：`https://pickcat.dao3.fun/`、`https://cdsq.dao3.fun/`
>
> **v1.0 落地差异**：实际实现采用统一信封 `{ source, v, id, action, payload, ts }`，已实现 `ping` / `state` / `ai.open` / `post.open` / `post.context` / `editor.read` / `editor.write` / `post.summarize`，与本文正文里的 `type: pickscribe:v1.*` 属于设计稿命名差异。数据动作在当前版本以「L1 + 首次访问确认」落地；L1 之外的配对 / HMAC 尚未实现，接入点预留在 `background/service-worker.js` 的 `apiAuthorize`。

---

## 0. 结论先行

1. **现有 v1 联动协议只能算“发现 + 单指令”**：`pickcat:link-ping` → `pickscribe:hello` → `pickcat:open-ai`，无 ACK、无请求 id、无超时约定、无权限分级。它可以继续兼容，但不适合直接开放给第三方。
2. **`source` 字段不能作为身份**。它和 `origin` 一样，只能证明“消息来自本页”，页面脚本可以完整伪造；同源 iframe 还能把消息投递到顶层窗口。开放前必须补 `ev.source === window`、nonce、限流，并把真正的高价值动作迁到“配对 + HMAC”或“扩展间 runtime 通道”上。
3. **建议分三层开放**：
   - L0 探测：版本、能力、页面状态（无需授权，页面可见）；
   - L1 UI 动作：打开 AI 面板、按 id 打开浮层（低风险，需总开关）；
   - L2 数据动作：读帖子上下文、读/写编辑器、触发 AI 总结（必须配对 + 逐项授权 + 限流）。
4. **v1.0 实际落地**：协议骨架（ping/hello/ack/state）+ `ai.open` + `post.open` + `post.context` + `editor.read` + `editor.write` + `post.summarize` + 文档与自检脚本。数据动作在原计划的 L2 之前提前落地，但补齐了「全局能力开关（`writeEditor` / `aiQuota` 默认关闭）+ 逐扩展首次确认（长期 / 仅本次 / 拒绝）」这条授权链；配对 + HMAC 仍留给 v1.1，届时只替换身份校验，不改信封与动作参数。
5. **纯扩展环境没有“绝对安全”**：拥有站点 host 权限的恶意扩展本来就能直接抓 DOM，本方案能解决的是页面脚本伪造、跨插件冒用、静默批量取数和审计问题，不能阻止等价于“直接读网页”的抓取。这个边界需要在文档里写明，避免给第三方错误预期。

---

## 1. 现状盘点

### 1.1 现有联动实现

全部逻辑集中在一个 IIFE 中：[content.js](../pickcat-rich-editor-extension/content.js#L3841-L3879)。

| 项 | 现状 | 问题 |
| --- | --- | --- |
| 探测 | PICKCAT Plus 发 `pickcat:link-ping`，PickScribe 回 `pickscribe:hello` | 无请求 id；多客户端无法区分；所有客户端共用同一份 hello |
| 主动广播 | PickScribe 在 0 / 1500 / 4000ms 发 `pickscribe:link-ping` | 固定三次，SPA 路由切换后不会重新广播 |
| 动作 | `pickcat:open-ai`，仅编辑页且 `pcr_plus_link !== false` 时调用 `openAIWriter(true)` | 无 ACK；不接受参数；不能指定预填提示词 |
| 身份 | `ev.origin === location.origin` + `d.source === 'pickcat-plus'` | `source` 可被页面脚本伪造；未校验 `ev.source === window` |
| 发送 | `window.postMessage(o, '*')` | 虽然目标是当前 window，不构成跨源泄露，但建议显式写 `location.origin` |
| 版本 | `chrome.runtime.getManifest().version` | 只有版本号，没有协议版本与能力清单结构 |
| 能力 | `features: ['ai', 'editor']` | 粒度过粗，无法表达“本页是否可用” |
| 设置 | `pcr_plus_link`（[options.html](../pickcat-rich-editor-extension/options/options.html#L487-L526)、[options.js](../pickcat-rich-editor-extension/options/options.js#L880)） | 只有一个全局开关，没有客户端列表、授权粒度、审计 |

### 1.2 可复用的能力底座

| 能力 | 现有实现 | 可直接复用程度 |
| --- | --- | --- |
| 打开写作助手 | `openAIWriter(keepOpen)`（[content.js#L3817-L3830](../pickcat-rich-editor-extension/content.js#L3817-L3830)），输入框在 `aiRefs.input`（L3717） | 高；预填提示词需补几行 |
| 打开 AI 排版 | `openAIFormatter()`（[content.js#L4169](../pickcat-rich-editor-extension/content.js#L4169)） | 高 |
| 编辑页判定 | `isEditorPage()`（[content.js#L44](../pickcat-rich-editor-extension/content.js#L44)） | 高 |
| 读写编辑器 | `mdToHtml`（L201）、`htmlToMd`（L583）、`setTextareaValue`（L2767）、`richToSource`（L2778）、`sourceToRich`（L2790）、`insertHtml`（L1499）、`setMode`（L2806） | 高；缺 revision / 幂等 / 撤销语义 |
| 选区读取 | `getSelectedText()`（[content.js#L1521](../pickcat-rich-editor-extension/content.js#L1521)） | 高 |
| 按 id 打开浮层 | `openPost(topicId, link)`（[overlay/content.js#L1243](../pickcat-rich-editor-extension/overlay/content.js#L1243)） | 中；强依赖 `link` 和非空 `card`，且入口只在信息流页（L2872-L2903） |
| 浮层内 AI 总结 | `runAiPanel()`（[overlay/content.js#L4438](../pickcat-rich-editor-extension/overlay/content.js#L4438)），UI 在 L858-L860 | 中；函数在 IIFE 内，无对外入口，无流式对外事件 |
| 帖子页 AI 总结 | `runSummary()`（[ai/content.js#L1467-L1507](../pickcat-rich-editor-extension/ai/content.js#L1467-L1507)），面板显隐在 L1519-L1535 | 中；同上，且需先确保面板可见 |
| 读取帖子上下文 | `getPostId()`（[ai/content.js#L97](../pickcat-rich-editor-extension/ai/content.js#L97)）、`extractPost()`（L150-L174） | 高；`extractPost` 是纯文本，不是 Markdown |
| 浮层开关状态 | `overlayEnabled`（[overlay/content.js#L142](../pickcat-rich-editor-extension/overlay/content.js#L142)） | 高 |

### 1.3 结构性约束

1. **隔离世界**：`content.js`、`ai/content.js`、`overlay/content.js` 是三个独立 IIFE，各自运行在隔离世界，彼此看不到变量与函数；唯一共享面是 `window.postMessage` 和 DOM。
2. **没有统一入口**：现在只有 `content.js` 在听协议，但它无法直接调用 `overlay/content.js` 的 `openPost` 或 `ai/content.js` 的 `runSummary`。
3. **同一个页面会有多个脚本抢答**：如果每个脚本都加协议监听，`ping` 会收到多份 `hello`，能力声明会互相覆盖。必须有一个“协议代理（broker）”。
4. **页面脚本可观察一切 window 消息**：同源 `postMessage` 不是秘密通道；任何加固都只能做到“不可伪造 + 不可重放”，不能做到“页面看不见”。
5. **MV3 Service Worker 会休眠**：配对验证若放在 SW，需要把 secret 持久化到 `chrome.storage.local`，并接受首次唤醒延迟。

---

## 2. 目标与非目标

### 目标

- 让第三方扩展**发现** PickScribe、读取**准确的能力清单**、发起**受控动作**、拿到**明确结果**。
- 同一套协议同时服务 PICKCAT Plus 和新的第三方客户端，且不破坏现有 v0 行为。
- 所有高价值动作具备：身份、授权、限流、审计、可撤销。
- 文档、示例、自检工具齐全，第三方能在不改 PickScribe 代码的前提下接入。

### 非目标（v1 明确不做）

- 不做通用 RPC / 任意 DOM 查询 / 任意 fetch 代理。
- 不允许第三方代发帖、代评论、点赞、收藏、关注。
- 不暴露 API Key、AI 配置、`chrome.storage` 全量、Cookie、通知、私信。
- 不承诺“阻止拥有站点权限的扩展直接抓 DOM”。
- 不做跨站点调用；协议只在 PickScribe 匹配的两个站点上生效。

---

## 3. 总体架构

```
┌────────────────────────────── 页面 window ──────────────────────────────┐
│                                                                          │
│  第三方 content script (隔离世界)          PickScribe content.js (broker) │
│        │  postMessage(请求/ACK/事件)  ◄──────────────►                   │
│        │                                        │                        │
│        │                                        │ chrome.runtime         │
│        │                                        ▼                        │
│        │                              PickScribe background SW            │
│        │                              · 身份/配对校验                     │
│        │                              · 权限/限流/审计                     │
│        │                              · 把动作广播给同 tab 的角色脚本      │
│        │                                        │                        │
│        │                        ┌───────────────┼───────────────┐        │
│        │                        ▼               ▼               ▼        │
│        │                  content.js       ai/content.js   overlay/content.js
│        │                  editor 动作       帖子总结        浮层动作      │
└──────────────────────────────────────────────────────────────────────────┘
```

关键设计：

- **broker 只做转发，不做授权判断**。broker 在 `content.js` 中（它在所有站点页注入，见 `manifest.json` L19-L31），负责收 window 消息、回 ACK、发 hello；真正的身份校验、权限判断、限流放在 background SW。
- **内部派发走 `chrome.runtime.sendMessage` → SW → `chrome.tabs.sendMessage`**，不走 window。这样页面脚本无法伪造“内部命令”，也不会出现“broker 信任了页面发来的 CustomEvent”这种绕过。
- 各能力脚本在启动时向 SW 注册 `{role, actions, page}`；broker 汇总后生成 hello。SW 休眠后可从 `chrome.storage.session` 或重新注册恢复。
- 如果不想引入 SW 中转，v1.0 也可以先做“broker 直连 + 仅 UI 动作”，但 v1.1 加权限时仍要迁到 SW；建议一次到位，避免二次改架构。

---

## 4. 接口清单

### 4.1 信封格式

所有 v1 消息统一使用下面的信封；`payload` 内才是业务参数。

```json
{
  "source": "pickcat-client",
  "client": { "id": "扩展 ID（仅 runtime 通道可信）", "name": "Third Party", "version": "1.0.0" },
  "type": "pickscribe:v1.post.open",
  "requestId": "c-7f3a2b",
  "nonce": "9tK3...（16 字节 base64url）",
  "ts": 1760000000000,
  "auth": { "mode": "paired", "pairId": "p-1", "mac": "base64url(HMAC-SHA256)" },
  "payload": { "postId": "uuid" }
}
```

PickScribe 的响应统一为：

```json
{
  "source": "pickscribe",
  "type": "pickscribe:v1.ack",
  "replyTo": "c-7f3a2b",
  "ok": true,
  "code": "OK",
  "message": "",
  "stage": "done",
  "data": {},
  "ts": 1760000000123
}
```

- `stage`：`accepted`（已受理，后续有事件）或 `done`（已完成）。
- 每个请求都必须有 ACK；动作是否“需要 ACK”在下面逐个标注。
- 事件统一用 `pickscribe:v1.event.<name>`，不要求 ACK。

### 4.2 探测类

| type | 方向 | 用途 | payload | 返回 | 需要 ACK |
| --- | --- | --- | --- | --- | --- |
| `pickscribe:v1.ping` | 客户端 → PR | 探测 PickScribe 是否在、协商协议版本 | `{ protocol: { min: "1.0", max: "1.1" }, client: {...} }` | `pickscribe:v1.hello` | 是（hello 即响应；不再单独 ack） |
| `pickscribe:v1.hello` | PR → 客户端 | 能力声明 + 会话信息 | — | 见 4.3 | 否 |
| `pickscribe:v1.state` | 客户端 → PR | 轻量查询当前页面 / 编辑器 / 浮层 / AI 状态 | `{}` | `{ page, editor, overlay, ai }` | 是 |
| `pickscribe:v1.changed` | PR → 客户端 | 能力或页面变化通知 | — | `{ reason, page?, actions? }` | 否 |

`hello` 结构：

```json
{
  "source": "pickscribe",
  "type": "pickscribe:v1.hello",
  "version": "4.0.0",
  "protocol": { "min": "1.0", "max": "1.1" },
  "session": { "bootId": "b-20261108-1", "nonce": "s-...", "pairId": "" },
  "page": { "type": "editor|post|feed|other", "postId": "" },
  "features": ["ai", "editor", "overlay"],
  "actions": [
    { "name": "ai.open", "since": "1.0", "scope": "ui.open", "pages": ["editor"], "auth": "toggle" },
    { "name": "post.open", "since": "1.0", "scope": "ui.open", "pages": ["feed", "post", "other"], "auth": "toggle" }
  ],
  "auth": { "mode": "none|pair-required|paired", "clientId": "" },
  "limits": { "requestsPerMinute": 30, "contentReadsPerMinute": 5 }
}
```

- `features` 保留旧的粗粒度值，**只增不改**；新接入方只看 `actions`。
- `actions[].pages` 表示“当前页面类型下可用”，不是“全局可用”。
- `actions[].auth`：`none`（无需授权）、`toggle`（总开关）、`pair`（必须配对 + scope）。

### 4.3 能力声明类

| type | 方向 | 用途 | 说明 |
| --- | --- | --- | --- |
| `pickscribe:v1.ping` / `hello` | 双向 | 声明版本、actions、页面上下文 | 客户端必须按 `actions` 判断，不得按扩展版本号硬编码 |
| `pickscribe:v1.changed` | PR → 客户端 | 设置变更、SPA 路由切换、浮层开合导致能力变化 | 客户端收到后刷新本地能力表 |
| `pickscribe:v1.deprecation` | PR → 客户端 | 废弃预告 | `{ action, since, removeIn, replacement }`，每个会话最多一次 |

能力字符串建议（append-only）：

```
ai.writer.open
ai.formatter.open
post.overlay.open
post.context.read
editor.read
editor.selection.read
editor.write
ai.summary.post
```

### 4.4 动作类

#### A. `pickscribe:v1.ai.open`

| 项 | 内容 |
| --- | --- |
| 用途 | 打开编辑页写作助手 / AI 排版窗口 |
| 参数 | `{ "mode": "writer" \| "format", "prompt": "可选，预填指令", "focus": true }` |
| 返回 | `{ "opened": true, "mode": "writer" }` |
| ACK | 是（`done`） |
| 页面 | `editor` |
| 权限 | `ui.open` + 总开关 |
| 现状 | **可支持**：`openAIWriter(true)` 已存在；`openAIFormatter()` 也已存在 |
| 代价 | 低。需补：预填 `aiRefs.input.value` 并派发 `input`；把 `pcr_plus_link` 与新总开关分开，避免“开一个等于开全部” |

#### B. `pickscribe:v1.post.open`

| 项 | 内容 |
| --- | --- |
| 用途 | 按帖子 id 打开浮层预览 |
| 参数 | `{ "postId": "uuid", "anchor": "auto\|card\|center" }` |
| 返回 | `{ "opened": true, "postId": "uuid", "mode": "overlay\|navigated" }` |
| ACK | 是（`done` 或 `accepted`，以浮层动画开始为准） |
| 页面 | `feed` 优先；`post` / `other` 需拍板 |
| 权限 | `ui.open` + 总开关 |
| 现状 | **部分支持**：`openPost(topicId, link)` 要求 `link` 非空，内部 `link.closest('article')`（L1254）会直接抛错；点击入口只在信息流页（L2891） |
| 代价 | 低到中。需要：把 `openPost` 改成 `openPostById(id, anchorEl?)`；无卡片时用视口中心矩形兜底；`current.link = null` 时跳过原卡片动画；非信息流页决定“覆盖打开”还是“跳转原帖” |

#### C. `pickscribe:v1.post.summarize`

| 项 | 内容 |
| --- | --- |
| 用途 | 对当前帖子（或浮层内当前帖）做 AI 总结 |
| 参数 | `{ "postId": "可选，默认当前详情页 / 浮层打开的帖子" }` |
| 返回 | `{ "postId": "...", "summary": "...", "cached": false, "length": 456, "model": "deepseek-chat" }` |
| ACK | 是（一次 ACK 带完整结果；不做流式事件） |
| 页面 | `post`（详情页）或 `feed`（浮层打开时）；没有当前帖返回 `UNSUPPORTED_CONTEXT` |
| 权限 | `aiQuota` 全局开关（默认关闭）+ 逐扩展首次确认；另受 AI 总开关与「帖子总结」分项开关约束 |
| 现状 | **已实现**：`overlay/content.js` 的 `apiPostSummarize()` 复用 `summaryMessages()` / `summaryCacheKey()` 与 `pcai_cache`，命中缓存直接返回 `cached: true`，未命中才通过独立 `pcai` 端口调用模型 |
| 错误码 | `UNSUPPORTED_CONTEXT`、`NOT_FOUND`、`EMPTY_POST`、`UNAUTHORIZED`、`AI_DISABLED`、`AI_DISABLED_FEATURE`、`AI_NOT_CONFIGURED`、`AI_TIMEOUT`、`AI_EMPTY`、`FETCH_FAILED`、`PERMISSION_DISABLED`、`DENIED`、`CONSENT_TIMEOUT` |
| 说明 | 只返回摘要文本、长度、模型与 `cached`，不返回 API Key / 提示词 / 对话原文；后台按长耗时 90 秒处理，超时返回 `AI_TIMEOUT`；`force` / 流式事件 / `summary.status` 留到后续版本 |

> 限制：只支持“当前页 / 当前浮层里的帖子”。跨帖总结需要额外拉取正文，v1.0 仍不做（会引入新的网络请求与鉴权面）。

#### D. `pickscribe:v1.post.context`

| 项 | 内容 |
| --- | --- |
| 用途 | 读取当前帖子上下文 |
| 参数 | `{ "fields": ["id", "title", "author", "url", "body"] }` |
| 返回 | 对应字段；`body` 为纯文本（帖子页取 `extractPost().content`，浮层取 `firstPost.cookedHtml` 去标签后的文本） |
| ACK | 是 |
| 页面 | `post` / 浮层打开时的 `feed` |
| 权限 | `post.context` + 配对；`body` 需“允许一次”或持久授权 |
| 现状 | **已实现**：`overlay/content.js` 的 `apiPostContext()` 统一从 `apiFetchTopic()` / 浮层已加载的 `view.topic` 取数据，正文转 Markdown 后返回；字段白名单与 100000 字符截断已落地 |
| 说明 | 不返回头像、徽章等站内装饰字段；`bodyTruncated` / `bodyLength` 标记截断；首次调用走全局开关 + 逐扩展确认 |

#### E. `pickscribe:v1.editor.read`

| 项 | 内容 |
| --- | --- |
| 用途 | 读取编辑器内容与选区 |
| 参数 | `{ "format": "markdown\|text", "includeSelection": true }` |
| 返回 | `{ "markdown": "...", "mode": "rich\|split\|source", "revision": "sha256-8", "length": 1234, "truncated": false, "selection": { "text": "...", "start": 0, "end": 0 } }` |
| ACK | 是 |
| 页面 | `editor` |
| 权限 | `editor.read` + 配对（红级） |
| 现状 | **已实现**：`content.js` 的 `apiReadEditor()` 支持 `markdown` / `text` 两种格式、revision、长度、截断与 `dirty` |
| 说明 | 只返回正文与元信息，不返回选区；`includeSelection` 未实现 |

#### F. `pickscribe:v1.editor.write`

| 项 | 内容 |
| --- | --- |
| 用途 | 在光标处插入 / 整体替换编辑器内容 |
| 参数 | `{ "text": "Markdown", "mode": "insert\|replace" }`；`mode` 可省略，默认 `insert` |
| 返回 | `{ "mode": "insert", "editorMode": "rich", "length": 1234, "insertedLength": 24, "replacedLength": 0, "revision": "a1b2c3d4e5f60718", "dirty": true }` |
| ACK | 是（一次 ACK 带写入结果） |
| 页面 | `editor`；非编辑页返回 `UNSUPPORTED_CONTEXT`，未挂载返回 `NOT_READY`，只读返回 `EDITOR_READONLY` |
| 权限 | `writeEditor` 全局开关（默认关闭）+ 逐扩展首次确认；`replace` 的确认窗会显示将被替换的字符数 |
| 现状 | **已实现**：`content.js` 的 `apiWriteEditor()` 走 `insertHtml`（insert）或 `setTextareaValue` + `sourceToRich`（replace），写入后富文本与源码同步，保持当前视图可继续编辑 |
| 说明 | 默认 `insert` 避免误清空；`insert` 拒绝空文本；只收 Markdown，不接受 HTML；去重只按 requestId，同 id 重试不会重复写入；`ifRevision` 冲突检测与撤销栈保留留到后续版本 |

#### G. 可选：`pickscribe:v1.post.close`

关闭当前浮层，`{}` → `{ "closed": true }`。低风险，建议 v1.1 顺手提供，便于第三方面板联动。

### 4.5 ACK 与错误码

| code | 含义 | 调用方处理 |
| --- | --- | --- |
| `OK` | 成功 | — |
| `BAD_REQUEST` | 信封 / 参数不合法 | 修代码，不重试 |
| `UNSUPPORTED` | 未知 type / 本版本不支持 | 查 `actions`，不重试 |
| `UNAUTHORIZED` | 未配对 / MAC 失败 / 配对过期 | 引导用户配对 |
| `FORBIDDEN_SCOPE` | 已配对但未授权该能力 | 引导用户在设置里授权 |
| `UNSUPPORTED_CONTEXT` | 当前页面 / 无浮层 / 非编辑页 | 换页面或提示用户 |
| `NOT_READY` | 编辑器 / 浮层 / 正文尚未就绪 | 可重试（指数退避） |
| `CONFLICT` | `ifRevision` 不匹配 | 重新 read 后合并 |
| `BUSY` | 已有同类请求进行中 | 等待事件或稍后重试 |
| `RATE_LIMITED` | 超限 | 按 `retryAfter` 等待 |
| `AI_DISABLED` / `AI_DISABLED_FEATURE` / `AI_NOT_CONFIGURED` | 用户关闭 AI 总开关 / 对应分项关闭 / 未配置 Key | 提示用户，不重试 |
| `CANCELLED` | 用户关闭面板 / 主动取消 | 不重试 |
| `INTERNAL` | 未预期异常 | 记录日志，可重试一次 |

---

## 5. 命名空间与版本策略

### 5.1 命名

- 新协议统一 `pickscribe:v1.<domain>.<verb>`，例如 `pickscribe:v1.ai.open`、`pickscribe:v1.post.summarize`。
- 响应统一 `pickscribe:v1.ack`；事件统一 `pickscribe:v1.event.<name>`；通知统一 `pickscribe:v1.changed` / `pickscribe:v1.deprecation`。
- 方向由 `source` / `client` 决定，不由 type 前缀决定；不要再用 `pickcat:*` 作为新接口名。
- 旧 type 冻结：
  - `pickcat:link-ping`、`pickcat:open-ai` 继续按原样支持；
  - `pickscribe:hello`、`pickscribe:link-ping` 继续按原样广播；
  - 旧接口不再增加能力，只做安全修复（加 `ev.source` 校验、限流）。

### 5.2 版本协商

- 协议版本用 `{ min, max }`，主版本放在 type 里（`v1`），次版本只做加法。
- 客户端 `ping` 带自己支持的 `min/max`；PickScribe 取交集最高值，在 `hello.protocol` 回传。
- **扩展版本号（示例中为 4.0.0，随版本变化）只作展示**，任何能力判断都必须用 `actions` / features，不允许 `if (version >= '3.11')`。
- 同一 `hello` 里 `bootId` 标识一次页面生命周期；扩展重载 / 页面刷新后 `bootId` 变化，客户端应丢弃旧请求状态。

### 5.3 后向兼容规则

1. 只增字段、只增 action、只增错误码；不删字段、不改字段语义、不复用废弃名称。
2. 未知字段忽略；未知 `payload` 键忽略；未知 action 返回 `UNSUPPORTED`，不能抛异常。
3. 新增 action 必须带 `since`，默认 `auth` 不得高于同类现有 action。
4. 旧客户端不认识的 event 直接忽略，不得因此断开。
5. 任何破坏性改动必须升 `v2` 命名空间；v1 至少保留两个次版本周期。

### 5.4 废弃流程

1. 先在 `hello.actions` 里标记 `deprecated: { since, removeIn, replacement }`，同时发一次 `pickscribe:v1.deprecation`。
2. 行为保持不变至少两个次版本（建议不少于 60 天）。
3. 到期后返回 `UNSUPPORTED`，错误信息里给替代 action。
4. 文档 `CHANGELOG` 记录；旧 type（v0）单独列“遗产接口”，不与新接口混写。

---

## 6. 来源校验与安全边界

### 6.1 现有校验为什么不够

```js
if (ev.origin !== location.origin) return;
if (!d || typeof d !== 'object' || d.source !== 'pickcat-plus') return;
```

- 页面脚本可以 `window.postMessage({ source: 'pickcat-plus', type: 'pickcat:open-ai' }, '*')`，完全通过。
- 同源 iframe 可以 `parent.postMessage(...)`，顶层窗口收到的 `ev.source` 是 iframe，但当前代码没校验 `ev.source`。
- 第三方扩展只要照抄 `source: 'pickcat-plus'` 就能冒充 PICKCAT Plus。
- 没有请求 id / nonce / 时间戳，无法防重放，也无法区分“谁发的”。

### 6.2 三级信任模型

| 级别 | 校验 | 允许的接口 | 适用 |
| --- | --- | --- | --- |
| L0 发现级 | `origin` + `ev.source === window` + type 白名单 | `ping` / `hello` / `state` | 所有客户端，无需授权 |
| L1 会话级 | L0 + `client` + `session.nonce` + 请求 id + 限流 | `ai.open`、`post.open`、`post.close` | 已开总开关的客户端；仍可被页面脚本伪造，只用于低风险 UI |
| L2 配对级 | L1 + 配对 secret + HMAC + 时间窗 + nonce 去重 | `post.context`、`editor.read`、`editor.write`、`post.summarize` | 第三方扩展的正式接入；v1.0 实际先用 L1 + 首次确认落地，v1.1 再补齐本行 |

**核心判断：`source` 永远不能单独授权任何动作。** L1 的价值只是防误触和跨客户端串话，不是安全边界。

### 6.3 配对 + HMAC（推荐）

#### 配对流程（一次性）

1. 第三方扩展在自己的 settings 里填 PickScribe 的扩展 ID（需固定 ID，见 6.5）。
2. 第三方 content script（隔离世界）调用：

```js
chrome.runtime.sendMessage(PR_ID, {
  type: 'pickscribe:v1.pair.request',
  client: { name: 'Third Party', version: '1.0.0' },
  scopes: ['ui.open', 'post.context', 'editor.read']
}, (resp) => { /* resp = { code, expiresIn } */ });
```

3. PickScribe 的 `runtime.onMessageExternal` 收到请求，`sender.id` 是**浏览器认证过的第三方扩展 ID**；`sender.tab` 指向当前站点 tab（需校验 URL 属于两个站点域）。
4. PickScribe 在页面里弹一个确认条（broker 负责渲染），显示：客户端名称、`sender.id`、6 位配对码、申请的能力。
5. 用户点“允许” → SW 生成 32 字节 secret，写入 `chrome.storage.local`（按 `clientId`），把 `{ secret, scopes, pairId }` 作为 `sendMessage` 的响应回给第三方。
6. 双方各自保存 secret；页面脚本全程看不到 secret。

> 配对码的作用是防止“两个扩展同时配对时配错对象”，不是加密材料。

#### 请求签名

拆封后计算：

```
canonical = "v1\n" + type + "\n" + requestId + "\n" + nonce + "\n" + ts + "\n" + sha256Hex(payloadJson)
mac       = base64url(HMAC-SHA256(secret, canonical))
```

校验顺序：

1. `ev.origin === location.origin`
2. `ev.source === window`
3. `source` 在允许集合内（`pickcat-client` / `pickcat-plus`）
4. `client.id` 已配对，`pairId` 一致，scope 覆盖该 action
5. `Math.abs(Date.now() - ts) <= 60_000`
6. `nonce` 未见过（LRU 1024 条 / 120 秒）
7. HMAC 常量时间比较
8. 限流
9. 页面 / 参数 / revision 校验
10. 执行

### 6.4 为什么不直接在 window 上做“挑战-应答”

- 任何挑战值都必须先通过 window 发给客户端，页面脚本同样能看到；页面脚本可以截获 challenge 并在同一 tick 内抢先应答。
- 页面脚本可以直接读 DOM，也能看到所有 window 消息；纯 window 通道无法建立“页面不知道”的秘密。
- 因此：
  - **nonce / 挑战只能防重放和串话，不能防伪造**；
  - **真正的身份只能来自扩展间 runtime 通道的 `sender.id`**；
  - 把 secret 通过 runtime 发一次，之后在 window 上用 HMAC 认证，是“安全 + 低延迟”的折中。

### 6.5 纯扩展环境的能力限制（必须写进文档）

1. **扩展 ID 不稳定**：未打包扩展每次加载 ID 可能变；要长期配对，需要在 `manifest.json` 增加 `key` 字段固定 ID，或以商店发布 ID 为准。加 `key` 属于 manifest 变更，需要拍板。
2. **无法阻止有 host 权限的扩展直接抓 DOM**：配对是“合作契约”，不是 DRM。
3. **无法约束第三方把 secret 放进 MAIN world**：文档必须明确“secret 只能存在于隔离世界的 content script / SW”，禁止注入页面主世界。
4. **MV3 SW 会休眠**：HMAC 校验若放在 SW，第一次请求可能多几十毫秒；secret 必须持久化，不能只放内存。
5. **无法认证“同名客户端”**：只认 `client.id`，`client.name` 仅用于 UI 展示，可伪造。
6. **页面本身始终能读自己的内容**：隐私控制的对象是“第三方扩展是否被允许结构化取数”，不是“站点内容保密”。
7. **无法防 DoS**：页面脚本可以高频 postMessage；只能限流、丢弃、不回复。

### 6.6 安全加固清单（按优先级）

- [ ] 所有监听器加 `ev.source === window`
- [ ] `postMessage` 显式用 `location.origin` 作为 targetOrigin
- [ ] type / source / 字段白名单；payload 大小上限
- [ ] 请求 id + nonce + 时间窗 + 去重
- [ ] 配对 + HMAC（L2）
- [ ] 限流（每分钟请求数、正文读取数、总结并发数）
- [ ] 审计日志（本地、可清空）
- [ ] 撤销配对后立即失效（内存 + storage 双清）
- [ ] 旧 v0 接口只保留 UI 动作，不再扩展

---

## 7. 权限与隐私

### 7.1 数据分级

| 级别 | 数据 | 默认 | 授权方式 |
| --- | --- | --- | --- |
| 绿 | 扩展版本、协议版本、actions、页面类型、编辑器是否可用、浮层是否打开 | 允许 | 无需授权 |
| 黄 | 帖子 id、标题、作者公开昵称、URL、编辑器 mode / 字数 / revision | 需配对 | 客户端级持久授权 |
| 红 | 帖子正文、编辑器 Markdown、选中文本、AI 总结结果 | 需配对 + 明确同意 | 每客户端 + 每次会话 / 单次确认 |
| 黑 | API Key、AI 配置、`chrome.storage` 全量、Cookie / token、通知、私信、其他用户资料、发帖 / 评论 / 点赞 / 关注能力、任意 fetch / DOM / eval | 永不 | — |

### 7.2 授权粒度

建议的 scope：

| scope | 覆盖动作 | 默认 |
| --- | --- | --- |
| `ui.open` | `ai.open`、`post.open`、`post.close` | 总开关打开后可用 |
| `post.context` | `post.context`（不含 body） | 配对时勾选 |
| `post.body` | `post.context` 的 `body` 字段 | 默认关闭，单次或会话授权 |
| `editor.read` | `editor.read` | 默认关闭 |
| `editor.selection` | `editor.read` 的 `selection` | 默认关闭 |
| `editor.write` | `editor.write` | 默认关闭，`replace` 每次确认 |
| `ai.summary` | `post.summarize` | 默认关闭，单独提示“会消耗你的 AI 额度” |

存储结构（`chrome.storage.local`）：

```json
{
  "pcr_api_clients": {
    "<extensionId>": {
      "name": "Third Party",
      "pairId": "p-1",
      "scopes": ["ui.open", "post.context", "editor.read"],
      "createdAt": 1760000000000,
      "lastUsedAt": 1760000000000
    }
  },
  "pcr_api_secret_<extensionId>": "base64url-32bytes",
  "pcr_api_audit": [
    { "ts": 1760000000000, "clientId": "...", "action": "editor.read", "ok": true, "code": "OK" }
  ]
}
```

- secret 单独 key 存放，避免审计 / 导出时误带。
- 审计只存本地，最多 100 条，可一键清空，不联网。
- 撤销配对：删除 client + secret + 相关进行中请求；客户端下次请求得到 `UNAUTHORIZED`。

### 7.3 明确不提供

- 当前登录用户的身份、邮箱、token、Cookie、私信、通知内容。
- 当前用户的“全部帖子 / 收藏 / 关注列表”。
- 跨帖批量正文、站内搜索接口代理、任意 URL fetch。
- 代发帖、代评论、点赞、收藏、关注、删除。
- AI Key / 模型配置 / 提示词模板 / 计费信息。

> 关于“当前用户”：现有代码没有 `currentUser` 接口，只有页面头部的作者信息（`extractPost().author`）。v1 不提供“当前登录用户”，如确有需要，应单独立项并明确授权。

### 7.4 AI 成本

`post.summarize` 消耗的是**用户自己的 API Key 额度**。v1.0 实际落地：

- 权限项为 `aiQuota`，全局开关默认关闭；首次调用按「扩展 + 权限项」弹一次确认，用户确认后才生效；
- 默认走缓存：命中时结果带 `cached: true` 且不调用模型；未命中才调用一次；
- 失败不自动重试（避免重复计费）；后台仍受每标签页 30 次/分钟的限流约束；
- 每次调用使用独立端口，不会覆盖面板里正在进行的流式总结；
- 每客户端 10 秒冷却、每页 1 个 in-flight、`force` 参数与流式事件尚未实现，留到 v1.1 / v1.2。

---

## 8. 时序与错误处理

### 8.1 加载顺序

双方都是 `document_idle`（`manifest.json` L19-L80），谁先加载不确定。约定：

1. **被动监听永远先注册**：两边脚本一开始就挂 `message` 监听，不依赖对方先到。
2. **PickScribe 主动广播**：启动后 0 / 500 / 1500 / 4000 / 8000ms 各发一次 `pickscribe:v1.hello`（或被动等 ping），之后每 30 秒一次，直到收到任意客户端 ping；页面隐藏时暂停。
3. **客户端主动探测**：启动后立即 ping，没收到 hello 则按 0 / 500 / 1500 / 4000 / 8000ms 重试；仍无则每 30 秒重试，并在 `visibilitychange` 时补一次。
4. **SPA 路由变化**：双方都监听 `location.href` 变化；PickScribe 重发 hello 和 `changed`，客户端重新取 `state`。
5. **扩展重载**：旧 content script 的 `chrome.runtime` 失效；PickScribe 已有 `extAlive()` 保护（[ai/content.js#L89-L91](../pickcat-rich-editor-extension/ai/content.js#L89-L91)）。客户端收到 `CONTEXT_INVALID` / 超时后重新 ping。

### 8.2 超时与重试

| 阶段 | 超时 | 重试 |
| --- | --- | --- |
| 发现（ping → hello） | 300ms / 次 | 0/500/1500/4000/8000ms，之后 30s |
| UI 动作 ACK | 1000ms | 幂等动作最多 1 次（`ai.open`、`post.open`、`state`） |
| 数据读取 ACK | 2000ms | 最多 1 次（`editor.read`、`post.context`） |
| 写入 ACK | 3000ms | 不自动重试；先查 state / revision |
| 总结受理 | 3000ms | 不重试，先查 `summary.status` |
| 总结流空闲 | 20s | 终止并提示；可重新发起（走缓存） |
| 总结总时长 | 180s | 终止 |

### 8.3 ACK 缺失时怎么判断

- **不能假设“没收到 ACK = 没执行”**：UI 动作和写入都可能已经生效。
- 对幂等动作（open / read / state）：可以直接重试。
- 对非幂等动作（write / summarize）：先用 `state` / `summary.status` 查询，再决定是否重发。
- 每个请求带 `requestId`；PickScribe 缓存最近 64 个请求结果 120 秒，重复 requestId 返回同一 ACK 并带 `duplicate: true`。
- 事件流中断时，客户端以 `summary.status` 的终态为准，不能只依赖最后一个 chunk。

### 8.4 事件与终态

- `post.summarize` 的 ACK 只表示“已受理”；最终结果以 `.done` / `.error` 为准。
- 若用户在生成途中关闭浮层 / 面板：发 `.error { code: 'CANCELLED' }`，并释放 in-flight。
- 若扩展被重载：没有终态事件；客户端在 20 秒空闲后自行判定失败。

---

## 9. 文档与兼容性交付物

### 9.1 文档位置

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 对外接口文档 | `docs/INTEGRATION.md` | 现有代码注释已经指向它（[content.js#L3845](../pickcat-rich-editor-extension/content.js#L3845)），建议就放这里，避免注释再改 |
| 本方案 | `docs/pickscribe-open-api-v1.md` | 内部决策稿；定稿后把“已拍板”的结论合并进 INTEGRATION.md |
| 机器可读清单 | `docs/api/pickscribe-v1.json` | actions / 参数 / 错误码 / since / scope，供第三方或文档站生成 |
| 自检脚本 | `docs/api/selftest.js` | 粘贴到 DevTools Console 即可验证 |
| 最小示例 | `docs/INTEGRATION.md` 内嵌 | manifest 片段 + 30 行 content script |
| 变更记录 | `CHANGELOG.md` | 每次新增 / 废弃 action 记一条 |

### 9.2 最小接入示例（文档内提供）

```js
// third-party content script（隔离世界）
const PR_ID = 'pickscribe-extension-id';   // 由用户填写或内置
const SOURCE = 'pickcat-client';

function ping() {
  window.postMessage({
    source: SOURCE,
    client: { name: 'My Extension', version: '1.0.0' },
    type: 'pickscribe:v1.ping',
    requestId: 'p-' + Date.now(),
    nonce: crypto.randomUUID(),
    ts: Date.now(),
    payload: { protocol: { min: '1.0', max: '1.1' } }
  }, location.origin);
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== 'pickscribe') return;
  if (d.type === 'pickscribe:v1.hello') {
    console.log('PickScribe', d.version, d.actions);
    // 例：打开 AI 面板（需 L1 总开关）
    window.postMessage({
      source: SOURCE,
      client: { name: 'My Extension', version: '1.0.0' },
      type: 'pickscribe:v1.ai.open',
      requestId: 'r-' + Date.now(),
      nonce: crypto.randomUUID(),
      ts: Date.now(),
      payload: { mode: 'writer', prompt: '帮我整理这篇帖子' }
    }, location.origin);
  }
  if (d.type === 'pickscribe:v1.ack') console.log('ack', d);
});

ping();
```

> 上例是 L1（无签名）。L2 需要在配对后把 `auth.mac` 补进信封，文档会给完整版本。

### 9.3 自检

- **v1.0**：`docs/api/selftest.js`，在站点任意页面 DevTools Console 运行，输出：是否收到 hello、协议版本、actions、当前 page、`state` 结果。
- **为什么不做一个独立 `ping.html`**：`postMessage` 只在同一 window 内有效；独立域名的页面无法与站点窗口通信。可行方案只有：
  1. 站点同源页面（例如站点自己的某个页面）承载脚本；
  2. 用户在站点页手动粘贴脚本；
  3. 以后加 `scripting` 权限，由设置页主动注入自检脚本（会增加权限，需拍板）。
- **v1.1**：在设置页加“第三方扩展”面板，列出已配对客户端、最近请求、撤销按钮，并提供“复制自检脚本”。

### 9.4 兼容性

- 旧 PICKCAT Plus 不改代码也能继续用：`pickcat:link-ping` / `pickcat:open-ai` 保持原行为。
- 新协议与旧协议可同时存在；同一个页面允许同时有多个客户端。
- 文档明确：`source: 'pickcat-plus'` 是遗产标识，新客户端请用 `pickcat-client`，不要复用旧名。
- 旧 `features: ['ai','editor']` 保留；新客户端只读 `actions`。

---

## 10. 落地顺序

### v1.0 — 协议骨架 + 两个 UI 动作

- 信封、`ping` / `hello` / `ack` / `state` / `changed`。
- broker（content.js）+ SW 内部派发骨架。
- 安全基线：`ev.source`、targetOrigin、白名单、请求 id、限流。
- `ai.open`（含 `prompt` 预填）、`post.open`（含 id 兜底）。
- 设置页新增“第三方扩展”只读区域：总开关、当前会话客户端、协议版本。
- 文档 + 自检脚本 + 最小示例。
- 不做任何正文 / 编辑器读取。

### v1.1 — 身份与只读数据

- 配对流程（runtime `sender.id` + 6 位码 + 用户确认）。
- HMAC 校验、nonce 去重、时间窗、审计日志、撤销。
- `post.context`（不含 body）与 `editor.read`（含 revision）。
- `post.body` / `editor.selection` 单次授权。
- 限流参数落地；`summary.status` 可选。

### v1.2 — 写与 AI

> `editor.write` 与 `post.summarize` 已在 v1.0 以「L1 + 全局开关 + 首次确认」提前落地；v1.2 的重点是把它们迁到配对身份上，并补齐下面的增强项。

- `editor.write` 增强：`ifRevision` 冲突检测、撤销栈保留策略（v1.0 已实现 insert / replace + 确认窗字符数）。
- `post.summarize` 增强：流式事件、`summary.status` 补偿、`force` 参数（v1.0 已实现缓存优先 + AI 额度授权 + 90 秒长超时）。
- `post.close`。
- 公开 `docs/api/pickscribe-v1.json`，补第三方示例仓库。

### v1.3 — 生态

- 废弃流程演练、文档站、兼容性矩阵。
- 视需要评估“全 runtime 通道”（高价值动作完全不走 window）。
- 视需要评估 `scripting` 权限做一键自检。

---

## 11. 需要用户拍板的点

1. **安全投入**：接受“window + 配对 + HMAC”这套折中，还是先只做 L1（简单但可被页面脚本伪造）？
2. **固定扩展 ID**：是否在 `manifest.json` 增加 `key` 以稳定扩展 ID？不加的话，配对和文档里的 ID 会随开发包变化。
3. **正文与编辑器读取**：是否开放给第三方？如果开放，默认“每次确认”还是“客户端级持久授权”？
4. **AI 触发**：是否允许第三方消耗用户的 AI 额度？默认关闭是否可接受？
5. **编辑器写入**：是否允许 `replace`？还是只允许 `insert` / `append`？`replace` 是否需要每次弹确认？
6. **非信息流页打开浮层**：`post.open` 在帖子详情页 / 其他页是“覆盖打开”“跳转原帖”还是直接 `UNSUPPORTED_CONTEXT`？
7. **旧命名**：`source: 'pickcat-plus'` 保留多久？新客户端是否强制 `pickcat-client`？
8. **文档与自检形态**：是否接受“DevTools 脚本”作为 v1 自检？还是愿意加 `scripting` 权限做设置页一键自检？
9. **限流数值**：30 次/分钟、5 次正文读取/分钟、总结 10 秒冷却、单页 1 并发，是否合适？

---

## 12. 关键代码路径

| 主题 | 文件 | 位置 |
| --- | --- | --- |
| 现有联动协议 | `pickcat-rich-editor-extension/content.js` | L3841-L3879 |
| 打开写作助手 | `pickcat-rich-editor-extension/content.js` | L3817-L3830 |
| AI 排版入口 | `pickcat-rich-editor-extension/content.js` | L4169 |
| 编辑页判定 | `pickcat-rich-editor-extension/content.js` | L44 |
| Markdown ↔ HTML | `pickcat-rich-editor-extension/content.js` | L201、L583 |
| 编辑器写回 / 视图切换 | `pickcat-rich-editor-extension/content.js` | L2767-L2870 |
| 插入 HTML / 取选区 | `pickcat-rich-editor-extension/content.js` | L1499、L1521 |
| 编辑器挂载 | `pickcat-rich-editor-extension/content.js` | L3024-L3084 |
| 帖子页 AI 总结 | `pickcat-rich-editor-extension/ai/content.js` | L1467-L1507 |
| 帖子页 AI 面板显隐 | `pickcat-rich-editor-extension/ai/content.js` | L1519-L1535 |
| 帖子上下文提取 | `pickcat-rich-editor-extension/ai/content.js` | L97、L150-L174 |
| 浮层打开 | `pickcat-rich-editor-extension/overlay/content.js` | L1243-L1295、L2872-L2903 |
| 信息流相邻帖子 | `pickcat-rich-editor-extension/overlay/content.js` | L551-L603 |
| 浮层 AI 总结 | `pickcat-rich-editor-extension/overlay/content.js` | L4438-L4500 |
| 浮层 AI UI | `pickcat-rich-editor-extension/overlay/content.js` | L858-L860 |
| 联动设置 UI | `pickcat-rich-editor-extension/options/options.html` | L487-L526 |
| 联动设置逻辑 | `pickcat-rich-editor-extension/options/options.js` | L880、L1145-L1150 |
| 扩展清单 / 版本 | `pickcat-rich-editor-extension/manifest.json` | L4、L19-L80 |

---

*本文只是方案，未修改任何代码；第 11 节确认后再进入实现。*
