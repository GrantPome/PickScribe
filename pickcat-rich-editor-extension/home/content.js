/**
 * PickScribe 起始页浮层 —— 内容脚本
 *
 * 触发条件：
 *   - 仅当站点首页（/ 或 /forum）发生「整页加载」时出现，即「每次打开网站」显示一次；
 *   - 站内 SPA 跳转回首页不会重复弹出（脚本只在整页加载时注入）；
 *   - 设置页关闭开关后不再自动显示。
 *
 * 视觉：Windows 8 起始屏幕的彩色磁贴，磁贴直接铺在页面背景上（不套不透明白卡），
 *       颜色复用站点 --ui-* 令牌，深浅色自动跟随；详见 home.css 顶部说明。
 *
 * 自定义（设置页「起始页浮层」区，键 pcr_home）：
 *   tiles       [{ id, size }]                 启用的磁贴与顺序，size: small | wide | large
 *   tabs       string[]                        启用并排序的内容标签页
 *   defaultTab string                          默认打开的标签页
 *   showSearch / showClock / showFooter        搜索框 / 时钟 / 底栏的显隐
 *   enabled    boolean                         是否每次打开首页自动显示
 *
 * 内容来源：
 *   - 社区精选：直接读取首页信息流已有的 article[data-slot="root"]，不发任何额外网络请求；
 *   - 我的收藏：读取收藏夹 Plus 的本地数据 pcf_items；
 *   - 快捷导航：站内固定入口 + 扩展设置 / 收藏工作台。
 *
 * 工程约定与站内其他模块一致：经典内容脚本、pch- 前缀、复用站点 --ui-* 设计令牌、
 * 常驻路由看护（离开首页立即收起），不修改站点任何业务逻辑。
 */

(function () {
  'use strict';

  // ============================ 0. 常量 ============================

  const HOME_KEY = 'pcr_home';          // 起始页设置
  const FAV_ITEMS_KEY = 'pcf_items';    // 收藏夹 Plus 的收藏项映射
  const HOME_PATHS = ['/', '/forum'];   // 视为「社区首页」的路径

  /** 默认配置：与 options.js 中的定义保持一致 */
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
      { id: 'fav-tab', size: 'small' },
      { id: 'settings', size: 'small' },
      { id: 'back', size: 'small' }
    ],
    tabs: ['feed', 'fav', 'nav']
  };

  const TILE_SIZES = ['small', 'wide', 'large'];

  /** 旧版默认顺序（返回社区大磁贴在最前），用于把没改过顺序的用户平滑迁到新顺序 */
  const LEGACY_TILE_ORDER = 'back:large,compose:small,search:small,notifications:small,works:small,fav-tab:small,settings:small';

  /** 磁贴定义。顺序即设置页里的展示顺序；color 是磁贴的纯色底色 */
  const TILES = {
    back: {
      label: '返回社区', sub: '关闭起始页，继续浏览', act: 'close', ico: 'back',
      color: '#d93b36'
    },
    compose: {
      label: '发帖', sub: '进入编辑器新建帖子', act: 'compose', ico: 'pen',
      color: '#e0603a'
    },
    search: {
      label: '搜索', sub: '查找帖子、用户与关键词', act: 'search', ico: 'search',
      color: '#414c5c'
    },
    notifications: {
      label: '消息', sub: '回复、点赞与系统通知', act: 'notifications', ico: 'bell',
      color: '#2b6cb0'
    },
    works: {
      label: '作品', sub: '浏览作品广场', act: 'works', ico: 'works',
      color: '#7a4dd8'
    },
    'fav-tab': {
      label: '收藏', sub: '查看最近收藏', act: 'fav-tab', ico: 'bookmark',
      color: '#c98a24'
    },
    library: {
      label: '图盘', sub: '管理上传过的图片', act: 'library', ico: 'image',
      color: '#14807a'
    },
    account: {
      label: '账号', sub: '资料、头像与偏好', act: 'account', ico: 'user',
      color: '#4c5bd4'
    },
    settings: {
      label: '设置', sub: 'PickScribe 设置', act: 'settings', ico: 'sliders',
      color: '#5a6675'
    }
  };

  /** 内容标签页定义 */
  const TABS = {
    feed: { label: '社区精选' },
    fav: { label: '我的收藏' },
    nav: { label: '快捷导航' }
  };

  const CATEGORIES = [
    { name: '创作与作品', slug: 'creative-works', color: '#f03e46' },
    { name: '学习与技术', slug: 'learning-technology', color: '#3b82f6' },
    { name: '兴趣广场', slug: 'interest-plaza', color: '#22c55e' },
    { name: '活动与赛事', slug: 'events-competitions', color: '#f59e0b' },
    { name: '你问我答', slug: 'q-and-a', color: '#8b5cf6' },
    { name: '神奇代码岛', slug: 'box', color: '#06b6d4' }
  ];

  const ICONS = {
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    works: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/>',
    sliders: '<path d="M4 6h16"/><circle cx="9" cy="6" r="2.5"/><path d="M4 12h16"/><circle cx="15" cy="12" r="2.5"/><path d="M4 18h16"/><circle cx="9" cy="18" r="2.5"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    external: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 4.9 2.1 2.1"/><path d="m17 17 2.1 2.1"/><path d="m19.1 4.9-2.1 2.1"/><path d="m7 17-2.1 2.1"/>'
  };

  // ============================ 1. 运行状态 ============================

  let root = null;              // 浮层根节点
  let shell = null;             // 主面板
  let cfg = null;               // 归一化后的起始页配置
  let activeTab = 'feed';
  let closed = false;
  let clockTimer = null;
  let feedTimer = null;
  let routeTimer = null;
  let feedAttempts = 0;
  let favLoading = false;

  // ============================ 2. 工具函数 ============================

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  function icon(name, size) {
    const px = size || 20;
    return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isHomePage() {
    const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    return HOME_PATHS.indexOf(path) !== -1;
  }

  function capId(id) {
    return id.charAt(0).toUpperCase() + id.slice(1);
  }

  /** 把站内链接归一化为相对路径，站外链接直接丢弃，避免把用户带去未知域名 */
  function safeHref(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.origin !== location.origin) return '';
      return u.pathname + u.search;
    } catch (e) {
      return '';
    }
  }

  /** 只保留「发布时间」里适合一行的短文本 */
  function shortTime(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (/\d{4}-\d{2}-\d{2}/.test(text)) {
      const d = new Date(text);
      if (!isNaN(d.getTime())) return (d.getMonth() + 1) + '/' + d.getDate();
    }
    return text;
  }

  function relativeTime(ts) {
    const n = Number(ts) || 0;
    if (!n) return '';
    const diff = Date.now() - n;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    const d = new Date(n);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function $(selector) {
    return root ? root.querySelector(selector) : null;
  }

  function skeletonHtml(n) {
    return new Array(n).fill('<div class="pch-skeleton"></div>').join('');
  }

  /**
   * 磁贴归一化：接受 [{ id, size }]，也兼容旧配置里的 shortcuts 字符串数组。
   * 缺省（undefined）回落到默认磁贴；显式空数组才表示「不显示磁贴」。
   */
  function normalizeTiles(source) {
    if (!Array.isArray(source)) {
      return HOME_DEFAULTS.tiles.map((t) => ({ id: t.id, size: t.size }));
    }
    const out = [];
    source.forEach((item) => {
      const id = typeof item === 'string' ? item : (item && item.id);
      if (!id || !TILES[id] || out.some((t) => t.id === id)) return;
      const size = typeof item === 'string' ? '' : (item && item.size);
      out.push({ id: id, size: TILE_SIZES.indexOf(size) !== -1 ? size : 'small' });
    });
    return out;
  }

  /** 配置归一化：补齐默认值、过滤未知项、保证标签页至少有一个 */
  function normalizeHome(raw) {
    const c = (raw && typeof raw === 'object') ? raw : {};
    const clean = (arr, all) => {
      const out = [];
      (Array.isArray(arr) ? arr : []).forEach((id) => {
        if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id);
      });
      return out;
    };

    let tiles = normalizeTiles(Array.isArray(c.tiles) ? c.tiles : c.shortcuts);
    if (tiles.map((t) => t.id + ':' + t.size).join(',') === LEGACY_TILE_ORDER) {
      tiles = HOME_DEFAULTS.tiles.map((t) => ({ id: t.id, size: t.size }));
    }
    let tabs = clean(c.tabs, Object.keys(TABS));
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

  // ============================ 3. 模板 ============================

  function tileHtml(item) {
    const t = TILES[item.id];
    if (!t) return '';
    return '<button type="button" class="pch-tile" data-act="' + t.act + '" data-tile="' + item.id + '" ' +
      'data-size="' + item.size + '" draggable="true" ' +
      'style="--pch-a:' + t.color + '">' +
      '<span class="pch-tile-icon">' + icon(t.ico, item.size === 'small' ? 20 : 26) + '</span>' +
      '<span class="pch-tile-label">' + escapeHtml(t.label) +
        (item.size === 'small' ? '' : '<small class="pch-tile-sub">' + escapeHtml(t.sub) + '</small>') +
      '</span>' +
      '</button>';
  }

  function tabsHtml(c) {
    const hint = c.tabs.indexOf('feed') !== -1 ? '按 / 搜索 · Esc 返回' : 'Esc 返回';
    const buttons = c.tabs.map((id) => {
      const t = TABS[id];
      const on = id === c.defaultTab;
      const C = capId(id);
      return '<button type="button" class="pch-tab' + (on ? ' is-on' : '') + '" role="tab" ' +
        'aria-selected="' + (on ? 'true' : 'false') + '" data-tab="' + id + '" ' +
        'aria-controls="pchPane' + C + '" id="pchTab' + C + '">' + escapeHtml(t.label) + '</button>';
    }).join('');

    return '<div class="pch-tabs" role="tablist" aria-label="起始页内容">' +
      '<span class="pch-tab-ink" id="pchTabInk" aria-hidden="true"></span>' +
      buttons +
      '<span class="pch-tab-hint">' + hint + '</span>' +
      '</div>';
  }

  function paneOpen(c, id) {
    const on = id === c.defaultTab;
    const C = capId(id);
    return '<section class="pch-pane' + (on ? ' is-on' : '') + '" role="tabpanel" ' +
      'id="pchPane' + C + '" aria-labelledby="pchTab' + C + '" data-pane="' + id + '" ' +
      'aria-hidden="' + (on ? 'false' : 'true') + '">';
  }

  function navCard(opt) {
    const inner = '<span class="pch-nav-card-ico">' + icon(opt.ico) + '</span>' +
      '<span class="pch-nav-card-text">' +
      '<span class="pch-nav-card-name">' + escapeHtml(opt.name) + '</span>' +
      '<span class="pch-nav-card-desc">' + escapeHtml(opt.desc) + '</span>' +
      '</span>';

    if (opt.act) {
      return '<button type="button" class="pch-nav-card" data-act="' + opt.act + '">' + inner + '</button>';
    }
    return '<a class="pch-nav-card" href="' + escapeAttr(opt.href) + '">' + inner + '</a>';
  }

  function navHtml() {
    const cats = CATEGORIES.map((c) =>
      '<a class="pch-chip" href="/forum/category/' + encodeURIComponent(c.slug) + '">' +
      '<span class="pch-chip-dot" style="--dot:' + c.color + '"></span>' + escapeHtml(c.name) +
      '</a>'
    ).join('');

    const siteLinks = [
      { name: '作品广场', desc: '看看大家发布的作品', href: '/works', ico: 'works' },
      { name: '消息中心', desc: '回复、点赞与系统通知', href: '/notifications', ico: 'bell' },
      { name: '个人图盘', desc: '管理上传过的图片', href: '/personal-library', ico: 'image' },
      { name: '账号设置', desc: '资料、头像与偏好', href: '/settings', ico: 'user' }
    ].map(navCard).join('');

    const extLinks = [
      { name: '收藏工作台', desc: '分组、标签、备注与检索', act: 'fav-console', ico: 'bookmark' },
      { name: 'PickScribe 设置', desc: 'AI 模型与起始页开关', act: 'settings', ico: 'sliders' }
    ].map(navCard).join('');

    return '<div class="pch-nav-group"><h4>分类</h4><div class="pch-chips">' + cats + '</div></div>' +
      '<div class="pch-nav-group"><h4>站点入口</h4><div class="pch-links">' + siteLinks + '</div></div>' +
      '<div class="pch-nav-group"><h4>PickScribe 工具</h4><div class="pch-links">' + extLinks + '</div></div>';
  }

  function buildTemplate(version, c) {
    const nav = c.tiles.length
      ? '<nav class="pch-tiles" aria-label="快捷入口">' +
          c.tiles.map(tileHtml).join('') +
        '</nav>'
      : '';

    return '<div class="pch-shell" role="dialog" aria-modal="true" aria-label="PICKCAT 起始页" tabindex="-1">' +
      // 顶栏
      '<header class="pch-top">' +
        '<div class="pch-brand">' +
          '<img class="pch-logo" src="/favicon.png" alt="" />' +
          '<div class="pch-brand-text">' +
            '<h1 class="pch-brand-title">PICKCAT</h1>' +
            '<p class="pch-brand-sub">起始页 · PickScribe</p>' +
          '</div>' +
        '</div>' +
        '<div class="pch-top-right">' +
          '<span class="pch-clock" id="pchClock"></span>' +
          '<button type="button" class="pch-icon-btn" data-act="settings" title="PickScribe 设置" aria-label="打开 PickScribe 设置">' + icon('sliders') + '</button>' +
          '<button type="button" class="pch-user" data-act="account" title="打开账号设置" aria-label="打开账号设置">' +
            '<span class="pch-user-avatar">' + icon('user', 16) + '</span>' +
            '<span class="pch-user-name">我的账号</span>' +
          '</button>' +
        '</div>' +
      '</header>' +
      // 主体
      '<div class="pch-body">' +
        nav +
        '<section class="pch-main">' +
          '<div class="pch-search" id="pchSearchWrap"' + (c.showSearch ? '' : ' hidden') + '>' +
            icon('search') +
            '<input id="pchSearchInput" type="search" placeholder="搜索帖子、用户或关键词…" autocomplete="off" spellcheck="false" />' +
            '<kbd>Enter</kbd>' +
            '<button type="button" class="pch-icon-btn" data-act="search-close" title="关闭搜索" aria-label="关闭搜索">' + icon('close', 16) + '</button>' +
          '</div>' +
          tabsHtml(c) +
          '<div class="pch-panes">' +
            paneOpen(c, 'feed') +
              '<div class="pch-pane-head"><h3>社区里正在发生</h3><a class="pch-text-btn" href="/">打开社区 →</a></div>' +
              '<div class="pch-list" id="pchFeedList">' + skeletonHtml(5) + '</div>' +
            '</section>' +
            paneOpen(c, 'fav') +
              '<div class="pch-pane-head"><h3>最近收藏</h3><button type="button" class="pch-text-btn" data-act="fav-console">收藏工作台 →</button></div>' +
              '<div class="pch-list" id="pchFavList"></div>' +
            '</section>' +
            paneOpen(c, 'nav') +
              navHtml() +
            '</section>' +
          '</div>' +
        '</section>' +
      '</div>' +
      // 底栏（可在设置页隐藏）
      (c.showFooter
        ? '<footer class="pch-foot">' +
            '<span>拖动磁贴可调整位置 · <button type="button" class="pch-link" data-act="settings">在设置中关闭或自定义</button></span>' +
            '<span class="pch-version">PickScribe v' + escapeHtml(version) + '</span>' +
          '</footer>'
        : '') +
    '</div>';
  }

  // ============================ 4. 数据读取 ============================

  async function readHomeConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(HOME_KEY, (raw) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve((raw && raw[HOME_KEY]) || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  /** 从首页信息流卡片里取最近帖子（只读 DOM，不请求接口） */
  function collectPosts(limit) {
    const cards = document.querySelectorAll('article[data-slot="root"]');
    const out = [];
    const seen = {};

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const link =
        card.querySelector('h2 a[href*="/forum/post/"]') ||
        card.querySelector('h3 a[href*="/forum/post/"]') ||
        card.querySelector('a[href*="/forum/post/"]');
      if (!link) continue;

      const href = safeHref(link.getAttribute('href') || '');
      if (!href || seen[href]) continue;

      const title = String(link.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 2) continue;

      const authorEl = card.querySelector('a[href*="/profile/"]');
      const catEl = card.querySelector('a[href*="/forum/category"]');
      const timeEl = card.querySelector('time');

      seen[href] = true;
      out.push({
        href: href,
        title: title,
        author: authorEl ? String(authorEl.textContent || '').trim() : '',
        category: catEl ? String(catEl.textContent || '').trim() : '',
        time: timeEl ? shortTime(timeEl.getAttribute('datetime') || timeEl.textContent) : ''
      });

      if (out.length >= limit) break;
    }

    return out;
  }

  // ============================ 5. 渲染 ============================

  function postRow(post, index) {
    const meta = [post.author, post.category, post.time].filter(Boolean).join(' · ');
    return '<a class="pch-post" href="' + escapeAttr(post.href) + '">' +
      '<span class="pch-post-idx">' + String(index + 1).padStart(2, '0') + '</span>' +
      '<span class="pch-post-body">' +
        '<span class="pch-post-title">' + escapeHtml(post.title) + '</span>' +
        '<span class="pch-post-meta">' + escapeHtml(meta) + '</span>' +
      '</span>' +
      '<span class="pch-post-arrow">' + icon('arrow', 16) + '</span>' +
      '</a>';
  }

  function renderFeed() {
    const list = $('#pchFeedList');
    if (!list) return 0;

    const posts = collectPosts(9);
    if (!posts.length) {
      if (feedAttempts < 6) list.innerHTML = skeletonHtml(5);
      return 0;
    }
    list.innerHTML = posts.map(postRow).join('');
    return posts.length;
  }

  function renderFeedEmpty() {
    const list = $('#pchFeedList');
    if (!list) return;
    list.innerHTML = '<div class="pch-empty">' +
      '<span class="pch-empty-icon">' + icon('search', 22) + '</span>' +
      '<strong>社区内容还没准备好</strong>' +
      '<span>首页信息流加载较慢，可以直接进入社区浏览最新帖子。</span>' +
      '<a class="pch-cta" href="/">进入社区</a>' +
      '</div>';
  }

  function startFeedPolling() {
    if (feedTimer) clearTimeout(feedTimer);
    const tick = () => {
      if (!root || closed || activeTab !== 'feed') return;
      const count = renderFeed();
      if (count >= 3 || feedAttempts >= 12) {
        if (!count) renderFeedEmpty();
        return;
      }
      feedAttempts++;
      feedTimer = setTimeout(tick, 700);
    };
    tick();
  }

  function favRow(item) {
    const href = safeHref(item.url || ('/forum/post/' + item.id));
    const tags = (Array.isArray(item.tags) ? item.tags : [])
      .filter((t) => typeof t === 'string' && t)
      .slice(0, 2);
    const meta = [item.author, relativeTime(item.savedAt)].filter(Boolean).join(' · ');
    const tagHtml = tags.map((t) => '<span class="pch-tag">#' + escapeHtml(t) + '</span>').join('');
    const title = item.title || item.url || '未命名收藏';
    const inner = '<span class="pch-post-idx">' + icon('bookmark', 16) + '</span>' +
      '<span class="pch-post-body">' +
        '<span class="pch-post-title">' + escapeHtml(title) + '</span>' +
        '<span class="pch-post-meta">' + escapeHtml(meta) + tagHtml + '</span>' +
      '</span>' +
      '<span class="pch-post-arrow">' + icon('arrow', 16) + '</span>';

    if (!href) {
      return '<div class="pch-post">' + inner + '</div>';
    }
    return '<a class="pch-post" href="' + escapeAttr(href) + '">' + inner + '</a>';
  }

  function renderFavorites() {
    const list = $('#pchFavList');
    if (!list || favLoading) return;

    favLoading = true;
    list.innerHTML = skeletonHtml(3);

    try {
      chrome.storage.local.get(FAV_ITEMS_KEY, (raw) => {
        favLoading = false;
        if (!root || closed) return;
        if (chrome.runtime.lastError) {
          list.innerHTML = '<div class="pch-empty"><strong>读取收藏失败</strong><span>请稍后重试。</span></div>';
          return;
        }

        const map = (raw && raw[FAV_ITEMS_KEY]) || {};
        const items = Object.keys(map)
          .map((k) => map[k])
          .filter((it) => it && it.id && it.dead !== 'dead')
          .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
          .slice(0, 10);

        if (!items.length) {
          list.innerHTML = '<div class="pch-empty">' +
            '<span class="pch-empty-icon">' + icon('bookmark', 22) + '</span>' +
            '<strong>还没有本地收藏</strong>' +
            '<span>在帖子详情页点收藏后，这里会显示最近收藏的帖子。</span>' +
            '<button type="button" class="pch-cta" data-act="fav-console">打开收藏工作台</button>' +
            '</div>';
          return;
        }

        list.innerHTML = items.map(favRow).join('');
      });
    } catch (e) {
      favLoading = false;
      list.innerHTML = '<div class="pch-empty"><strong>读取收藏失败</strong><span>请稍后重试。</span></div>';
    }
  }

  function updateClock() {
    const el = $('#pchClock');
    if (!el) return;
    const now = new Date();
    let date = '';
    let time = '';
    try {
      date = new Intl.DateTimeFormat('zh-CN', {
        month: 'long', day: 'numeric', weekday: 'short'
      }).format(now);
      time = new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', hour12: false
      }).format(now);
    } catch (e) {
      date = (now.getMonth() + 1) + '月' + now.getDate() + '日';
      time = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
    }
    el.textContent = date + ' ' + time;
  }

  /**
   * 顶栏用户信息：优先读站点会话接口，接口不可用时退回站点顶栏头像。
   * 取不到昵称就显示「我的账号」，不阻塞浮层出现。
   */
  async function loadUser() {
    let name = '';
    let avatarUrl = '';

    try {
      const res = await fetch('/api/v1/session', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        const u = (data && (data.user || data.data || data)) || {};
        name = u.username || u.nickname || u.name || '';
        const av = u.avatar;
        avatarUrl = (av && (av.url || av.thumb_url)) || u.avatar_url || '';
      }
    } catch (e) { /* 未登录或接口变更时走 DOM 兜底 */ }

    if (!avatarUrl) {
      const domImg = document.querySelector('button[aria-label="打开账号菜单"] img');
      if (domImg) avatarUrl = domImg.getAttribute('src') || '';
    }

    if (avatarUrl) {
      try { avatarUrl = new URL(avatarUrl, location.origin).href; } catch (e) { avatarUrl = ''; }
    }

    if (!root) return;
    const box = root.querySelector('.pch-user-avatar');
    const label = root.querySelector('.pch-user-name');
    const btn = root.querySelector('.pch-user');

    if (avatarUrl && box) {
      box.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />';
    }
    if (label) label.textContent = name || '我的账号';
    if (btn && name) btn.title = name + ' · 打开账号设置';
  }

  // ============================ 6. 交互 ============================

  /**
   * 让 Tab 的下划线指示器移动到目标按钮。
   * animate=true 时先拉伸到「旧位置 ∪ 新位置」，再收回目标宽度，
   * 形成「先伸长、快到位时恢复」的连贯感。
   */
  function moveTabInk(btn, animate) {
    if (!btn) return;
    const ink = $('#pchTabInk');
    if (!ink) return;

    const left = btn.offsetLeft;
    const width = btn.offsetWidth;
    const prev = ink.__pos;

    const applyTarget = () => {
      ink.style.left = left + 'px';
      ink.style.width = width + 'px';
    };

    if (!animate || !prev) {
      ink.style.transition = 'none';
      applyTarget();
      void ink.offsetWidth;
      ink.style.transition = '';
      ink.__pos = { left: left, width: width };
      return;
    }

    const unionLeft = Math.min(prev.left, left);
    const unionRight = Math.max(prev.left + prev.width, left + width);

    ink.style.transition = 'none';
    ink.style.left = unionLeft + 'px';
    ink.style.width = (unionRight - unionLeft) + 'px';
    void ink.offsetWidth;

    ink.style.transition = 'left .34s cubic-bezier(.22,1,.36,1), width .34s cubic-bezier(.22,1,.36,1)';
    applyTarget();
    ink.__pos = { left: left, width: width };
  }

  function repaintTabInk(animate) {
    if (!root) return;
    const btn = root.querySelector('.pch-tab[data-tab="' + activeTab + '"]');
    const ink = $('#pchTabInk');
    if (!btn) {
      if (ink) ink.style.width = '0px';
      return;
    }
    moveTabInk(btn, animate);
  }

  function setTab(name) {
    if (!cfg || cfg.tabs.indexOf(name) === -1) return;
    activeTab = name;

    root.querySelectorAll('.pch-tab').forEach((btn) => {
      const on = btn.getAttribute('data-tab') === name;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    root.querySelectorAll('.pch-pane').forEach((pane) => {
      const on = pane.getAttribute('data-pane') === name;
      pane.classList.toggle('is-on', on);
      pane.setAttribute('aria-hidden', on ? 'false' : 'true');
    });

    repaintTabInk(true);

    if (name === 'feed') startFeedPolling();
    if (name === 'fav') renderFavorites();
  }

  function openSearch() {
    const wrap = $('#pchSearchWrap');
    const input = $('#pchSearchInput');
    if (!wrap || !input) return;
    wrap.hidden = false;
    input.focus();
    input.select();
  }

  function closeSearch() {
    const wrap = $('#pchSearchWrap');
    const input = $('#pchSearchInput');
    if (!wrap) return;
    wrap.hidden = true;
    if (input) input.value = '';
    if (shell) shell.focus({ preventScroll: true });
  }

  function submitSearch() {
    const input = $('#pchSearchInput');
    const q = input ? input.value.trim() : '';
    if (!q) {
      if (input) input.focus();
      return;
    }
    go('/search?q=' + encodeURIComponent(q));
  }

  function sendMessage(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        // 读取 lastError，避免在扩展被重新加载后控制台报错
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 扩展上下文失效时静默忽略 */
    }
  }

  function go(url) {
    closeOverlay(true);
    location.assign(url);
  }

  function handleAction(act) {
    switch (act) {
      case 'close':
        closeOverlay();
        break;
      case 'compose':
        go('/forum/editor?type=create');
        break;
      case 'search':
        openSearch();
        break;
      case 'search-close':
        closeSearch();
        break;
      case 'notifications':
        go('/notifications');
        break;
      case 'works':
        go('/works');
        break;
      case 'library':
        go('/personal-library');
        break;
      case 'account':
        go('/settings');
        break;
      case 'fav-tab':
        // 收藏标签页被隐藏时，退回到收藏工作台
        if (cfg && cfg.tabs.indexOf('fav') !== -1) setTab('fav');
        else sendMessage({ type: 'open-favorites' });
        break;
      case 'fav-console':
        sendMessage({ type: 'open-favorites' });
        break;
      case 'settings':
        sendMessage({ type: 'open-options' });
        break;
      default:
        break;
    }
  }

  // ---- 磁贴拖动排序（HTML5 拖放，松开后写回 pcr_home.tiles） ----

  let dragId = null;
  let dragAt = 0;

  function onDragStart(e) {
    const tile = e.target.closest('.pch-tile');
    if (!tile) return;
    dragId = tile.getAttribute('data-tile');
    dragAt = Date.now();
    tile.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    } catch (err) { /* 某些环境不允许 setData，忽略 */ }
  }

  function onDragOver(e) {
    if (!dragId || !root) return;
    const over = e.target.closest('.pch-tile');
    if (!over || over.getAttribute('data-tile') === dragId) return;

    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* noop */ }

    const dragging = root.querySelector('.pch-tile.is-dragging');
    if (!dragging || !over.parentNode) return;

    const rect = over.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    over.parentNode.insertBefore(dragging, before ? over : over.nextSibling);
  }

  /** 把当前 DOM 顺序写回配置 */
  function persistTileOrder() {
    if (!cfg || !root) return;
    const domIds = Array.prototype.map.call(
      root.querySelectorAll('.pch-tile'),
      (el) => el.getAttribute('data-tile')
    );
    const byId = {};
    cfg.tiles.forEach((t) => { byId[t.id] = t; });
    const next = domIds.map((id) => byId[id]).filter(Boolean);
    if (!next.length) return;

    const changed = next.length !== cfg.tiles.length ||
      next.some((t, i) => t.id !== cfg.tiles[i].id);
    if (!changed) return;

    cfg.tiles = next;
    try {
      chrome.storage.local.set({ [HOME_KEY]: cfg });
    } catch (e) { /* 扩展上下文失效时忽略 */ }
  }

  function onDragEnd() {
    if (!dragId) return;
    dragId = null;
    const dragging = root ? root.querySelector('.pch-tile.is-dragging') : null;
    if (dragging) dragging.classList.remove('is-dragging');
    persistTileOrder();
  }

  function onDrop(e) {
    // 阻止浏览器把磁贴当成链接 / 文本打开
    if (dragId) e.preventDefault();
  }

  function onClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (actEl && root.contains(actEl)) {
      // 刚拖动过就不要再触发动作
      if (Date.now() - dragAt < 240) return;
      e.preventDefault();
      handleAction(actEl.getAttribute('data-act'));
      return;
    }

    const tabEl = e.target.closest('.pch-tab[data-tab]');
    if (tabEl && root.contains(tabEl)) {
      e.preventDefault();
      setTab(tabEl.getAttribute('data-tab'));
      return;
    }

    // 点击浮层空白处等同于「返回社区」
    if (e.target === root) closeOverlay();
  }

  function onKeydown(e) {
    if (!root) return;

    const typing = e.target && (
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'TEXTAREA' ||
      e.target.isContentEditable
    );

    if (e.key === 'Enter' && e.target === $('#pchSearchInput')) {
      e.preventDefault();
      submitSearch();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const wrap = $('#pchSearchWrap');
      if (wrap && !wrap.hidden) closeSearch();
      else closeOverlay();
      return;
    }

    if (e.key === '/' && !typing) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
    }
  }

  function onResize() {
    repaintTabInk(false);
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes || !changes[HOME_KEY]) return;
    const next = changes[HOME_KEY].newValue || {};
    if (next.enabled === false) closeOverlay(true);
  }

  // ============================ 7. 生命周期 ============================

  function closeOverlay(instant) {
    if (!root) return;
    closed = true;

    if (feedTimer) { clearTimeout(feedTimer); feedTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (routeTimer) { clearInterval(routeTimer); routeTimer = null; }

    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onResize);
    document.documentElement.classList.remove('pch-scroll-lock');
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* noop */ }

    const node = root;
    root = null;
    shell = null;

    if (instant) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }

    node.classList.remove('is-open');
    node.classList.add('is-closing');
    setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 320);
  }

  function mount(config) {
    if (root || closed) return;

    cfg = config;
    activeTab = cfg.defaultTab;

    let version = '3.4.2';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* noop */ }

    root = document.createElement('div');
    root.id = 'pch-root';
    if (!cfg.tiles.length) root.classList.add('pch-no-tiles');
    root.innerHTML = buildTemplate(version, cfg);
    shell = root.querySelector('.pch-shell');

    document.body.appendChild(root);
    document.documentElement.classList.add('pch-scroll-lock');

    // 站点 favicon 不存在时退回纯文字，避免出现破图
    const logo = root.querySelector('.pch-logo');
    if (logo) logo.addEventListener('error', () => { logo.style.display = 'none'; });

    root.addEventListener('click', onClick);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onResize);

    try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (e) { /* noop */ }

    // 先量一次 Tab 位置，避免首次出现时下划线在左上角闪一下
    repaintTabInk(false);

    if (cfg.showClock) {
      updateClock();
      clockTimer = setInterval(updateClock, 30000);
    }

    loadUser();

    requestAnimationFrame(() => {
      if (!root) return;
      root.classList.add('is-open');
      if (shell) shell.focus({ preventScroll: true });
    });

    // 字体（鸿蒙）加载完成后字宽会变，重新对齐下划线
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (root) repaintTabInk(false); }).catch(() => {});
    }

    if (activeTab === 'feed') startFeedPolling();
    if (activeTab === 'fav') renderFavorites();

    // 常驻路由看护：万一站点站内跳转离开首页，立即收起浮层
    routeTimer = setInterval(() => {
      if (root && !isHomePage()) closeOverlay(true);
    }, 800);
  }

  async function boot() {
    if (!isHomePage()) return;

    const conf = normalizeHome(await readHomeConfig());
    if (!conf.enabled) return;   // 默认不开启：只有用户显式开启过才自动显示

    // 等站点首屏开始渲染后再出现，避免先看到一片空白
    await sleep(320);
    if (!isHomePage() || !document.body || closed) return;
    mount(conf);
  }

  // 防止扩展被重复注入时出现两层浮层
  if (window.__pickscribeHomeLoaded) return;
  window.__pickscribeHomeLoaded = true;

  boot();
})();
