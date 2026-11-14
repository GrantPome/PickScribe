/**
 * Popup：AI 助手快捷面板。
 *   - 沿用原有开关与服务商 / 模型快速切换；
 *   - 主题与设置页保持一致（pco_theme，system 跟随系统）。
 */
import { getProvider, DEFAULT_CONFIG } from '../shared/constants.js';
import { getConfig, patchConfig } from '../shared/storage.js';

const $ = (id) => document.getElementById(id);

let config = { ...DEFAULT_CONFIG };

// ============================ 主题 ============================

/** 与设置页同一个主题键（pco_theme），system 时跟随操作系统深色偏好 */
async function applyTheme() {
  try {
    const raw = await chrome.storage.local.get('pco_theme');
    const mode = raw && raw.pco_theme;
    document.documentElement.dataset.theme = mode === 'light' || mode === 'dark' ? mode : 'system';
  } catch (e) {
    // 非扩展环境读不到设置时保持跟随系统
    document.documentElement.dataset.theme = 'system';
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pco_theme) applyTheme();
});

// ============================ AI 区 ============================

function render() {
  const preset = getProvider(config.provider);
  $('provider').textContent = preset.name;
  $('enabled').checked = config.aiEnabled !== false && !!config.enabled;
  $('enabled').disabled = config.aiEnabled === false;

  const models = (preset.models || []).slice();
  if (config.model && !models.includes(config.model)) models.unshift(config.model);
  $('model').innerHTML = models.length
    ? models.map((m) => '<option value="' + m + '">' + m + '</option>').join('')
    : '<option value="">（在设置页填写）</option>';
  $('model').value = config.model || '';

  $('tip').textContent = config.aiEnabled === false
    ? 'AI 功能总开关已关闭，可在设置页重新开启。'
    : (config.enabled
      ? '在 Pickcat 帖子详情页的分隔线下方会显示 AI 总结面板。'
      : '已在帖子详情页关闭 AI 总结面板。');
}

// ============================ 通知中心 ============================

let notifyLoading = false;

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '-' + d.getDate();
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showNotifyTip(text) {
  $('notifyTip').hidden = false;
  $('notifyTip').textContent = text;
  const list = $('notifyList');
  list.hidden = true;
  list.innerHTML = '';
}

function renderNotifications(res) {
  const items = (res && res.items) || [];
  if (!items.length) {
    showNotifyTip(res && res.reachable ? '暂时没有新通知' : '未登录或网络不可用，无法读取通知');
    return;
  }

  const unread = Number(res.unreadCount) || 0;
  const list = $('notifyList');
  $('notifyTip').hidden = false;
  $('notifyTip').textContent = (res.enabled ? '' : '系统通知已关闭，仍可在此查看。') +
    (unread ? '共 ' + unread + ' 条未读' : '全部已读') +
    ' · 显示最近 ' + items.length + ' 条';

  list.innerHTML = '';
  list.hidden = false;
  items.forEach((it) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'notice-item';
    btn.title = it.verb + (it.body ? '\n' + it.body : '');
    btn.innerHTML =
      '<span class="notice-dot' + (it.unread ? '' : ' is-read') + '"></span>' +
      '<span class="notice-main">' +
        '<span class="notice-title">' + esc(it.verb) +
          (it.watch ? '<span class="notice-watch">关注</span>' : '') +
        '</span>' +
        (it.body ? '<span class="notice-body">' + esc(it.body) + '</span>' : '') +
      '</span>' +
      '<span class="notice-meta">' + esc(it.host) + '<span>' + relTime(it.time) + '</span></span>';
    btn.addEventListener('click', () => {
      try { chrome.tabs.create({ url: it.url }); } catch (e) { window.open(it.url, '_blank'); }
      window.close();
    });
    list.appendChild(btn);
  });
}

function loadNotifications() {
  if (notifyLoading) return;
  notifyLoading = true;
  showNotifyTip('正在读取通知…');
  const done = (res) => {
    notifyLoading = false;
    if (!res || !res.ok) { showNotifyTip('读取失败，请确认已在社区登录'); return; }
    renderNotifications(res);
  };
  try {
    chrome.runtime.sendMessage({ type: 'notify-list', limit: 10 }, (res) => {
      void chrome.runtime.lastError;
      done(res);
    });
  } catch (e) {
    done(null);
  }
}

$('enabled').addEventListener('change', async (e) => {
  if (config.aiEnabled === false) return;
  config = await patchConfig({ enabled: e.target.checked });
  render();
});

$('model').addEventListener('change', async (e) => {
  config = await patchConfig({ model: e.target.value });
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('notifyRefresh').addEventListener('click', loadNotifications);

// 打开站内通知页：优先选择设置里唯一启用的站点
$('openNotifyPage').addEventListener('click', async () => {
  let origin = 'https://pickcat.dao3.fun';
  try {
    const raw = await chrome.storage.local.get('pco_notify');
    const hosts = (raw && raw.pco_notify && raw.pco_notify.hosts) || {};
    if (hosts.cdsq && hosts.pickcat === false) origin = 'https://cdsq.dao3.fun';
  } catch (e) { /* 读不到设置时用默认站点 */ }
  try { chrome.tabs.create({ url: origin + '/notifications' }); } catch (e) { window.open(origin + '/notifications', '_blank'); }
  window.close();
});

$('openNotifyOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  await applyTheme();
  config = { ...DEFAULT_CONFIG, ...(await getConfig()) };
  render();
  loadNotifications();
})();
