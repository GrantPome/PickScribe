/**
 * 设置页逻辑：读取 / 保存配置、测试连接、缓存与配置导入导出。
 * 依赖 shared/constants.js 的预设与默认值，以及 background/llm-client.js 的请求能力。
 */
import {
  PROVIDERS, getProvider, LENGTHS, LANGS, TRIGGERS,
  DEFAULT_CONFIG, DEFAULT_USER_PROMPT, DEFAULT_SYSTEM_PROMPT,
  NOTIFY_CONFIG_KEY, NOTIFY_DEFAULTS, NOTIFY_INTERVALS
} from '../shared/constants.js';
import { getConfig, setConfig, clearCache, exportAll, importAll, getUsageStats, clearUsageStats } from '../shared/storage.js';
import { chat, estimateTokens, estimateMessagesTokens } from '../background/llm-client.js';

const $ = (id) => document.getElementById(id);

// ============================ 初始化 ============================

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}

function fillSelect(el, items, value) {
  el.innerHTML = items.map((it) => '<option value="' + it.id + '">' + it.name + '</option>').join('');
  el.value = value;
}

function initSelects() {
  fillSelect($('provider'), PROVIDERS, DEFAULT_CONFIG.provider);
  fillSelect($('lang'), LANGS, DEFAULT_CONFIG.lang);
  fillSelect($('length'), LENGTHS, DEFAULT_CONFIG.length);
  fillSelect($('trigger'), TRIGGERS, DEFAULT_CONFIG.trigger);
}

/** 切换服务商时，带出默认 Base URL 与候选模型 */
function applyProvider(id, keepBaseUrl) {
  const p = getProvider(id);
  const isCustom = id === 'custom';
  if (!keepBaseUrl) $('baseUrl').value = isCustom ? ($('baseUrl').value || '') : p.baseUrl;

  $('model-list').innerHTML = (p.models || []).map((m) => '<option value="' + m + '"></option>').join('');
  if (!keepBaseUrl && p.models && p.models.length && !$('model').value) $('model').value = p.models[0];

  $('provider-note').textContent = p.note || '';
  $('apiKey').placeholder = p.keyless ? '本地服务无需密钥' : 'sk-...';
  $('key-help').innerHTML = p.keyUrl
    ? '获取密钥：<a href="' + p.keyUrl + '" target="_blank" rel="noopener">' + p.keyUrl + '</a>'
    : (p.keyless ? '本地 Ollama 无需 API Key，但需要先在本机运行 ollama serve。' : '');
}

async function load() {
  const c = { ...DEFAULT_CONFIG, ...(await getConfig()) };
  initSelects();
  $('provider').value = c.provider;
  applyProvider(c.provider, true);
  $('baseUrl').value = c.baseUrl || getProvider(c.provider).baseUrl;
  $('apiKey').value = c.apiKey || '';
  $('model').value = c.model || '';
  $('temperature').value = c.temperature;
  $('maxTokens').value = c.maxTokens;
  $('systemPrompt').value = c.systemPrompt || '';
  $('userPrompt').value = c.userPrompt || '';
  $('lang').value = c.lang;
  $('length').value = c.length;
  $('trigger').value = c.trigger;
  $('minChars').value = c.minChars;
  $('stream').checked = !!c.stream;
  $('enabled').checked = !!c.enabled;
}

// ============================ 读写表单 ============================

function readForm() {
  return {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: Number($('temperature').value),
    maxTokens: Number($('maxTokens').value),
    systemPrompt: $('systemPrompt').value.trim(),
    userPrompt: $('userPrompt').value.trim(),
    lang: $('lang').value,
    length: $('length').value,
    trigger: $('trigger').value,
    minChars: Number($('minChars').value) || 0,
    stream: $('stream').checked,
    enabled: $('enabled').checked
  };
}

/**
 * 申请接口域名的访问权限。
 * manifest 只声明了可选权限（optional_host_permissions），
 * 首次保存 / 测试时点按钮授权，之后不再弹窗。
 * 注意：必须在用户点击的同步栈里调用，否则会丢失手势导致授权失败。
 */
function ensureOrigin(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [origin + '/*'] });
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ============================ Token 用量统计 ============================

const fmtInt = (n) => Number(n || 0).toLocaleString('zh-CN');

async function renderUsage() {
  const s = await getUsageStats();
  $('usagePrompt').textContent = fmtInt(s.prompt);
  $('usageCompletion').textContent = fmtInt(s.completion);
  $('usageTotal').textContent = fmtInt(s.total);
  $('usageCalls').textContent = fmtInt(s.calls);

  const models = Object.keys(s.models || {});
  $('usageModels').textContent = models.length
    ? '按模型：' + models.map((m) => m + ' ' + fmtInt(s.models[m].total)).join(' · ')
    : '';

  $('usageNote').textContent = s.updated
    ? '仅统计真实调用，缓存命中不计入；最近更新于 ' + new Date(s.updated).toLocaleString('zh-CN') + '。'
    : '还没有调用记录。仅统计真实调用，缓存命中不计入；服务商未返回 usage 时按字符估算。';
}

// ============================ 测试连接 ============================

function sampleMessages(c) {
  return [
    { role: 'system', content: c.systemPrompt || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: '请用一句话回复：连接正常。' }
  ];
}

// ============================ 事件绑定 ============================

$('provider').addEventListener('change', (e) => {
  applyProvider(e.target.value, false);
});

$('toggleKey').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
});

$('saveBtn').addEventListener('click', async () => {
  const values = readForm();               // 同步读取，保住用户手势
  const granted = await ensureOrigin(values.baseUrl);
  if (!granted) {
    setStatus('未获得该接口域名的访问权限，保存已取消', 'err');
    return;
  }
  if (values.apiKey === '' && values.provider !== 'ollama') {
    setStatus('已保存，但还没填 API Key，总结会失败', 'err');
  } else {
    setStatus('已保存', 'ok');
  }
  await setConfig(values);
});

$('testBtn').addEventListener('click', async () => {
  const values = readForm();
  const granted = await ensureOrigin(values.baseUrl);
  if (!granted) {
    setStatus('未获得该接口域名的访问权限', 'err');
    return;
  }
  $('testBtn').disabled = true;
  setStatus('正在测试连接…');
  try {
    let usage = null;
    const messages = sampleMessages(values);
    const text = await chat({
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
      model: values.model,
      messages,
      temperature: 0.2,
      maxTokens: 64,
      onUsage: (u) => { usage = u; }
    });
    // 服务商没返回 usage 时按字符估算，保证设置页也能看到大约的消耗
    const tokenText = usage
      ? ' · 本次 ↑' + usage.prompt + ' ↓' + usage.completion + '（共 ' + usage.total + ' Tokens）'
      : ' · 本次 ≈' + (estimateMessagesTokens(messages) + estimateTokens(text)) + ' Tokens（估算）';
    setStatus('连接成功：' + String(text).trim().slice(0, 40) + tokenText, 'ok');
  } catch (e) {
    setStatus('连接失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    $('testBtn').disabled = false;
  }
});

$('clearUsage').addEventListener('click', async () => {
  await clearUsageStats();
  await renderUsage();
  setStatus('已清空用量统计', 'ok');
});

$('clearCache').addEventListener('click', async () => {
  const n = await clearCache();
  setStatus('已清空 ' + n + ' 条缓存', 'ok');
});

$('exportBtn').addEventListener('click', async () => {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pickscribe-ai-config.json';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('已导出配置', 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await importAll(data);
    await load();
    setStatus('已导入配置', 'ok');
  } catch (err) {
    setStatus('导入失败：文件格式不正确', 'err');
  }
  e.target.value = '';
});

// ============================ 启动 ============================

load().then(renderUsage).catch((e) => setStatus('读取配置失败：' + e.message, 'err'));

// 统计随后台调用实时更新（设置页开着时也能看到数字变化）
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pcai_usage) renderUsage().catch(() => {});
  });
} catch (e) { /* 非扩展环境忽略 */ }

// 提示：用户在模板里删空了会用默认模板
$('userPrompt').placeholder = DEFAULT_USER_PROMPT;

// ============================ 起始页浮层设置（即时生效） ============================

/**
 * 起始页设置（键 pcr_home）：与 home/content.js 的定义保持同步。
 * 默认关闭，只有用户显式开启后才会在首页自动显示。
 */
const HOME_KEY = 'pcr_home';

const HOME_DEFAULTS = {
  enabled: false,
  showSearch: true,
  showClock: true,
  showFooter: true,
  defaultTab: 'feed',
  // 磁贴默认顺序：主操作「发帖」占大磁贴，返回社区放到最后
  tiles: [
    { id: 'compose', size: 'large' },
    { id: 'search', size: 'small' },
    { id: 'notifications', size: 'small' },
    { id: 'works', size: 'small' },
    { id: 'settings', size: 'small' },
    { id: 'back', size: 'small' }
  ],
  tabs: ['feed', 'nav']
};

const HOME_TILE_SIZES = ['small', 'wide', 'large'];

/** 旧版默认顺序（返回社区大磁贴在最前），用于把没改过顺序的用户平滑迁到新顺序 */
const LEGACY_TILE_ORDER = 'back:large,compose:small,search:small,notifications:small,works:small,settings:small';
const HOME_TILE_SIZE_LABELS = { small: '小', wide: '宽', large: '大' };

const HOME_TILES = {
  back: { label: '返回社区', sub: '关闭起始页，继续浏览' },
  compose: { label: '发帖', sub: '进入编辑器新建帖子' },
  search: { label: '搜索', sub: '查找帖子、用户与关键词' },
  notifications: { label: '消息', sub: '回复、点赞与系统通知' },
  works: { label: '作品', sub: '浏览作品广场' },
  library: { label: '图盘', sub: '管理上传过的图片' },
  account: { label: '账号设置', sub: '资料、头像与偏好' },
  settings: { label: '设置', sub: 'PickScribe 设置' }
};

const HOME_TABS = { feed: '社区精选', nav: '快捷导航' };

let homeCfg = null;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 磁贴归一化：接受 [{id,size}]，也兼容旧配置里的 shortcuts 字符串数组。
 * 缺省（undefined）回落到默认磁贴；显式空数组表示「不显示磁贴」。
 */
function normalizeHomeTiles(source) {
  if (!Array.isArray(source)) {
    return HOME_DEFAULTS.tiles.map((t) => ({ id: t.id, size: t.size }));
  }
  const out = [];
  source.forEach((item) => {
    const id = typeof item === 'string' ? item : (item && item.id);
    if (!id || !HOME_TILES[id] || out.some((t) => t.id === id)) return;
    const size = typeof item === 'string' ? '' : (item && item.size);
    out.push({ id: id, size: HOME_TILE_SIZES.indexOf(size) !== -1 ? size : 'small' });
  });
  return out;
}

/** 与 home/content.js 的 normalizeHome 保持一致 */
function normalizeHome(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const clean = (arr, all) => {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((id) => {
      if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id);
    });
    return out;
  };

  let tiles = normalizeHomeTiles(Array.isArray(c.tiles) ? c.tiles : c.shortcuts);
  if (tiles.map((t) => t.id + ':' + t.size).join(',') === LEGACY_TILE_ORDER) {
    tiles = HOME_DEFAULTS.tiles.map((t) => ({ id: t.id, size: t.size }));
  }
  let tabs = clean(c.tabs, Object.keys(HOME_TABS));
  if (!tabs.length) tabs = HOME_DEFAULTS.tabs.slice();

  return {
    enabled: c.enabled === true,
    showSearch: c.showSearch !== false,
    showClock: c.showClock !== false,
    showFooter: c.showFooter !== false,
    defaultTab: tabs.indexOf(c.defaultTab) !== -1 ? c.defaultTab : tabs[0],
    tiles: tiles,
    tabs: tabs
  };
}

/** 已启用的按保存顺序在前，未启用的按定义顺序排在后面 */
function renderHomeTiles() {
  const el = $('homeTileList');
  if (!el) return;

  const active = homeCfg.tiles.map((t) => t.id);
  const all = Object.keys(HOME_TILES);
  const order = active.concat(all.filter((id) => active.indexOf(id) === -1));
  const sizeOf = (id) => {
    const t = homeCfg.tiles.find((x) => x.id === id);
    return t ? t.size : 'small';
  };

  el.innerHTML = order.map((id) => {
    const on = active.indexOf(id) !== -1;
    const def = HOME_TILES[id];
    const size = sizeOf(id);
    return '<li class="home-item' + (on ? '' : ' is-off') + '" data-id="' + id + '">' +
      '<label class="home-item-main">' +
        '<input type="checkbox" data-role="toggle"' + (on ? ' checked' : '') + ' />' +
        '<span class="home-item-text">' +
          '<span class="home-item-name">' + escHtml(def.label) + '</span>' +
          '<span class="home-item-desc">' + escHtml(def.sub) + '</span>' +
        '</span>' +
      '</label>' +
      '<select class="home-item-size" data-role="size" aria-label="' + escHtml(def.label) + ' 磁贴尺寸"' + (on ? '' : ' disabled') + '>' +
        HOME_TILE_SIZES.map((s) =>
          '<option value="' + s + '"' + (s === size ? ' selected' : '') + '>' + HOME_TILE_SIZE_LABELS[s] + '</option>'
        ).join('') +
      '</select>' +
      '<span class="home-item-move">' +
        '<button type="button" class="mini" data-move="-1" title="上移" aria-label="上移 ' + escHtml(def.label) + '">↑</button>' +
        '<button type="button" class="mini" data-move="1" title="下移" aria-label="下移 ' + escHtml(def.label) + '">↓</button>' +
      '</span>' +
    '</li>';
  }).join('');
}

/** 内容标签页列表 */
function renderHomeTabs() {
  const el = $('homeTabList');
  if (!el) return;

  const active = homeCfg.tabs;
  const all = Object.keys(HOME_TABS);
  const order = active.concat(all.filter((id) => active.indexOf(id) === -1));

  el.innerHTML = order.map((id) => {
    const on = active.indexOf(id) !== -1;
    return '<li class="home-item' + (on ? '' : ' is-off') + '" data-id="' + id + '">' +
      '<label class="home-item-main">' +
        '<input type="checkbox" data-role="toggle"' + (on ? ' checked' : '') + ' />' +
        '<span class="home-item-text">' +
          '<span class="home-item-name">' + escHtml(HOME_TABS[id]) + '</span>' +
        '</span>' +
      '</label>' +
      '<span class="home-item-move">' +
        '<button type="button" class="mini" data-move="-1" title="上移" aria-label="上移 ' + escHtml(HOME_TABS[id]) + '">↑</button>' +
        '<button type="button" class="mini" data-move="1" title="下移" aria-label="下移 ' + escHtml(HOME_TABS[id]) + '">↓</button>' +
      '</span>' +
    '</li>';
  }).join('');
}

function renderHomeTabOptions() {
  const sel = $('homeDefaultTab');
  if (!sel) return;
  sel.innerHTML = homeCfg.tabs
    .map((id) => '<option value="' + id + '">' + escHtml(HOME_TABS[id]) + '</option>')
    .join('');
  sel.value = homeCfg.defaultTab;
}

function paintHome() {
  // 默认标签页可能刚被停用，先回落到第一个可用项
  if (homeCfg.tabs.indexOf(homeCfg.defaultTab) === -1) homeCfg.defaultTab = homeCfg.tabs[0];

  $('homeEnabled').checked = homeCfg.enabled;
  $('homeShowSearch').checked = homeCfg.showSearch;
  $('homeShowClock').checked = homeCfg.showClock;
  $('homeShowFooter').checked = homeCfg.showFooter;

  renderHomeTabOptions();
  renderHomeTiles();
  renderHomeTabs();
}

/** 保存并即时生效（浮层下次打开时读取） */
async function saveHome() {
  if (homeCfg.tabs.indexOf(homeCfg.defaultTab) === -1) homeCfg.defaultTab = homeCfg.tabs[0];
  await chrome.storage.local.set({ [HOME_KEY]: homeCfg });
  setStatus('起始页设置已保存', 'ok');
}

async function loadHomeSetting() {
  const raw = await chrome.storage.local.get(HOME_KEY);
  homeCfg = normalizeHome(raw[HOME_KEY]);
  paintHome();
}

$('homeEnabled').addEventListener('change', async (e) => {
  homeCfg.enabled = e.target.checked;
  await chrome.storage.local.set({ [HOME_KEY]: homeCfg });
  setStatus(homeCfg.enabled ? '已开启起始页浮层' : '已关闭起始页自动显示', 'ok');
});

$('homeDefaultTab').addEventListener('change', async (e) => {
  homeCfg.defaultTab = e.target.value;
  await saveHome();
});

// 显隐开关
[
  ['homeShowSearch', 'showSearch'],
  ['homeShowClock', 'showClock'],
  ['homeShowFooter', 'showFooter']
].forEach(([id, key]) => {
  $(id).addEventListener('change', async (e) => {
    homeCfg[key] = e.target.checked;
    await saveHome();
  });
});

/** 磁贴列表：勾选启停、尺寸切换、上下排序 */
function bindHomeTiles() {
  const el = $('homeTileList');
  if (!el) return;

  el.addEventListener('change', async (e) => {
    const li = e.target.closest('.home-item');
    if (!li) return;
    const id = li.getAttribute('data-id');

    if (e.target.matches('[data-role="size"]')) {
      const t = homeCfg.tiles.find((x) => x.id === id);
      if (!t) return;
      t.size = e.target.value;
      await saveHome();
      return;
    }

    if (!e.target.matches('[data-role="toggle"]')) return;

    if (e.target.checked) {
      if (!homeCfg.tiles.some((x) => x.id === id)) homeCfg.tiles.push({ id: id, size: 'small' });
    } else {
      homeCfg.tiles = homeCfg.tiles.filter((x) => x.id !== id);
    }

    paintHome();
    await saveHome();
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const li = btn.closest('.home-item');
    if (!li) return;

    const id = li.getAttribute('data-id');
    const i = homeCfg.tiles.findIndex((x) => x.id === id);
    if (i === -1) return;

    const j = i + Number(btn.getAttribute('data-move'));
    if (j < 0 || j >= homeCfg.tiles.length) return;

    const moved = homeCfg.tiles.splice(i, 1)[0];
    homeCfg.tiles.splice(j, 0, moved);
    paintHome();
    await saveHome();
  });
}

/** 标签页列表：勾选启停并保证至少一个 */
function bindHomeTabs() {
  const el = $('homeTabList');
  if (!el) return;

  el.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-role="toggle"]')) return;
    const li = e.target.closest('.home-item');
    if (!li) return;

    const id = li.getAttribute('data-id');
    let arr = homeCfg.tabs.slice();

    if (e.target.checked) {
      if (arr.indexOf(id) === -1) arr.push(id);
    } else {
      arr = arr.filter((x) => x !== id);
    }

    if (!arr.length) {
      e.target.checked = true;
      setStatus('至少保留一个标签页', 'err');
      return;
    }

    homeCfg.tabs = arr;
    paintHome();
    await saveHome();
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const li = btn.closest('.home-item');
    if (!li) return;

    const id = li.getAttribute('data-id');
    const arr = homeCfg.tabs.slice();
    const i = arr.indexOf(id);
    if (i === -1) return;

    const j = i + Number(btn.getAttribute('data-move'));
    if (j < 0 || j >= arr.length) return;

    arr[i] = arr[j];
    arr[j] = id;
    homeCfg.tabs = arr;
    paintHome();
    await saveHome();
  });
}

bindHomeTiles();
bindHomeTabs();

$('homeReset').addEventListener('click', async () => {
  homeCfg = normalizeHome({ ...HOME_DEFAULTS, enabled: homeCfg.enabled });
  paintHome();
  await saveHome();
  setStatus('已恢复起始页默认布局', 'ok');
});

loadHomeSetting().catch((e) => setStatus('读取起始页设置失败：' + e.message, 'err'));

// ============================ 搜索页设置（改动即时生效） ============================

/**
 * 搜索页设置（键 pcs_settings）：与 search/content.js 的定义保持同步。
 * 默认全部开启，任何一项改动内容脚本都会通过 storage 监听即时应用。
 */
const SEARCH_SETTINGS_KEY = 'pcs_settings';
const SEARCH_HISTORY_KEY = 'pcs_history';
const SEARCH_DEFAULTS = { enabled: true, sticky: true, history: true, historyLimit: 8 };

let searchCfg = { ...SEARCH_DEFAULTS };
let searchHistory = [];

function normalizeSearch(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled: c.enabled !== false,
    sticky: c.sticky !== false,
    history: c.history !== false,
    historyLimit: Math.min(20, Math.max(1, Number(c.historyLimit) || SEARCH_DEFAULTS.historyLimit))
  };
}

function paintSearch() {
  $('searchEnabled').checked = searchCfg.enabled;
  $('searchSticky').checked = searchCfg.sticky;
  $('searchHistory').checked = searchCfg.history;
  $('searchHistoryLimit').value = searchCfg.historyLimit;
  $('searchHistoryLimit').disabled = !searchCfg.history;
  $('searchHistoryNote').textContent = searchHistory.length
    ? '当前已记录 ' + searchHistory.length + ' 条搜索词，最近一条在搜索首屏可直接点击。'
    : '还没有搜索记录。关闭记录后已有记录不会自动删除，可用上方按钮清除。';
}

async function saveSearch() {
  await chrome.storage.local.set({ [SEARCH_SETTINGS_KEY]: searchCfg });
  await saveSearchHistory();
  setStatus('搜索页设置已保存', 'ok');
}

async function saveSearchHistory() {
  await chrome.storage.local.set({ [SEARCH_HISTORY_KEY]: searchHistory });
}

function bindSearchSwitch(id, key) {
  $(id).addEventListener('change', async (e) => {
    searchCfg[key] = e.target.checked;
    paintSearch();
    await saveSearch();
  });
}

bindSearchSwitch('searchEnabled', 'enabled');
bindSearchSwitch('searchSticky', 'sticky');
bindSearchSwitch('searchHistory', 'history');

$('searchHistoryLimit').addEventListener('change', async (e) => {
  searchCfg.historyLimit = Math.min(20, Math.max(1, Number(e.target.value) || SEARCH_DEFAULTS.historyLimit));
  searchHistory = searchHistory.slice(0, searchCfg.historyLimit);
  paintSearch();
  await saveSearch();
});

$('searchClearHistory').addEventListener('click', async () => {
  searchHistory = [];
  await chrome.storage.local.remove(SEARCH_HISTORY_KEY);
  paintSearch();
  setStatus('已清除搜索记录', 'ok');
});

async function loadSearch() {
  const raw = await chrome.storage.local.get([SEARCH_SETTINGS_KEY, SEARCH_HISTORY_KEY]);
  searchCfg = normalizeSearch(raw[SEARCH_SETTINGS_KEY]);
  searchHistory = Array.isArray(raw[SEARCH_HISTORY_KEY]) ? raw[SEARCH_HISTORY_KEY] : [];
  paintSearch();
}

loadSearch().catch((e) => setStatus('读取搜索页设置失败：' + e.message, 'err'));

// 搜索页开着时新产生记录，设置页里的计数同步刷新
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SEARCH_HISTORY_KEY]) {
      const next = changes[SEARCH_HISTORY_KEY].newValue;
      searchHistory = Array.isArray(next) ? next : [];
      paintSearch();
    }
  });
} catch (e) { /* 非扩展环境忽略 */ }

// ============================ 站内通知设置（改动即时生效） ============================

/** 键 pco_notify：与 background/notifications.js 的读取保持同步 */
let notifyCfg = null;

function paintNotify() {
  $('notifyEnabled').checked = notifyCfg.enabled;
  $('notifyInterval').value = String(notifyCfg.intervalMinutes);
  $('notifyPickcat').checked = notifyCfg.hosts.pickcat !== false;
  $('notifyCdsq').checked = notifyCfg.hosts.cdsq !== false;
}

async function saveNotify() {
  await chrome.storage.local.set({ [NOTIFY_CONFIG_KEY]: notifyCfg });
  setStatus('站内通知设置已保存', 'ok');
}

$('notifyEnabled').addEventListener('change', (e) => {
  notifyCfg.enabled = e.target.checked;
  saveNotify();
});

$('notifyInterval').addEventListener('change', (e) => {
  notifyCfg.intervalMinutes = Number(e.target.value) || NOTIFY_DEFAULTS.intervalMinutes;
  saveNotify();
});

$('notifyPickcat').addEventListener('change', (e) => {
  notifyCfg.hosts = { ...notifyCfg.hosts, pickcat: e.target.checked };
  saveNotify();
});

$('notifyCdsq').addEventListener('change', (e) => {
  notifyCfg.hosts = { ...notifyCfg.hosts, cdsq: e.target.checked };
  saveNotify();
});

$('notifyTest').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'notify-test' }, () => void chrome.runtime.lastError);
  setStatus('已请求发送测试通知，若没弹出请检查系统通知权限', 'ok');
});

async function loadNotify() {
  fillSelect($('notifyInterval'), NOTIFY_INTERVALS, String(NOTIFY_DEFAULTS.intervalMinutes));
  const raw = await chrome.storage.local.get(NOTIFY_CONFIG_KEY);
  const saved = raw[NOTIFY_CONFIG_KEY] || {};
  notifyCfg = {
    ...NOTIFY_DEFAULTS,
    ...saved,
    hosts: { ...NOTIFY_DEFAULTS.hosts, ...(saved.hosts || {}) }
  };
  paintNotify();
}

loadNotify().catch((e) => setStatus('读取站内通知设置失败：' + e.message, 'err'));

// ============================ 站点外观：鸿蒙字体开关（即时生效） ============================

/** 键 pcr_harmony_font：与 content.js 的 FONT_KEY 保持一致，控制整站字体替换 */
const HARMONY_FONT_KEY = 'pcr_harmony_font';

async function loadAppearance() {
  const raw = await chrome.storage.local.get(HARMONY_FONT_KEY);
  $('appearanceHarmonyFont').checked = raw[HARMONY_FONT_KEY] !== false && raw[HARMONY_FONT_KEY] !== '0';
}

$('appearanceHarmonyFont').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ [HARMONY_FONT_KEY]: e.target.checked });
  setStatus(e.target.checked ? '已启用鸿蒙字体' : '已恢复站点原字体', 'ok');
});

loadAppearance().catch((e) => setStatus('读取站点外观设置失败：' + e.message, 'err'));

// ============================ 关于：显示实际版本号 ============================

$('aboutVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// ============================ 侧栏导航：滚动时高亮当前分区 ============================

(function navSpy() {
  const links = Array.from(document.querySelectorAll('.nav-item'));
  const items = links
    .map((a) => ({ a, sec: document.querySelector(a.getAttribute('href')) }))
    .filter((it) => it.sec);
  if (!items.length) return;

  const LINE = 90;   // 分区标题越过这条线即视为当前分区（header 高度 + 余量）

  function setActive(a) {
    links.forEach((el) => el.classList.toggle('is-active', el === a));
  }

  function update() {
    let cur = items[0];
    items.forEach((it) => { if (it.sec.getBoundingClientRect().top <= LINE) cur = it; });

    // 末尾分区较短时，页面滚到底也越不过 LINE，此时直接高亮最后一项；
    // 否则「AI 功能 / 关于」永远选不中（会一直停在前一个分区）。
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight > 120;
    const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
    if (scrollable && atBottom) cur = items[items.length - 1];

    setActive(cur.a);
  }

  // 点击即刻切换高亮：已滚到底时再点末尾项不会再触发 scroll 事件
  links.forEach((a) => a.addEventListener('click', () => setActive(a)));

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
})();

// ============================ 主题切换（跟随系统 / 亮色 / 暗色） ============================

/** 与 theme-init.js 保持同一个 key */
const THEME_KEY = 'pco_theme';
const THEME_MODES = ['system', 'light', 'dark'];
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = 'system';

function resolvedTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return themeMedia.matches ? 'dark' : 'light';
}

/** 把当前模式映射到 <html data-theme>，并同步菜单勾选态 */
function paintTheme() {
  document.documentElement.dataset.theme = resolvedTheme(themeMode);
  document.querySelectorAll('#themeMenu [data-theme]').forEach((btn) => {
    const on = btn.dataset.theme === themeMode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', String(on));
  });
}

function setTheme(mode, persist) {
  themeMode = THEME_MODES.includes(mode) ? mode : 'system';
  paintTheme();
  if (persist) chrome.storage.local.set({ [THEME_KEY]: themeMode });
}

const themeBtn = $('themeBtn');
const themeMenu = $('themeMenu');

function toggleThemeMenu(show) {
  const next = show === undefined ? themeMenu.hidden : show;
  themeMenu.hidden = !next;
  themeBtn.setAttribute('aria-expanded', String(next));
}

themeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu(themeMenu.hidden);
});

themeMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme]');
  if (!btn) return;
  setTheme(btn.dataset.theme, true);
  toggleThemeMenu(false);
  themeBtn.focus();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme')) toggleThemeMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !themeMenu.hidden) {
    toggleThemeMenu(false);
    themeBtn.focus();
  }
});

// 跟随系统时，系统主题变化要即时反映
themeMedia.addEventListener('change', () => {
  if (themeMode === 'system') paintTheme();
});

chrome.storage.local.get(THEME_KEY).then((raw) => {
  setTheme((raw && raw[THEME_KEY]) || 'system', false);
}).catch(() => setTheme('system', false));
