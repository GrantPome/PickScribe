# PickScribe 开放接口 v1.0

> 适用版本：PickScribe 3.10.x
> 站点：`https://pickcat.dao3.fun/`、`https://cdsq.dao3.fun/`
> 完整路线图见 [pickscribe-open-api-v1.md](./pickscribe-open-api-v1.md)

## 1. 接入方式

第三方扩展在站点页面的隔离世界 content script 中，通过 `window.postMessage` 与 PickScribe 通信。

- v1.0 采用 L1 信任模型：只校验同源、消息来源与 `source`，不做配对和签名。
- 页面脚本也能看到这些消息，因此不要用它传输任何秘密。
- PickScribe 的扩展 ID 可在「设置 → 开放接口 → 联动状态」复制；v1.1 会用这个 ID 做 runtime 配对。

## 2. 统一信封

请求：

```json
{
  "source": "pickcat-client",
  "v": 1,
  "id": "req-1759999999999",
  "action": "ai.open",
  "payload": { "mode": "writer", "prompt": "帮我整理成大纲" },
  "ts": 1759999999999,
  "client": { "id": "abcdefghijklmnop", "name": "我的扩展", "version": "1.2.0" }
}
```

ACK：

```json
{
  "source": "pickscribe",
  "v": 1,
  "id": "ack-req-1759999999999",
  "action": "ack",
  "payload": {
    "replyTo": "req-1759999999999",
    "ok": true,
    "code": "OK",
    "message": "",
    "data": { "opened": true, "mode": "writer" },
    "duplicate": false
  },
  "ts": 1759999999999
}
```

约定：

- `source`：`pickcat-client`（新接入）或 `pickcat-plus`（旧联动）。
- `v`：固定 `1`。
- `id`：调用方生成，1–128 字符；同一次重试必须复用同一个 id。
- `ts`：毫秒时间戳，允许 ±60 秒偏差。
- `payload`：对象，整条消息不超过 64KB。
- `client`：可选，请求方自述身份。`id` 建议使用扩展 ID，`name` 为展示名；缺少时确认弹窗会显示「未提供名称或 ID」。L1 阶段该字段可被页面脚本伪造，仅用于知情确认。
- 所有动作都必须回 ACK；`payload.replyTo` 对应请求 `id`。
- 数据动作若由用户选择「仅本次允许」放行，ACK 会带 `payload.once: true`（`code` 仍为 `OK`）。这表示本次没有写入长期授权，下次同样请求会重新弹窗；调用方不应把它当作长期授权。
- 事件/广播使用 `action: "hello"`，不带 `replyTo`，无需 ACK。

## 3. 探测与状态

### ping

```js
window.postMessage({
  source: 'pickcat-client', v: 1,
  id: 'ping-1', action: 'ping', payload: {}, ts: Date.now()
}, location.origin);
```

ACK 的 `data` 即能力声明：

```json
{
  "version": "3.10.0",
  "protocol": { "v": 1, "min": 1, "max": 1 },
  "auth": { "mode": "l1", "pairing": false },
  "page": { "type": "editor", "href": "...", "postId": "" },
  "actions": ["ai.open", "post.open", "post.context", "editor.read"],
  "perms": {
    "readPost": true,
    "readEditor": true,
    "writeEditor": false,
    "aiQuota": false
  },
  "features": ["ai", "editor", "overlay"],
  "limits": { "actionsPerMinute": 30 },
  "editor": { "available": true, "mode": "rich" },
  "overlay": { "open": false, "enabled": true }
}
```

`state` 的返回与 `ping` 相同。PickScribe 也会在加载、SPA 路由变化、设置变更时主动广播 `action: "hello"`，`payload` 同上。

## 4. 动作

### ai.open

| 项 | 内容 |
| --- | --- |
| 页面 | 编辑页 |
| 参数 | `{ "mode": "writer" \| "format", "prompt": "可选" }` |
| 成功返回 | `{ "opened": true, "mode": "writer" }` |
| 失败码 | `UNSUPPORTED_CONTEXT`（非编辑页）、`AI_DISABLED`（AI 总开关关闭）、`AI_DISABLED_FEATURE`（对应分项关闭）、`INTERNAL` |

`prompt` 仅对 `mode: "writer"` 生效，最长 4000 字符，会预填到写作助手输入框。AI 总开关关闭时不会打开面板，也不会发模型请求，固定返回 `AI_DISABLED`；`mode` 对应的「AI 排版 / AI 写作助手」分项关闭时返回 `AI_DISABLED_FEATURE`。

### post.open

| 项 | 内容 |
| --- | --- |
| 页面 | 仅首页 / 站点信息流（`/`、`/forum`、`/forum/category/*`） |
| 参数 | `{ "postId": "帖子 id" }` |
| 成功返回 | `{ "opened": true, "postId": "..." }` |
| 失败码 | `BAD_REQUEST`（缺 id）、`UNSUPPORTED_CONTEXT`（详情页 / 搜索页 / 个人主页等）、`OVERLAY_DISABLED` |

非信息流页会静默失败：只回 ACK，不会弹提示。当前信息流里找不到对应卡片时，浮层仍会从视口中央打开。

### post.context

| 项 | 内容 |
| --- | --- |
| 页面 | 任意允许的站点页面；省略 `postId` 时取当前详情页或浮层打开的帖子 |
| 参数 | `{ "postId": "可选", "fields": ["可选，字段白名单"] }` |
| 成功返回 | `{ "id": "...", "title": "...", "author": { "id": "...", "username": "..." }, "createdAt": "...", "replyCount": 12, "url": "...", "body": "Markdown", "bodyLength": 1234, "bodyTruncated": false, "floor": 1 }` |
| 失败码 | `BAD_REQUEST`、`UNSUPPORTED_CONTEXT`（当前没有可读取的帖子）、`NOT_FOUND`、`PERMISSION_DISABLED`、`DENIED`、`CONSENT_TIMEOUT`、`INTERNAL` |

- `fields` 只接受 `id` / `title` / `author` / `createdAt` / `replyCount` / `url` / `body`，未知字段会被忽略；不传时返回全部。
- `id` 始终返回。`author` 只含 `id` 与 `username`，不返回头像、徽章等站内装饰字段。
- `body` 是正文 HTML 转成的 Markdown，上限 100000 字符；超出时 `bodyTruncated: true`，`bodyLength` 仍是完整长度。
- 首次调用会走「全局开关 → 逐扩展授权」，任一步不过都不会返回正文。

### editor.read

| 项 | 内容 |
| --- | --- |
| 页面 | 编辑页 |
| 参数 | `{ "format": "markdown" \| "text" }`，可省略，默认 `markdown` |
| 成功返回 | `{ "format": "markdown", "mode": "rich", "content": "...", "revision": "a1b2c3d4e5f60718", "length": 1234, "truncated": false, "isEmpty": false, "dirty": true }` |
| 失败码 | `UNSUPPORTED_CONTEXT`（非编辑页）、`NOT_READY`（编辑器尚未挂载）、`PERMISSION_DISABLED`、`DENIED`、`CONSENT_TIMEOUT`、`INTERNAL` |

- `content` 上限 100000 字符，超出时 `truncated: true`，`length` 仍是完整长度。
- `mode` 为当前视图：`rich` / `split` / `source`；插件未挂载时会降级读取站点原始 textarea，此时为 `source`。
- `revision` 是完整内容的摘要，后续 `editor.write` 用它做冲突校验。
- `dirty` 表示当前内容是否与编辑器挂载时的快照不同（不是与服务器已保存版本比较）。

## 5. 首次访问确认

需要读取数据或消耗 AI 额度的动作（`post.context`、`editor.read`、`editor.write`、`post.summarize`）第一次被某个扩展请求时，PickScribe 会在当前页面弹确认窗：

- 展示请求方自述的名称与扩展 ID、本次动作、请求的权限项；
- 弹窗提供三个结果：
  - 「长期允许」：按「扩展 + 权限项」写入 `pcr_api_grants`，后续同一扩展的这些权限直接放行；
  - 「仅本次允许」：只放行当前这一条请求，不写 `pcr_api_grants`、不创建客户端记录，设置页「已授权扩展」里不会出现；下次同一权限项再请求会重新弹窗，且并发 / 重放的同一条请求只会消耗这一次放行；
  - 「拒绝」：记录拒绝状态，后续请求直接回 `DENIED`，不再反复弹窗；
- 确认期间请求保持 pending，不会提前回成功；用户关闭窗口返回 `CONSENT_TIMEOUT`，60 秒未操作同样按超时返回；
- 设置页「开放接口 → 已授权扩展」可逐项撤销或整条删除；撤销后下次请求重新弹窗。

授权记录预留了 `identity` 结构（`mode` / `extensionId` / `name` / `version` / `pairingId`）。v1.0 只有 `mode: "l1"` 的自述身份；v1.1 配对完成后写入 `pairingId`，记录结构不变。

> 当前已实现 `post.context` / `editor.read`，两者第一次被请求时会触发确认弹窗；`editor.write` / `post.summarize` 尚未实现，会返回 `UNSUPPORTED`。

## 6. 错误码

| code | 含义 |
| --- | --- |
| `OK` | 成功 |
| `BAD_REQUEST` | 信封 / 参数不合法、时间戳过期、体积超限 |
| `UNSUPPORTED` | 未知 action，或该能力尚未在 v1.0 实现 |
| `UNAUTHORIZED` | source 不在白名单，或不在允许的站点页面 |
| `UNSUPPORTED_CONTEXT` | 当前页面不支持该动作 |
| `NOT_READY` | 内容脚本 / 后台尚未就绪 |
| `TIMEOUT` | 内容脚本未在时限内响应（普通动作 1.5 秒，需读接口的数据动作 15 秒） |
| `RATE_LIMITED` | 超过每标签页 30 次/分钟，`payload.retryAfter` 为建议等待秒数 |
| `OVERLAY_DISABLED` | 用户关闭了浮窗模式 |
| `PERMISSION_DISABLED` | 用户已在设置页关闭对应的全局能力开关 |
| `AI_DISABLED` | 用户已在设置页关闭「AI 功能」总开关；不会打开 AI 面板或发模型请求 |
| `AI_DISABLED_FEATURE` | AI 总开关开启，但 `ai.open` 对应的分项（排版 / 写作助手）被关闭 |
| `DENIED` | 用户拒绝过该扩展的对应权限；需到设置页撤销拒绝记录 |
| `CONSENT_TIMEOUT` | 确认弹窗被关闭，或等待用户确认超时 |
| `NOT_FOUND` | 指定帖子不存在或已被删除 |
| `INTERNAL` | 未预期异常 |

## 7. 超时与重试

- 发现：建议 300ms 超时，按 0 / 500 / 1500 / 4000 / 8000ms 重试。
- 动作：建议 3000ms 超时。`ai.open`、`post.open` 可安全重试，但必须复用同一个 `id`。
- `post.context` / `editor.read` 首次调用要先等用户确认，ACK 最长 65 秒；确认后 `editor.read` 通常 <1 秒，`post.context` 需要读接口，最多 15 秒。
- 需要首次确认的数据动作，确认未决时不要重复发起，复用同一个 `id` 重试即可命中后台去重或复用同一次确认。
- 后台会缓存最近 200 个 `tabId + action + id` 的结果 120 秒；重复请求返回同一 ACK，并带 `duplicate: true`。
- 收到 `RATE_LIMITED` 时按 `retryAfter` 等待，不要立即重试。

## 8. 权限开关

设置页「开放接口 → 能力权限」提供四个独立开关：

| 开关 | 默认 | 用途 |
| --- | --- | --- |
| 读正文 | 开 | `post.context`（已实现） |
| 读编辑器 | 开 | `editor.read`（已实现） |
| 写编辑器 | 关 | `editor.write`（未实现） |
| 消耗 AI 额度 | 关 | `post.summarize`（未实现） |

`ai.open` / `post.open` 属于用户可见的 UI 动作，不受这四项限制；数据与 AI 动作会先检查「全局开关」，再检查「逐扩展授权」，任一不过即回 `PERMISSION_DISABLED` / `DENIED`。

## 9. 自检

在站点页面控制台粘贴 [selftest.js](./api/selftest.js)，或使用设置页「复制自检命令」。

自检会：

1. 发 `ping` / `state`，打印版本、协议、页面、可用动作和四项权限。
2. 暴露 `window.pcrTest`：
   - `await pcrTest.aiOpen('整理成大纲')`
   - `await pcrTest.postOpen('帖子ID')`
   - `await pcrTest.readPost()` / `readEditor()`（v1.0 预期 `UNSUPPORTED`）
   - `writeEditor()` / `summarize()` 有副作用，默认不自动执行。

设置页「联动状态」会显示内容脚本是否就绪、当前页面、协议版本、可用动作、能力开关与扩展 ID。

## 10. 设置入口

除扩展图标与右键菜单外，站点头像菜单里也提供「PickScribe 设置」：

- 菜单由站点动态渲染，入口在每次菜单出现时按当前结构重新插入；
- 同一菜单里最多一条，不会重复；
- 菜单结构变化、找不到锚点时静默跳过，不影响站点本身；
- 点击复用 background 的 `open-options` 消息打开扩展设置页。

## 11. 兼容性

- 旧 `source: 'pickcat-plus'` 路径保持不变：
  - `pickcat:link-ping` → `pickscribe:hello`
  - `pickcat:open-ai` → 打开写作助手
- 新旧消息可以并存；新消息带 `v` / `action`，旧消息带 `type`，互不干扰。
- v1.0 的 `actions` / `features` 只增不改；未知 action 返回 `UNSUPPORTED`，不会抛异常。
- v1.1 会在 background 的 `apiAuthorize` 接入 runtime 配对 + HMAC，信封保持不变。
