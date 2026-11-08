/**
 * PickScribe 开放接口「首次访问确认」测试助手（模拟第三方扩展）。
 *
 * 仅用于测试，不属于 PickScribe 发行包。
 *
 * 通信方式与 docs/INTEGRATION.md 一致：页面内 window.postMessage（pickcat-client 信封），
 * 由 PickScribe 的内容脚本转发到后台 broker，因此不需要 externally_connectable，
 * 也不需要任何 runtime 外部消息声明。
 */
(() => {
  'use strict';

  const ROOT_ID = 'pcr-tester-root';
  if (document.getElementById(ROOT_ID)) return;

  const SOURCE = 'pickcat-client';
  const API_VERSION = 1;
  const MAX_LOG = 40;

  const extId = (() => {
    try { return chrome.runtime.id; } catch (e) { return ''; }
  })();
  const extVersion = (() => {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '1.0.0'; }
  })();
  const CLIENT = { id: extId, name: 'PickScribe 测试助手', version: extVersion };

  // 每个按钮发一个动作；wait 覆盖「首次确认」的 60 秒等待。
  const DEFS = [
    {
      key: 'ping',
      label: 'ping · 探测',
      hint: '预期 OK：返回版本、页面类型与全局权限',
      action: 'ping',
      payload: {},
      wait: 5000
    },
    {
      key: 'post',
      label: '读取帖子上下文 · post.context',
      hint: '首次会弹确认窗；允许后返回标题与正文',
      action: 'post.context',
      payload: {},
      wait: 70000
    },
    {
      key: 'editor',
      label: '读取编辑器内容 · editor.read',
      hint: '需在编辑页；首次会因「读取编辑器内容」再次弹窗',
      action: 'editor.read',
      payload: { format: 'markdown' },
      wait: 70000
    },
    {
      key: 'ai',
      label: '打开 AI 面板 · ai.open',
      hint: '需在编辑页；预期 OK，不弹确认窗',
      action: 'ai.open',
      payload: { mode: 'writer', prompt: '这是一段来自测试助手的预填指令' },
      wait: 8000
    },
    {
      key: 'disabled',
      label: '权限未开启 · PERMISSION_DISABLED',
      hint: '先在设置关闭「允许第三方读取编辑器内容」，预期直接失败、不弹窗',
      action: 'editor.read',
      payload: { format: 'markdown' },
      wait: 70000,
      logAction: 'editor.read（权限校验）',
      warn: true
    }
  ];

  const GUIDE = [
    '在帖子详情页点「post.context」：首次会弹确认窗，核对请求方名称与 ID（应与面板上方一致）、本次动作「读取当前帖子」、权限「读取帖子正文」，然后点「长期允许」。',
    '再点一次「post.context」：不应再弹窗，直接返回帖子数据。',
    '在设置页「已授权扩展」里撤销（或删除）本扩展的记录后，点任意需要确认的动作，在弹窗里点「仅本次允许」：请求应正常完成，日志显示「仅本次放行」，设置页「已授权扩展」里不应出现这条记录；再点同一按钮会重新弹窗。',
    '在弹窗里点拒绝 → 返回 DENIED；再点一次仍是 DENIED，不会写授权。',
    '设置页 → 开放接口 → 已授权扩展 → 对应权限点「撤销」，再请求同一动作会重新弹窗。',
    '点一个需要确认的动作后不操作弹窗：约 60 秒后弹窗自动关闭，请求返回 CONSENT_TIMEOUT。',
    '设置页关闭「允许第三方读取编辑器内容」后点最后一个按钮：直接返回 PERMISSION_DISABLED，不弹窗。'
  ];

  const pending = new Map();   // requestId -> entry
  const buttons = new Map();   // def.key -> button
  let rootEl = null;
  let logEl = null;
  let chipEl = null;
  let copyTimer = 0;

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function timeText() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function build() {
    rootEl = h('div');
    rootEl.id = ROOT_ID;
    rootEl.className = 'pcr-tester-root';

    const head = h('div', 'pcr-tester-head');
    head.appendChild(h('span', 'pcr-tester-title', '开放接口测试'));
    chipEl = h('span', 'pcr-tester-chip', '检测中…');
    head.appendChild(chipEl);
    const collapse = h('button', 'pcr-tester-icon', '−');
    collapse.type = 'button';
    collapse.title = '收起 / 展开';
    collapse.addEventListener('click', () => {
      const collapsed = rootEl.classList.toggle('is-collapsed');
      collapse.textContent = collapsed ? '+' : '−';
    });
    head.appendChild(collapse);

    const body = h('div', 'pcr-tester-body');

    const meta = h('p', 'pcr-tester-meta');
    meta.appendChild(document.createTextNode('模拟第三方扩展 · 本扩展 ID '));
    meta.appendChild(h('code', '', extId || '未知'));
    meta.appendChild(document.createTextNode('（确认弹窗里应显示同一个 ID）'));
    body.appendChild(meta);

    const actions = h('div', 'pcr-tester-actions');
    DEFS.forEach((def) => {
      const btn = h('button', 'pcr-tester-btn' + (def.warn ? ' is-warn' : ''));
      btn.type = 'button';
      btn.appendChild(h('strong', '', def.label));
      btn.appendChild(h('span', '', def.hint));
      btn.addEventListener('click', () => start(def, btn));
      actions.appendChild(btn);
      buttons.set(def.key, btn);
    });
    body.appendChild(actions);

    const guide = h('details', 'pcr-tester-guide');
    guide.appendChild(h('summary', '', '测试顺序与预期'));
    const ol = h('ol');
    GUIDE.forEach((text) => ol.appendChild(h('li', '', text)));
    guide.appendChild(ol);
    body.appendChild(guide);

    const logbar = h('div', 'pcr-tester-logbar');
    logbar.appendChild(h('span', '', '请求日志'));
    const tools = h('span', 'pcr-tester-tools');
    const copyBtn = h('button', 'pcr-tester-mini', '复制');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyLog(copyBtn));
    const clearBtn = h('button', 'pcr-tester-mini', '清空');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => { if (logEl) logEl.textContent = ''; });
    tools.appendChild(copyBtn);
    tools.appendChild(clearBtn);
    logbar.appendChild(tools);
    body.appendChild(logbar);

    logEl = h('div', 'pcr-tester-log');
    body.appendChild(logEl);

    rootEl.appendChild(head);
    rootEl.appendChild(body);
    (document.body || document.documentElement).appendChild(rootEl);
  }

  function setChip(status, found) {
    if (!chipEl) return;
    if (!status || typeof status !== 'object') {
      chipEl.textContent = '未发现 PickScribe';
      chipEl.classList.remove('is-found');
      return;
    }
    const page = status.page && status.page.type ? status.page.type : '';
    chipEl.textContent = 'PickScribe ' + (status.version || '') + (page ? ' · ' + page : '');
    chipEl.classList.toggle('is-found', !!found);
  }

  function post(id, action, payload) {
    try {
      window.postMessage({
        source: SOURCE,
        v: API_VERSION,
        id,
        action,
        payload,
        ts: Date.now(),
        client: CLIENT
      }, location.origin);
    } catch (e) {
      /* 序列化失败等异常交给等待超时兜底 */
    }
  }

  function addLog(def) {
    const item = h('div', 'pcr-tester-log-item is-pending');
    const row = h('div', 'pcr-tester-log-row');
    row.appendChild(h('span', 'pcr-tester-log-time', timeText()));
    row.appendChild(h('span', 'pcr-tester-log-action', def.logAction || def.action));
    const state = h('span', 'pcr-tester-log-state', '等待 ACK… 0s');
    row.appendChild(state);
    const detail = h('div', 'pcr-tester-log-detail');
    item.appendChild(row);
    item.appendChild(detail);
    logEl.prepend(item);
    while (logEl.children.length > MAX_LOG) logEl.removeChild(logEl.lastChild);
    return { item, state, detail };
  }

  function start(def, btn) {
    const id = 'tester-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const ui = addLog(def);
    btn.disabled = true;

    const entry = {
      id,
      def,
      btn,
      item: ui.item,
      stateEl: ui.state,
      detailEl: ui.detail,
      start: Date.now(),
      tick: 0,
      timer: 0,
      silent: false
    };
    pending.set(id, entry);

    entry.tick = setInterval(() => {
      if (!pending.has(id)) return;
      entry.stateEl.textContent = '等待 ACK… ' + Math.round((Date.now() - entry.start) / 1000) + 's';
    }, 1000);
    entry.timer = setTimeout(() => {
      failEntry(entry, '无 ACK', '超时仍未收到 ACK：PickScribe 未加载、页面不在允许站点，或请求被限流丢弃。');
    }, def.wait);

    post(id, def.action, def.payload || {});
  }

  function failEntry(entry, codeText, detail) {
    if (!pending.has(entry.id)) return;
    clearInterval(entry.tick);
    clearTimeout(entry.timer);
    pending.delete(entry.id);
    if (entry.silent) return;
    entry.item.classList.remove('is-pending');
    entry.item.classList.add('is-fail');
    entry.stateEl.textContent = codeText + ' · ' + ((Date.now() - entry.start) / 1000).toFixed(1) + 's';
    entry.detailEl.textContent = detail || '';
    if (entry.btn) entry.btn.disabled = false;
  }

  function settle(entry, p) {
    clearInterval(entry.tick);
    clearTimeout(entry.timer);
    pending.delete(entry.id);

    if (entry.silent) {
      if (p && p.ok) setChip(p.data, true);
      return;
    }

    const ok = !!p.ok;
    const seconds = ((Date.now() - entry.start) / 1000).toFixed(1);
    entry.item.classList.remove('is-pending');
    entry.item.classList.add(ok ? 'is-ok' : 'is-fail');
    entry.stateEl.textContent = (p.code || (ok ? 'OK' : 'INTERNAL')) +
      ' · ' + seconds + 's' + (p.duplicate ? ' · 去重' : '') + (p.once ? ' · 仅本次放行' : '');
    entry.detailEl.textContent = describe(entry.def, p);
    if (entry.btn) entry.btn.disabled = false;
    if (entry.def.action === 'ping' && ok) setChip(p.data, true);
  }

  function describe(def, p) {
    const parts = [];
    if (p.message) parts.push(p.message);
    const d = p.data;
    if (d == null) return parts.join(' · ');

    try {
      if (def.action === 'post.context' && d && typeof d === 'object' && (d.id || d.title)) {
        parts.push('id=' + (d.id || '—'));
        if (d.title) parts.push('标题：' + d.title);
        if (d.author && d.author.username) parts.push('作者：' + d.author.username);
        if (typeof d.bodyLength === 'number') {
          parts.push('正文 ' + d.bodyLength + ' 字符' + (d.bodyTruncated ? '（已截断）' : ''));
        }
      } else if (def.action === 'editor.read' && d && typeof d === 'object') {
        if (typeof d.length === 'number') {
          parts.push((d.mode || 'source') + ' · ' + d.length + ' 字符 · ' + (d.isEmpty ? '空' : '非空'));
        }
        if (d.revision) parts.push('revision ' + d.revision);
      } else if (def.action === 'ai.open' && d && typeof d === 'object') {
        parts.push('opened=' + !!d.opened + ' · mode=' + (d.mode || '—'));
      } else if (def.action === 'ping' && d && typeof d === 'object') {
        parts.push('版本 ' + (d.version || '—') + ' · 页面 ' + ((d.page && d.page.type) || '—'));
        if (d.perms) {
          const on = Object.keys(d.perms).filter((k) => d.perms[k]);
          parts.push('权限 ' + (on.join('/') || '无'));
        }
      } else {
        parts.push(JSON.stringify(d).slice(0, 300));
      }
    } catch (e) {
      parts.push(String(d));
    }
    return parts.filter(Boolean).join(' · ');
  }

  function copyLog(btn) {
    const text = logEl ? logEl.innerText : '';
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制';
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { btn.textContent = old; }, 1200);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { /* 忽略 */ }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
        return;
      }
    } catch (e) { /* 忽略 */ }
    fallback();
  }

  function probe() {
    const id = 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const entry = { id, silent: true, start: Date.now(), tick: 0, timer: 0, btn: null };
    pending.set(id, entry);
    entry.timer = setTimeout(() => failEntry(entry, '无 ACK', ''), 4000);
    post(id, 'ping', {});
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'pickscribe') return;

    if (d.action === 'hello') {
      setChip(d.payload, true);
      return;
    }
    if (d.action !== 'ack' || !d.payload) return;

    const entry = pending.get(d.payload.replyTo);
    if (entry) settle(entry, d.payload);
  });

  build();
  setChip(null, false);
  [600, 3000].forEach((ms) => setTimeout(probe, ms));
})();
