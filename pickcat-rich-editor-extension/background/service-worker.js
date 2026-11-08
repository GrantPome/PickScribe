/**
 * Background Service Worker：AI 总结的消息中枢。
 * 职责：接收内容脚本的 Port 请求 → 查缓存 → 调用 LLM（流式）→ 增量回传 → 写缓存。
 * 网络请求放在这里，可绕开页面 CSP / CORS，并集中管理 API Key。
 */
import { streamChat, chat, LLMError, estimateMessagesTokens, estimateTokens } from './llm-client.js';
import { getConfig, getCached, putCached, recordUsage } from '../shared/storage.js';
import { sendTestNotification } from './notifications.js';
import { GUIDE_VERSION, GUIDE_KEYS, getProvider } from '../shared/constants.js';

// 新手引导：首次安装写入初始状态；升级时只补未看过的步骤，不整段重播。
// 具体播放时机由内容脚本 guide/guide.js 决定（等欢迎卡关闭 + 浮层落定）。
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(GUIDE_KEYS.state, (raw) => {
    const saved = raw && raw[GUIDE_KEYS.state];

    if (details.reason === 'install') {
      if (!saved) {
        chrome.storage.local.set({
          [GUIDE_KEYS.state]: {
            v: GUIDE_VERSION,
            state: 'pending',
            done: [],
            welcomeDone: false,
            skipped: false,
            skippedAt: 0,
            replay: false,
            updatedAt: Date.now()
          }
        });
      }
      return;
    }

    if (details.reason === 'update' && saved && Number(saved.v) < GUIDE_VERSION) {
      chrome.storage.local.set({
        [GUIDE_KEYS.state]: Object.assign({}, saved, {
          v: GUIDE_VERSION,
          skipped: false,
          state: saved.state === 'done' || saved.state === 'skipped' ? 'waiting' : saved.state,
          updatedAt: Date.now()
        })
      });
    }
  });
});

/** 各连接的进行中请求：port → Map(requestId → AbortController) */
const inflight = new WeakMap();

/** 用量统计串行写入，避免并发请求互相覆盖 */
let usageQueue = Promise.resolve();
function queueUsage(usage, model) {
  if (!usage) return;
  usageQueue = usageQueue.then(() => recordUsage(usage, model)).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pcai') return;

  const controllers = new Map();
  inflight.set(port, controllers);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'start') return handleStart(port, controllers, msg);
    if (msg.type === 'abort') {
      const c = controllers.get(msg.id);
      if (c) c.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    // 内容页进入 bfcache 时端口会被强制关闭，读取 lastError 避免未处理错误
    void chrome.runtime.lastError;
    controllers.forEach((c) => c.abort());
    controllers.clear();
  });
});

/** 处理一次总结请求 */
async function handleStart(port, controllers, msg) {
  const { id, cacheKey, messages, bypass, maxTokens } = msg;
  if (!id || !Array.isArray(messages) || !messages.length) {
    return safePost(port, { type: 'error', id, code: 'bad_request', message: '请求内容为空' });
  }

  const config = await getConfig();

  // AI 总开关关闭：直接返回明确错误，既不读缓存也不发请求
  if (config.aiEnabled === false) {
    return safePost(port, { type: 'error', id, code: 'AI_DISABLED', message: 'AI 功能已在设置中关闭' });
  }

  // 1) 命中缓存直接返回（「重新总结」时 bypass 绕过）
  if (cacheKey && !bypass) {
    const hit = await getCached(cacheKey);
    if (hit && hit.text) {
      return safePost(port, { type: 'done', id, text: hit.text, cached: true, usage: hit.usage || null });
    }
  }

  // 2) 调模型
  const controller = new AbortController();
  controllers.set(id, controller);

  const baseUrl = (config.baseUrl || '').trim() || defaultBaseUrl(config.provider);

  let full = '';
  let reportedUsage = null;   // 服务商在流末尾返回的真实用量
  try {
    for await (const piece of streamChat({
      baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      temperature: config.temperature,
      // 单次请求可覆盖输出上限（AI 排版需要按正文长度动态放宽），默认仍走设置里的值
      maxTokens: Number.isFinite(maxTokens) ? Math.max(128, Math.min(8192, maxTokens)) : config.maxTokens,
      signal: controller.signal,
      onUsage: (u) => { reportedUsage = u; }
    })) {
      full += piece;
      if (config.stream) safePost(port, { type: 'chunk', id, delta: piece });
    }

    if (!full.trim()) {
      throw new LLMError('模型返回了空内容，请检查模型名是否正确', 'empty_response');
    }

    // 服务商未返回 usage 时，按字符估算并在前端标注「≈」
    const usage = reportedUsage
      ? { ...reportedUsage, estimated: false }
      : (() => {
          const prompt = estimateMessagesTokens(messages);
          const completion = estimateTokens(full);
          return { prompt, completion, total: prompt + completion, estimated: true };
        })();

    if (cacheKey) await putCached(cacheKey, { text: full, model: config.model, usage });
    queueUsage(usage, config.model);
    safePost(port, { type: 'done', id, text: full, cached: false, usage });
  } catch (e) {
    const err = e instanceof LLMError ? e : new LLMError(e && e.message ? e.message : '未知错误', 'unknown');
    if (err.code !== 'aborted') safePost(port, { type: 'error', id, code: err.code, message: err.message });
  } finally {
    controllers.delete(id);
  }
}

/** 取预设服务商的默认 Base URL（内容脚本/选项页传入的 baseUrl 优先） */
function defaultBaseUrl(providerId) {
  const map = {
    deepseek: 'https://api.deepseek.com/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    moonshot: 'https://api.moonshot.cn/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    siliconflow: 'https://api.siliconflow.cn/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    ollama: 'http://localhost:11434/v1'
  };
  return map[providerId] || '';
}

/** Port 可能已断开，发送失败时静默忽略 */
function safePost(port, payload) {
  try {
    port.postMessage(payload);
  } catch (_) {
    /* 连接已关闭，忽略 */
  }
}

// ============================ 开放接口 v1.0 broker ============================
// 信任模型：L1。content script 已校验 ev.origin / ev.source / source 字段；
// 这里再校验来源白名单、页面域名、动作白名单、时间戳、限流与 requestId 去重。
// v1.1 的 runtime 配对 + HMAC 验签在 apiAuthorize 中接入，调用方协议不变。

const API_VERSION = 1;
const API_SOURCES = new Set(['pickcat-client', 'pickcat-plus']);
const API_ACTIONS = new Set(['ai.open', 'post.open', 'post.context', 'editor.read', 'editor.write', 'post.summarize']);
const API_RATE_LIMIT = 30;                 // 每 tab 每分钟最多 30 次动作请求
const API_RATE_WINDOW = 60 * 1000;
const API_TS_WINDOW = 60 * 1000;           // 信封时间戳允许的偏差
const API_DEDUPE_TTL = 120 * 1000;         // 同一 requestId 的结果缓存时长
const API_DISPATCH_TIMEOUT = 1500;         // 等内容脚本响应的上限
const API_DISPATCH_TIMEOUT_SLOW = 15000;   // 需要读接口的数据动作
const API_DISPATCH_TIMEOUT_LONG = 90000;   // 需要调用模型的耗时动作
const API_DISPATCH_SLOW_ACTIONS = new Set(['post.context']);
const API_DISPATCH_LONG_ACTIONS = new Set(['post.summarize']);
const API_MAX_PAYLOAD = 64 * 1024;         // 信封大小上限，避免页面脚本灌大消息
const API_HOSTS = new Set(['pickcat.dao3.fun', 'cdsq.dao3.fun']);

// 首次访问确认：授权记录按「请求方 + 权限项」保存。
// L1 阶段只能采信请求方自述的身份，因此 identity 里预留 pairingId，
// v1.1 配对成功后可把真实扩展身份绑定进来，记录结构不用改。
const API_CONSENT_KEY = 'pcr_api_grants';
const API_CONSENT_WAIT = 60 * 1000;        // 等待用户点确认的上限
const API_CONSENT_GRACE = 5000;            // 内容脚本自身超时后的后台兜底
const API_CONSENT_PERMS = {
  readPost: { label: '读取帖子正文', desc: '读取当前帖子的标题、作者与正文内容。' },
  readEditor: { label: '读取编辑器内容', desc: '读取编辑器里的 Markdown 正文。' },
  writeEditor: { label: '写入编辑器', desc: '替换或插入编辑器里的内容。' },
  aiQuota: { label: '消耗 AI 额度', desc: '使用你的 API Key 发起一次 AI 请求。' }
};
// 数据动作 -> 需要的权限；v1.0 的 UI 动作不在表内，数据动作接入后自动走确认流程
const API_CONSENT_ACTIONS = {
  'post.context': ['readPost'],
  'editor.read': ['readEditor'],
  'editor.write': ['writeEditor'],
  'post.summarize': ['aiQuota']
};
const API_ACTION_LABELS = {
  'post.context': '读取当前帖子',
  'editor.read': '读取编辑器内容',
  'editor.write': '写入编辑器',
  'post.summarize': '生成 AI 总结'
};

// 全局权限开关：数据动作必须先过这里，再过逐扩展授权。
// 存储键与设置页保持一致（options/options.js 的 API_PERMS_KEY），不新增键。
const API_PERMS_KEY = 'pcr_api_perms';
const API_PERMS_DEFAULT = { readPost: true, readEditor: true, writeEditor: false, aiQuota: false };
const API_PERM_LABELS = {
  readPost: '读取帖子正文',
  readEditor: '读取编辑器内容',
  writeEditor: '写入编辑器',
  aiQuota: '消耗 AI 额度'
};
const API_PERMISSION_ACTIONS = {
  'post.context': 'readPost',
  'editor.read': 'readEditor',
  'editor.write': 'writeEditor',
  'post.summarize': 'aiQuota'
};

const apiRate = new Map();      // tabId -> { start, count }
const apiReplies = new Map();   // `${tabId}:${action}:${requestId}` -> { at, res }
const apiInflight = new Map();  // `${tabId}:${action}:${requestId}` -> Promise<res>
const apiConsentInflight = new Map();  // 同一 tab + 扩展 + 权限的并发确认合并为一次

function apiHostAllowed(url) {
  try { return API_HOSTS.has(new URL(url).hostname); } catch (e) { return false; }
}

/** 统一内容脚本返回值，避免 undefined 字段泄漏到 ACK */
function apiNormalize(res) {
  if (!res || typeof res !== 'object') {
    return { ok: false, code: 'INTERNAL', message: '内容脚本返回为空' };
  }
  return {
    ok: !!res.ok,
    code: res.code || (res.ok ? 'OK' : 'INTERNAL'),
    message: res.message || '',
    data: res.data === undefined ? null : res.data
  };
}

/** v1.0 只做 L1；v1.1 在这里加配对票据 / HMAC 验签，不要改外层信封 */
function apiAuthorize(req, sender) {
  if (!req || typeof req !== 'object') {
    return { ok: false, code: 'BAD_REQUEST', message: '缺少请求体' };
  }
  if (req.v !== API_VERSION) {
    return { ok: false, code: 'UNSUPPORTED', message: '仅支持协议 v1' };
  }
  if (!API_SOURCES.has(req.source)) {
    return { ok: false, code: 'UNAUTHORIZED', message: '来源未授权' };
  }
  if (typeof req.id !== 'string' || !req.id || req.id.length > 128) {
    return { ok: false, code: 'BAD_REQUEST', message: '请求 id 不合法' };
  }
  if (typeof req.action !== 'string' || !API_ACTIONS.has(req.action)) {
    return { ok: false, code: 'UNSUPPORTED', message: '动作未实现' };
  }
  if (typeof req.ts !== 'number' || Math.abs(Date.now() - req.ts) > API_TS_WINDOW) {
    return { ok: false, code: 'BAD_REQUEST', message: '请求时间戳过期' };
  }
  if (req.payload != null && typeof req.payload !== 'object') {
    return { ok: false, code: 'BAD_REQUEST', message: 'payload 必须是对象' };
  }
  let size = 0;
  try { size = JSON.stringify(req).length; } catch (e) {
    return { ok: false, code: 'BAD_REQUEST', message: '请求无法序列化' };
  }
  if (size > API_MAX_PAYLOAD) {
    return { ok: false, code: 'BAD_REQUEST', message: '请求体过大' };
  }
  // sender.url 在 content script 场景下就是页面地址；tab.url 作为兜底。
  // 只允许 Pickcat 两个站点，避免被其他页面注入的脚本借用。
  const pageUrl = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number' || !apiHostAllowed(pageUrl)) {
    return { ok: false, code: 'UNAUTHORIZED', message: '仅允许在 Pickcat 站点页面调用' };
  }
  // ai.open / post.open 属于用户可见的 UI 动作，不读取正文、不写编辑器、不消耗 AI 额度；
  // post.context / editor.read / editor.write / post.summarize 另行检查全局开关与逐扩展授权。
  return { ok: true };
}

/** 简单固定窗口限流：页面脚本可以高频 postMessage，但只能在额度内拿到 ACK */
function apiCheckRate(tabId) {
  const now = Date.now();
  let slot = apiRate.get(tabId);
  if (!slot || now - slot.start >= API_RATE_WINDOW) {
    slot = { start: now, count: 0 };
    apiRate.set(tabId, slot);
  }
  slot.count += 1;
  if (slot.count > API_RATE_LIMIT) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      retryAfter: Math.max(1, Math.ceil((slot.start + API_RATE_WINDOW - now) / 1000))
    };
  }
  return null;
}

// ---------------------------- 首次访问确认 ----------------------------

/** 请求方身份：L1 只能采信自述信息；v1.1 配对后把真实身份写进 pairingId */
function apiClientOf(req) {
  const raw = req && req.client && typeof req.client === 'object' ? req.client : {};
  const pick = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let extensionId = pick(raw.id, 128);
  let name = pick(raw.name, 128);
  const version = pick(raw.version, 64);
  if (!extensionId && req.source === 'pickcat-plus') extensionId = 'pickcat-plus';
  if (!name && extensionId === 'pickcat-plus') name = 'PICKCAT Plus';
  if (!name) name = extensionId;
  const keyPart = extensionId || name || 'anonymous';
  return {
    key: (req.source || 'unknown') + ':' + keyPart,
    identity: {
      mode: 'l1',
      source: req.source || '',
      extensionId,
      name,
      version,
      pairingId: ''          // v1.1：配对成功后写入，用于绑定真实扩展身份
    }
  };
}

function apiGrantsDefault() {
  return { v: 1, clients: {} };
}

function apiReadGrants() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [API_CONSENT_KEY]: apiGrantsDefault() }, (raw) => {
        const g = raw && raw[API_CONSENT_KEY];
        if (!g || typeof g !== 'object' || !g.clients || typeof g.clients !== 'object') {
          resolve(apiGrantsDefault());
          return;
        }
        resolve(g);
      });
    } catch (e) {
      resolve(apiGrantsDefault());
    }
  });
}

function apiWriteGrants(grants) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [API_CONSENT_KEY]: grants }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

// 串行化读改写，避免两个并发确认互相覆盖
let apiGrantsChain = Promise.resolve();
function apiUpdateGrants(mutator) {
  const run = () => apiReadGrants().then((g) => {
    mutator(g);
    g.updatedAt = Date.now();
    return apiWriteGrants(g).then(() => g);
  });
  apiGrantsChain = apiGrantsChain.then(run, run);
  return apiGrantsChain;
}

function apiEnsureClientRecord(grants, client, action) {
  if (!grants.clients) grants.clients = {};
  let rec = grants.clients[client.key];
  const now = Date.now();
  if (!rec || typeof rec !== 'object') {
    rec = grants.clients[client.key] = {
      identity: client.identity,
      firstSeenAt: now,
      lastSeenAt: now,
      perms: {}
    };
  }
  rec.identity = Object.assign({}, rec.identity || {}, client.identity);
  rec.lastSeenAt = now;
  rec.lastAction = action || '';
  if (!rec.perms || typeof rec.perms !== 'object') rec.perms = {};
  return rec;
}

function apiConsentState(grants, clientKey, perms) {
  const rec = grants.clients && grants.clients[clientKey];
  const state = { denied: [], missing: [] };
  perms.forEach((perm) => {
    const st = rec && rec.perms && rec.perms[perm] && rec.perms[perm].state;
    if (st === 'granted') return;
    if (st === 'denied') state.denied.push(perm);
    else state.missing.push(perm);
  });
  return state;
}

function apiConsentLabel(perms) {
  return perms.map((p) => (API_CONSENT_PERMS[p] && API_CONSENT_PERMS[p].label) || p).join('、');
}

/**
 * 编辑器只读探测：replace 前要在确认弹窗里展示「将被替换的字符数」，
 * 同时提前拦掉非编辑页 / 未挂载 / 只读，避免弹出一个注定失败的确认窗。
 * 这是扩展内部消息，不经过页面，也不产生任何写入。
 */
function apiProbeEditor(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res && typeof res === 'object' ? res : null);
    };
    const timer = setTimeout(() => finish(null), 1500);
    try {
      chrome.tabs.sendMessage(tabId, { __pcr_editor_probe: true }, (res) => {
        if (chrome.runtime.lastError) { finish(null); return; }
        finish(res);
      });
    } catch (e) {
      finish(null);
    }
  });
}

/** 让页面里的内容脚本弹确认窗；页面没就绪时明确返回 NOT_READY，不挂死调用方 */
function apiAskPageConsent(tabId, req, client, perms, detail) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res && typeof res === 'object' ? res : { decision: 'error' });
    };
    const timer = setTimeout(
      () => finish({ decision: 'error', reason: '确认窗口响应超时' }),
      API_CONSENT_WAIT + API_CONSENT_GRACE
    );
    try {
      chrome.tabs.sendMessage(tabId, {
        __pcr_consent_request: true,
        client: client.identity,
        action: req.action,
        actionLabel: API_ACTION_LABELS[req.action] || req.action,
        perms: perms.map((p) => ({
          key: p,
          label: (API_CONSENT_PERMS[p] && API_CONSENT_PERMS[p].label) || p,
          desc: (API_CONSENT_PERMS[p] && API_CONSENT_PERMS[p].desc) || ''
        })),
        // 本次写入 / 总结的具体影响，供弹窗展示（不做静默覆盖）
        detail: detail || null,
        timeout: API_CONSENT_WAIT
      }, (res) => {
        if (chrome.runtime.lastError) {
          finish({ decision: 'error', reason: chrome.runtime.lastError.message || '内容脚本未就绪' });
          return;
        }
        finish(res);
      });
    } catch (e) {
      finish({ decision: 'error', reason: String((e && e.message) || e) });
    }
  });
}

/** 读取四项全局能力开关；缺省值与设置页一致 */
function apiReadPerms() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ [API_PERMS_KEY]: API_PERMS_DEFAULT }, (raw) => {
        const saved = raw && raw[API_PERMS_KEY];
        resolve(Object.assign({}, API_PERMS_DEFAULT, saved && typeof saved === 'object' ? saved : {}));
      });
    } catch (e) {
      resolve(Object.assign({}, API_PERMS_DEFAULT));
    }
  });
}

/**
 * 全局权限开关先于逐扩展授权：
 * 用户在设置页关掉某能力后，即使之前给过该扩展授权，也不再放行。
 */
async function apiEnsureGlobalPermission(req) {
  const perm = API_PERMISSION_ACTIONS[req.action];
  if (!perm) return { ok: true };
  const perms = await apiReadPerms();
  if (perms[perm]) return { ok: true };
  return {
    ok: false,
    code: 'PERMISSION_DISABLED',
    message: '用户已在设置中关闭「' + (API_PERM_LABELS[perm] || perm) + '」权限'
  };
}

/**
 * 检查某个动作需要的权限：
 * - 全部已授权：直接放行；
 * - 有已拒绝项：明确回 DENIED，不再弹窗；
 * - 有缺失项：在页面弹确认窗，等待用户决定（请求保持 pending）。
 */
async function apiEnsureConsent(tabId, req) {
  const perms = API_CONSENT_ACTIONS[req.action];
  if (!perms || !perms.length) return { ok: true, skipped: true };

  const client = apiClientOf(req);
  const grants = await apiReadGrants();
  const state = apiConsentState(grants, client.key, perms);
  if (!state.denied.length && !state.missing.length) return { ok: true };
  if (state.denied.length) {
    return {
      ok: false,
      code: 'DENIED',
      message: '用户已拒绝该扩展的' + apiConsentLabel(state.denied) + '权限'
    };
  }

  const missing = state.missing.slice().sort();
  // 「仅本次允许」只对一条请求生效：inflight 按 requestId 区分，
  // 避免并发请求共用同一次放行；同一 requestId 的重放仍合并为一次确认。
  const inflightKey = tabId + ':' + req.action + ':' + req.id + ':' + client.key + ':' + missing.join(',');
  const running = apiConsentInflight.get(inflightKey);
  if (running) return running;

  // 确认窗前拿到本次动作的实际影响：replace 的字符数、insert 的长度、是否会用模型。
  let detail = null;
  if (req.action === 'editor.write') {
    const p = req.payload && typeof req.payload === 'object' ? req.payload : {};
    const writeMode = p.mode === 'replace' ? 'replace' : 'insert';
    detail = {
      mode: writeMode,
      textLength: typeof p.text === 'string' ? p.text.length : 0
    };
    // 编辑器不可用时直接返回明确错误，不弹一个注定失败的确认窗。
    const probe = await apiProbeEditor(tabId);
    if (probe && probe.ok === false) {
      return { ok: false, code: probe.code || 'NOT_READY', message: probe.message || '编辑器不可用' };
    }
    if (probe && writeMode === 'replace' && typeof probe.length === 'number') {
      detail.replaceChars = probe.length;
    }
  } else if (req.action === 'post.summarize') {
    detail = { usesModel: true };
  }

  const task = apiAskPageConsent(tabId, req, client, missing, detail)
    .then(async (res) => {
      const decision = res && res.decision;
      if (decision === 'allow') {
        await apiUpdateGrants((g) => {
          const rec = apiEnsureClientRecord(g, client, req.action);
          const now = Date.now();
          missing.forEach((perm) => {
            rec.perms[perm] = { state: 'granted', at: now, action: req.action };
          });
        });
        return { ok: true, granted: missing.slice() };
      }
      if (decision === 'deny') {
        await apiUpdateGrants((g) => {
          const rec = apiEnsureClientRecord(g, client, req.action);
          const now = Date.now();
          missing.forEach((perm) => {
            rec.perms[perm] = { state: 'denied', at: now, action: req.action };
          });
        });
        return { ok: false, code: 'DENIED', message: '用户拒绝了本次访问' };
      }
      if (decision === 'once') {
        // 单次放行：不写 pcr_api_grants、不创建客户端记录，
        // 只对当前这条请求有效，下次同一权限仍会重新弹窗。
        return { ok: true, code: 'OK', message: '已按本次允许放行', once: true };
      }
      if (decision === 'close') {
        return { ok: false, code: 'CONSENT_TIMEOUT', message: '用户关闭了确认窗口' };
      }
      if (decision === 'timeout') {
        return { ok: false, code: 'CONSENT_TIMEOUT', message: '等待用户确认超时' };
      }
      return { ok: false, code: 'NOT_READY', message: '页面确认窗口未就绪' };
    })
    .catch((e) => ({
      ok: false,
      code: 'INTERNAL',
      message: String((e && e.message) || e)
    }))
    .then((result) => {
      apiConsentInflight.delete(inflightKey);
      return result;
    });

  apiConsentInflight.set(inflightKey, task);
  return task;
}

/** 把动作转发给同 tab 的内容脚本；未就绪时 200ms 后重试一次（open 类动作幂等） */
function apiDispatch(tabId, action, payload, requestId) {
  const waitMs = API_DISPATCH_LONG_ACTIONS.has(action) ? API_DISPATCH_TIMEOUT_LONG
    : (API_DISPATCH_SLOW_ACTIONS.has(action) ? API_DISPATCH_TIMEOUT_SLOW : API_DISPATCH_TIMEOUT);
  const send = () => new Promise((resolve) => {
    let settled = false;
    const finish = (res) => { if (settled) return; settled = true; resolve(apiNormalize(res)); };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', message: '内容脚本响应超时' }), waitMs);
    try {
      chrome.tabs.sendMessage(tabId, { __pcr_api_dispatch: true, action, payload, requestId }, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish({ ok: false, code: 'NOT_READY', message: chrome.runtime.lastError.message || '内容脚本未就绪' });
          return;
        }
        finish(res);
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, code: 'NOT_READY', message: String((e && e.message) || e) });
    }
  });

  return send().then((res) => {
    if (res.code !== 'NOT_READY') return res;
    return new Promise((r) => setTimeout(r, 200)).then(() => send());
  });
}

/**
 * 开放接口的 AI 开关检查：
 * - 总开关关闭 → AI_DISABLED
 * - 对应分项关闭（ai.open 的 format / writer，post.summarize 的总结开关）→ AI_DISABLED_FEATURE
 */
async function apiEnsureAiFeature(req) {
  if (!req || (req.action !== 'ai.open' && req.action !== 'post.summarize')) return { ok: true };
  const cfg = await getConfig();
  if (cfg.aiEnabled === false) {
    return { ok: false, code: 'AI_DISABLED', message: 'AI 功能已在设置中关闭' };
  }
  if (req.action === 'post.summarize') {
    if (cfg.enabled === false) {
      return { ok: false, code: 'AI_DISABLED_FEATURE', message: '帖子总结已在设置中关闭' };
    }
    return { ok: true };
  }
  const mode = req.payload && req.payload.mode;
  const key = mode === 'format' ? 'aiFormat' : 'aiWriter';
  if (cfg[key] === false) {
    return { ok: false, code: 'AI_DISABLED_FEATURE', message: '该 AI 功能已在设置中关闭' };
  }
  return { ok: true };
}

function apiHandle(msg, sender, sendResponse) {
  const req = msg && msg.req;
  const auth = apiAuthorize(req, sender);
  if (!auth.ok) { sendResponse(auth); return; }

  const tabId = sender.tab.id;
  const limited = apiCheckRate(tabId);
  if (limited) { sendResponse(limited); return; }

  // 写编辑器只可能在编辑页生效：先按内容脚本上报的页面类型拦一次，
  // 避免在信息流 / 详情页弹出一次注定失败的「写入编辑器」确认窗。
  if (req.action === 'editor.write' && msg.page !== 'editor') {
    sendResponse({ ok: false, code: 'UNSUPPORTED_CONTEXT', message: '仅编辑页可用' });
    return;
  }

  // 全局权限开关在去重缓存之前检查：用户改完开关后重试应立即生效，
  // 而不是命中上一次的拒绝结果。
  apiEnsureGlobalPermission(req).then(async (permission) => {
    if (!permission.ok) { sendResponse(permission); return; }

    const aiGate = await apiEnsureAiFeature(req);
    if (!aiGate.ok) { sendResponse(aiGate); return; }

    // 同一 requestId 在 2 分钟内重复到达：直接复用结果，避免重试导致重复开窗
    // 带上 action，避免不同动作恰好复用同一个 id 时命中错误的缓存
    const key = tabId + ':' + req.action + ':' + req.id;
    const cached = apiReplies.get(key);
    if (cached && Date.now() - cached.at < API_DEDUPE_TTL) {
      sendResponse(Object.assign({}, cached.res, { duplicate: true }));
      return;
    }

    // 同一个 requestId 的并发重放（确认还没结束时）：共用一次确认与一次执行，
    // 避免「仅本次允许」被同一条请求重复消费。
    const flight = apiInflight.get(key);
    if (flight) {
      flight.then(
        (res) => sendResponse(Object.assign({}, res, { duplicate: true })),
        (err) => sendResponse({ ok: false, code: 'INTERNAL', message: String((err && err.message) || err) })
      );
      return;
    }

    const cacheAndReply = (res) => {
      apiReplies.set(key, { at: Date.now(), res });
      if (apiReplies.size > 200) {
        for (const [k, v] of apiReplies) {
          if (Date.now() - v.at >= API_DEDUPE_TTL) apiReplies.delete(k);
        }
        while (apiReplies.size > 200) apiReplies.delete(apiReplies.keys().next().value);
      }
      sendResponse(res);
    };

    // 再过逐扩展授权：确认期间请求保持 pending，不提前回成功。
    const task = apiEnsureConsent(tabId, req).then((consent) => {
      if (!consent.ok) return consent;
      return apiDispatch(tabId, req.action, req.payload || {}, req.id).then((res) => (
        // 「仅本次允许」的标记要带到最终 ACK，方便调用方区分长期授权
        consent.once ? Object.assign({}, res, { once: true }) : res
      ));
    });

    apiInflight.set(key, task);
    task.then((res) => {
      apiInflight.delete(key);
      cacheAndReply(res);
    }, (err) => {
      apiInflight.delete(key);
      cacheAndReply({ ok: false, code: 'INTERNAL', message: String((err && err.message) || err) });
    });
  });
}

/** 引导内「测试连接」：读设置页同一份配置，申请域名权限后发一次最小请求 */
async function handleAiTest() {
  const cfg = await getConfig();
  const preset = getProvider(cfg.provider);
  const baseUrl = String(cfg.baseUrl || preset.baseUrl || '').trim();
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || (preset.models && preset.models[0]) || '').trim();

  if (!baseUrl) return { ok: false, message: '还没有填写接口地址' };
  if (!model) return { ok: false, message: '还没有填写模型名' };
  // Ollama 与自定义（自建地址）都不要求 Key
  if (!preset.keyless && preset.id !== 'custom' && !apiKey) return { ok: false, message: '还没有填写 API Key' };

  let granted = true;
  try {
    const origin = new URL(baseUrl).origin;
    granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  } catch (e) {
    // 后台没有用户手势时授权调用会失败；不拦截，交给请求本身给出结果
    granted = true;
  }
  if (!granted) return { ok: false, needPermission: true, message: '未获得该接口域名的访问权限' };

  try {
    const text = await chat({
      baseUrl,
      apiKey,
      model,
      messages: [
        { role: 'system', content: '你是连接测试助手，只回复一句话。' },
        { role: 'user', content: '请用一句话回复：连接正常。' }
      ],
      temperature: 0.2,
      maxTokens: 64
    });
    return { ok: true, message: String(text || '').trim().slice(0, 60) || '正常' };
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    const hint = /failed to fetch|network|permission/i.test(raw)
      ? '（可在设置页点一次「测试连接」完成域名授权）'
      : '';
    return { ok: false, message: raw + hint };
  }
}

// 内容脚本 / Popup 的一次性消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 开放接口：content.js 把页面 window 消息转到后台统一鉴权 / 限流
  if (msg && msg.__pcr_api === true) {
    apiHandle(msg, sender, sendResponse);
    return true;
  }
  if (msg && msg.type === 'ai-test') {
    handleAiTest()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, message: err && err.message ? err.message : '连接失败' }));
    return true;
  }
  if (msg && msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  // 设置页「发送测试通知」：验证 chrome.notifications 与系统通知权限
  if (msg && msg.type === 'notify-test') {
    sendTestNotification();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
