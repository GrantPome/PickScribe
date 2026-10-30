/**
 * Background Service Worker：AI 总结的消息中枢。
 * 职责：接收内容脚本的 Port 请求 → 查缓存 → 调用 LLM（流式）→ 增量回传 → 写缓存。
 * 网络请求放在这里，可绕开页面 CSP / CORS，并集中管理 API Key。
 */
import { streamChat, LLMError, estimateMessagesTokens, estimateTokens } from './llm-client.js';
import { getConfig, getCached, putCached, recordUsage } from '../shared/storage.js';
import { sendTestNotification } from './notifications.js';

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
    controllers.forEach((c) => c.abort());
    controllers.clear();
  });
});

/** 处理一次总结请求 */
async function handleStart(port, controllers, msg) {
  const { id, cacheKey, messages, bypass } = msg;
  if (!id || !Array.isArray(messages) || !messages.length) {
    return safePost(port, { type: 'error', id, code: 'bad_request', message: '请求内容为空' });
  }

  const config = await getConfig();

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
      maxTokens: config.maxTokens,
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

// 内容脚本 / Popup 的一次性消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  // 起始页浮层里的「收藏工作台」入口：内容脚本不能直接打开 chrome-extension:// 页面，
  // 交给后台开新标签页。
  if (msg && msg.type === 'open-favorites') {
    chrome.tabs.create({ url: chrome.runtime.getURL('favorites/favorites.html') });
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
