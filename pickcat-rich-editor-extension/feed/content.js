/**
 * 首页信息流网格布局 —— 内容脚本（命名空间 pcf）
 *
 * 目标：把首页 / 论坛 / 分类页的信息流从「一行一个帖子」切换成一屏多张卡片的网格，
 *      并在列表控制栏放一个列表 / 网格切换按钮，点击即时切换、选择保存在本机。
 *
 * 做法：
 *   1. 只在信息流页面生效，识别站点自带的 section[aria-label$="帖子"] 容器；
 *   2. 网格布局完全交给 feed.css 里的 .pcf-grid 完成，不改站点任何业务逻辑；
 *   3. 切换按钮注入到 [aria-label="首页列表控制"] 这一行，样式复用站点 --ui-* 令牌；
 *   4. 站点是 SPA 且会频繁重渲染，用 MutationObserver 做定时复查，按钮被移除后自动补回；
 *   5. 布局选择写入 chrome.storage.local 的 pcr_feed_layout（grid / list，默认 grid）。
 */

(() => {
  'use strict';

  // ============================ 0. 常量 ============================

  /** 设置键：信息流排列方式，默认网格 */
  const LAYOUT_KEY = 'pcr_feed_layout';
  /** 视为信息流页面的路径：首页 / 论坛 / 分类 */
  const FEED_PATH = /^\/$|^\/forum\/?$|^\/forum\/category\/[^/?#]+\/?$/;
  /** 帖子列表容器：站点的 aria-label 为「推荐帖子 / 关注帖子 / 最新帖子」 */
  const FEED_SECTION = 'section[aria-label$="帖子"]';
  /** 列表控制栏：站点在这里放「关注 / 推荐 / 最新」排序标签 */
  const CONTROL_BAR = '[aria-label="首页列表控制"]';

  const ICONS = {
    list: '<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/>' +
      '<path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'
  };

  // ============================ 1. 运行状态 ============================

  let layout = 'grid';       // 当前排列方式：grid | list
  let observer = null;       // DOM 变化看护
  let syncTimer = null;      // 合并高频 DOM 变化

  // ============================ 2. 工具函数 ============================

  function isFeedPage() {
    return FEED_PATH.test(location.pathname || '/');
  }

  function icon(name, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // ============================ 3. 切换按钮 ============================

  function buildToggle() {
    const el = document.createElement('div');
    el.id = 'pcf-toggle';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', '信息流排列方式');
    el.innerHTML =
      '<button type="button" class="pcf-btn" data-pcf-layout="list" title="列表视图" aria-label="列表视图">' +
        icon('list', 16) +
      '</button>' +
      '<button type="button" class="pcf-btn" data-pcf-layout="grid" title="网格视图" aria-label="网格视图">' +
        icon('grid', 16) +
      '</button>';

    el.querySelectorAll('.pcf-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setLayout(btn.getAttribute('data-pcf-layout'));
      });
    });
    return el;
  }

  function paintToggle(el) {
    if (!el) return;
    el.querySelectorAll('.pcf-btn').forEach((btn) => {
      const on = btn.getAttribute('data-pcf-layout') === layout;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /** 把按钮放到列表控制栏右侧；站点重渲染把按钮删掉时会自动补回 */
  function ensureToggle() {
    const bar = document.querySelector(CONTROL_BAR);
    if (!bar) return;
    let el = bar.querySelector('#pcf-toggle');
    if (!el) {
      el = buildToggle();
      bar.appendChild(el);
    }
    paintToggle(el);
  }

  function removeToggle() {
    const el = document.getElementById('pcf-toggle');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ============================ 4. 布局应用 ============================

  /** 给信息流容器加 / 去网格类；不改动任何帖子节点本身 */
  function applySections() {
    const sections = document.querySelectorAll(FEED_SECTION);
    sections.forEach((section) => {
      const on = layout === 'grid';
      if (on !== section.classList.contains('pcf-grid')) {
        section.classList.toggle('pcf-grid', on);
      }
    });
  }

  /** 离开信息流页面时把残留的网格类与按钮清掉 */
  function clearAll() {
    document.querySelectorAll(FEED_SECTION + '.pcf-grid').forEach((section) => {
      section.classList.remove('pcf-grid');
    });
    removeToggle();
  }

  function sync() {
    if (!isFeedPage()) {
      clearAll();
      return;
    }
    applySections();
    ensureToggle();
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync();
    }, 120);
  }

  function setLayout(next) {
    const value = next === 'list' ? 'list' : 'grid';
    if (layout === value) return;
    layout = value;
    try {
      chrome.storage.local.set({ [LAYOUT_KEY]: layout });
    } catch (e) { /* 扩展上下文失效时忽略 */ }
    sync();
  }

  function applyLayout(value) {
    layout = value === 'list' ? 'list' : 'grid';
    sync();
  }

  // ============================ 5. 生命周期 ============================

  function boot() {
    try {
      chrome.storage.local.get(LAYOUT_KEY, (raw) => {
        if (chrome.runtime.lastError) return;
        applyLayout(raw && raw[LAYOUT_KEY]);
      });
    } catch (e) {
      applyLayout(null);
    }

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[LAYOUT_KEY]) return;
        applyLayout(changes[LAYOUT_KEY].newValue);
      });
    } catch (e) { /* noop */ }

    // 站点首屏是异步渲染的，先跑一次，再靠 MutationObserver 跟进
    sync();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    // 站内前进 / 后退时路径会变，配合路由复查
    window.addEventListener('popstate', scheduleSync);
    setInterval(scheduleSync, 1500);
  }

  // 防止扩展被重复注入时出现两套按钮
  if (window.__pickscribeFeedLoaded) return;
  window.__pickscribeFeedLoaded = true;

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
