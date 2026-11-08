/**
 * 第三方扩展首次访问确认弹窗（pcc 前缀）。
 *
 * 目标：当 background broker 判定某个数据动作缺少授权时，在当前站点页面弹窗，
 *      让用户看清「请求方是谁、要什么权限、这次要做什么」，再决定是否放行。
 *
 * 三个结果：
 *   allow（长期允许）写入 pcr_api_grants；once（仅本次允许）只放行当前这一条请求；
 *   deny（拒绝）记录拒绝状态。授权记录统一由 background 写入。
 *
 * 约定：
 *   1. 独立挂在 #pcr-consent-root，不复用引导的落点锚定与步骤状态；
 *   2. 只负责展示与收集决定，授权记录由 background 统一写入 pcr_api_grants；
 *   3. 请求在用户决定前一直 pending；关闭 / 超时返回明确结果，不挂死调用方；
 *   4. 弹窗内的用户数据一律用 textContent 写入，不拼 HTML。
 */

(() => {
  'use strict';

  const ROOT_ID = 'pcr-consent-root';
  const DEFAULT_TIMEOUT = 60 * 1000;
  const EXIT_MS = 0;

  const queue = [];
  let current = null;
  let root = null;
  let card = null;
  let requesterEl = null;
  let actionEl = null;
  let permsEl = null;
  let allowBtn = null;
  let onceBtn = null;
  let denyBtn = null;
  let closeBtn = null;
  let lastFocus = null;

  function ensureRoot() {
    if (root && root.isConnected) return root;

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'pcc-root';
    root.hidden = true;
    root.innerHTML = [
      '<div class="pcc-scrim" data-act="close"></div>',
      '<div class="pcc-card" role="dialog" aria-modal="true" aria-labelledby="pcc-title" aria-describedby="pcc-desc" tabindex="-1">',
      '  <button class="pcc-close" type="button" aria-label="关闭确认窗口" data-act="close">×</button>',
      '  <div class="pcc-head">',
      '    <div class="pcc-badge" aria-hidden="true">!</div>',
      '    <div class="pcc-head-text">',
      '      <h2 class="pcc-title" id="pcc-title">允许第三方扩展访问？</h2>',
      '      <p class="pcc-desc" id="pcc-desc">对方请求使用 PickScribe 的数据能力。</p>',
      '    </div>',
      '  </div>',
      '  <div class="pcc-meta">',
      '    <div class="pcc-meta-row"><span>请求方</span><strong data-ref="requester">—</strong></div>',
      '    <div class="pcc-meta-row"><span>本次动作</span><strong data-ref="action">—</strong></div>',
      '  </div>',
      '  <div class="pcc-perms-wrap">',
      '    <p class="pcc-section">请求的权限</p>',
      '    <ul class="pcc-perms" data-ref="perms"></ul>',
      '  </div>',
      '  <p class="pcc-warn">当前是 L1 信任模式：请求方身份来自对方自述，页面脚本可能伪造。只有在你信任该扩展时才选择「长期允许」；只想放行一次可选「仅本次允许」。真正的身份校验会在 v1.1 配对后生效。</p>',
      '  <div class="pcc-actions">',
      '    <button class="pcc-btn pcc-btn-deny" type="button" data-act="deny">拒绝</button>',
      '    <div class="pcc-actions-main">',
      '      <button class="pcc-btn pcc-btn-allow" type="button" data-act="allow">长期允许</button>',
      '      <button class="pcc-btn pcc-btn-once" type="button" data-act="once">仅本次允许</button>',
      '    </div>',
      '  </div>',
      '  <p class="pcc-once-hint">「仅本次允许」只放行这一次请求，不写入长期授权，下次同一权限项会再次询问。</p>',
      '  <p class="pcc-foot">长期允许后可在「设置 → 开放接口 → 已授权扩展」中随时撤销。</p>',
      '</div>'
    ].join('');

    (document.body || document.documentElement).appendChild(root);
    card = root.querySelector('.pcc-card');
    requesterEl = root.querySelector('[data-ref="requester"]');
    actionEl = root.querySelector('[data-ref="action"]');
    permsEl = root.querySelector('[data-ref="perms"]');
    allowBtn = root.querySelector('[data-act="allow"]');
    onceBtn = root.querySelector('[data-act="once"]');
    denyBtn = root.querySelector('[data-act="deny"]');
    closeBtn = root.querySelector('.pcc-close');

    root.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    return root;
  }

  function clientText(client) {
    const c = client && typeof client === 'object' ? client : {};
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const id = typeof c.extensionId === 'string' ? c.extensionId.trim() : '';
    if (name && id && name !== id) return name + '（ID: ' + id + '）';
    return name || id || '未提供名称或 ID';
  }

  function render(entry) {
    const msg = entry.msg || {};
    requesterEl.textContent = clientText(msg.client);
    actionEl.textContent = msg.actionLabel || msg.action || '未知动作';

    permsEl.textContent = '';
    const list = Array.isArray(msg.perms) ? msg.perms : [];
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'pcc-perm pcc-perm-empty';
      li.textContent = '未声明具体权限';
      permsEl.appendChild(li);
    } else {
      list.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'pcc-perm';
        const label = document.createElement('strong');
        label.textContent = (p && p.label) || (p && p.key) || '权限';
        li.appendChild(label);
        const desc = (p && p.desc) || '';
        if (desc) {
          const span = document.createElement('span');
          span.textContent = desc;
          li.appendChild(span);
        }
        permsEl.appendChild(li);
      });
    }
  }

  function clearTimer(entry) {
    if (entry && entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = 0;
    }
  }

  function resolveEntry(entry, decision) {
    if (!entry || entry.done) return;
    entry.done = true;
    clearTimer(entry);
    try {
      entry.sendResponse({ decision });
    } catch (e) {
      /* 页面已跳转或消息通道关闭，忽略 */
    }
    if (current === entry) {
      current = null;
      hide();
      const next = queue.shift();
      if (next) setTimeout(() => start(next), EXIT_MS);
    }
  }

  function hide() {
    if (!root) return;
    root.classList.remove('is-open');
    root.hidden = true;
    try {
      if (lastFocus && typeof lastFocus.focus === 'function' && lastFocus.isConnected) lastFocus.focus();
    } catch (e) { /* 忽略 */ }
    lastFocus = null;
  }

  function start(entry) {
    ensureRoot();
    current = entry;
    render(entry);
    lastFocus = document.activeElement;
    root.hidden = false;
    // 下一帧再加 is-open，保证入场过渡能触发
    requestAnimationFrame(() => {
      if (current === entry) root.classList.add('is-open');
    });
    try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); }

    const wait = Math.max(5000, Number(entry.msg && entry.msg.timeout) || DEFAULT_TIMEOUT);
    entry.timer = setTimeout(() => resolveEntry(entry, 'timeout'), wait);
  }

  function enqueue(msg, sendResponse) {
    const entry = { msg, sendResponse, done: false, timer: 0 };
    if (current) queue.push(entry);
    else start(entry);
  }

  function onClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || !root.contains(el) || !current) return;
    const act = el.getAttribute('data-act');
    if (act === 'allow' || act === 'once' || act === 'deny' || act === 'close') {
      e.preventDefault();
      e.stopPropagation();
      resolveEntry(current, act);
    }
  }

  function onKey(e) {
    if (!current || !root || root.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      resolveEntry(current, 'close');
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [closeBtn, denyBtn, allowBtn, onceBtn].filter((el) => el && !el.disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.__pcr_consent_request !== true) return undefined;
      enqueue(msg, sendResponse);
      return true;
    });
  } catch (e) {
    /* 非扩展环境（例如本地静态预览）忽略 */
  }
})();
