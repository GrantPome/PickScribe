/**
 * 首页信息流网格布局 —— 内容脚本（命名空间 pcf）
 *
 * 目标：把首页 / 论坛 / 分类页的信息流从「一行一个帖子」切换成一屏多张卡片的网格，
 *      并在列表控制栏放一个列表 / 网格切换按钮，点击即时切换、选择保存在本机。
 *      同时提供信息流过滤：按标题关键词与作者屏蔽帖子，顶部提示条可一键临时恢复。
 *
 * 做法：
 *   1. 只在信息流页面生效，识别站点自带的 section[aria-label$="帖子"] 容器；
 *   2. 网格布局完全交给 feed.css 里的 .pcf-grid 完成，不改站点任何业务逻辑；
 *   3. 切换按钮与过滤按钮注入到 [aria-label="首页列表控制"] 这一行，样式复用站点 --ui-* 令牌；
 *   4. 站点是 SPA 且会频繁重渲染，用 MutationObserver 做定时复查，按钮被移除后自动补回；
 *   5. 布局选择写入 chrome.storage.local 的 pcr_feed_layout（grid / list，默认 grid）；
 *   6. 过滤规则写入 pcf_filter（keywords / authors），命中卡片加 .pcf-filtered 隐藏，
 *      「显示全部」只在当前会话内临时放行，不改动已保存的规则。
 */

(() => {
  'use strict';

  // ============================ 0. 常量 ============================

  /** 设置键：信息流排列方式，默认网格 */
  const LAYOUT_KEY = 'pcr_feed_layout';
  /** 设置键：信息流过滤规则 { keywords: string[], authors: string[] } */
  const FILTER_KEY = 'pcf_filter';
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
      '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    filter: '<path d="M3 5h18l-7 8.2V19l-4 2v-7.8z"/>'
  };

  // ============================ 1. 运行状态 ============================

  let layout = 'grid';       // 当前排列方式：grid | list
  let observer = null;       // DOM 变化看护
  let syncTimer = null;      // 合并高频 DOM 变化
  let filter = { keywords: [], authors: [] };  // 当前过滤规则
  let revealAll = false;     // 「显示全部」临时放行（不持久化）
  let filterPop = null;      // 过滤设置浮层

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
    el.setAttribute('aria-label', '信息流工具栏');
    el.innerHTML =
      '<button type="button" class="pcf-btn" data-pcf-layout="list" title="列表视图" aria-label="列表视图">' +
        icon('list', 16) +
      '</button>' +
      '<button type="button" class="pcf-btn" data-pcf-layout="grid" title="网格视图" aria-label="网格视图">' +
        icon('grid', 16) +
      '</button>' +
      '<button type="button" class="pcf-btn pcf-filter-btn" data-pcf-act="filter" ' +
        'title="信息流过滤" aria-label="信息流过滤" aria-expanded="false">' +
        icon('filter', 16) +
      '</button>';

    el.querySelectorAll('.pcf-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.getAttribute('data-pcf-act') === 'filter') {
          toggleFilterPop(btn);
          return;
        }
        setLayout(btn.getAttribute('data-pcf-layout'));
      });
    });
    return el;
  }

  function paintToggle(el) {
    if (!el) return;
    el.querySelectorAll('.pcf-btn[data-pcf-layout]').forEach((btn) => {
      const on = btn.getAttribute('data-pcf-layout') === layout;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const f = el.querySelector('.pcf-filter-btn');
    if (f) {
      const on = filter.keywords.length > 0 || filter.authors.length > 0;
      f.classList.toggle('is-on', on);
      f.setAttribute('title', on ? '信息流过滤（已启用）' : '信息流过滤');
    }
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

  /** 离开信息流页面时把残留的网格类、过滤状态与按钮清掉 */
  function clearAll() {
    document.querySelectorAll(FEED_SECTION + '.pcf-grid').forEach((section) => {
      section.classList.remove('pcf-grid');
    });
    document.querySelectorAll('article.pcf-filtered').forEach((card) => {
      card.classList.remove('pcf-filtered');
    });
    document.querySelectorAll('.pcf-filter-note').forEach((note) => {
      if (note.parentNode) note.parentNode.removeChild(note);
    });
    removeToggle();
    closeFilterPop();
  }

  function sync() {
    if (!isFeedPage()) {
      clearAll();
      return;
    }
    applySections();
    ensureToggle();
    applyFilter();
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

  // ============================ 4.1 信息流过滤 ============================

  /** 文本列表统一按行 / 逗号 / 顿号 / 分号切分，最多保存 100 条 */
  function parseList(text) {
    return String(text || '')
      .split(/[\n,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function normalizeAuthor(s) {
    return normalizeText(s).replace(/^@+/, '');
  }

  /** 作者名允许带「楼主」等后缀：整串或按空格切出的词命中都算 */
  function authorMatches(name, want) {
    if (!want) return false;
    if (name === want) return true;
    return name.split(' ').indexOf(want) !== -1;
  }

  function filterActive() {
    return filter.keywords.length > 0 || filter.authors.length > 0;
  }

  /** 卡片内的帖子列表：优先 data-slot=root，兜底普通 article */
  function feedCards(section) {
    const cards = section.querySelectorAll('article[data-slot="root"]');
    return cards.length ? cards : section.querySelectorAll('article');
  }

  /** 卡片标题：优先 h2 / h3 里的帖子链接，退化到第一个帖子链接 */
  function cardTitle(card) {
    const link =
      card.querySelector('h2 a[href*="/forum/post/"]') ||
      card.querySelector('h3 a[href*="/forum/post/"]') ||
      card.querySelector('a[href*="/forum/post/"]');
    return link ? normalizeText(link.textContent) : '';
  }

  /** 卡片作者名：作者链接文本 + 站点可能带的 data-username */
  function cardAuthors(card) {
    const names = [];
    card.querySelectorAll('a[href*="/profile/"]').forEach((a) => {
      const name = normalizeAuthor(a.textContent);
      if (name) names.push(name);
    });
    card.querySelectorAll('[data-username]').forEach((n) => {
      const name = normalizeAuthor(n.getAttribute('data-username'));
      if (name) names.push(name);
    });
    return names;
  }

  function matchesFilter(card) {
    if (!filterActive()) return false;
    const title = cardTitle(card);
    if (title) {
      for (let i = 0; i < filter.keywords.length; i += 1) {
        if (title.indexOf(normalizeText(filter.keywords[i])) !== -1) return true;
      }
    }
    if (filter.authors.length) {
      const authors = cardAuthors(card);
      for (let i = 0; i < filter.authors.length; i += 1) {
        const want = normalizeAuthor(filter.authors[i]);
        for (let j = 0; j < authors.length; j += 1) {
          if (authorMatches(authors[j], want)) return true;
        }
      }
    }
    return false;
  }

  /** 顶部提示条：显示隐藏条数，按钮临时显示 / 重新过滤 */
  function updateNote(section, matched) {
    let note = section.querySelector(':scope > .pcf-filter-note');
    if (!filterActive() || !matched) {
      if (note && note.parentNode) note.parentNode.removeChild(note);
      return;
    }
    if (!note) {
      note = document.createElement('div');
      note.className = 'pcf-filter-note';
      note.innerHTML =
        '<span class="pcf-filter-note-text"></span>' +
        '<button type="button" class="pcf-filter-note-btn"></button>';
      note.querySelector('.pcf-filter-note-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        revealAll = !revealAll;
        sync();
      });
      section.insertBefore(note, section.firstChild);
    }
    const text = revealAll
      ? '已临时显示 ' + matched + ' 条被过滤的帖子'
      : '已按过滤规则隐藏 ' + matched + ' 条帖子';
    const label = revealAll ? '重新过滤' : '显示全部';
    const textEl = note.querySelector('.pcf-filter-note-text');
    const btnEl = note.querySelector('.pcf-filter-note-btn');
    // 只在文案变化时写入，避免 textContent 反复触发 MutationObserver
    if (textEl.textContent !== text) textEl.textContent = text;
    if (btnEl.textContent !== label) btnEl.textContent = label;
  }

  /** 逐卡片比对规则；隐藏只加类名，不改站点节点结构 */
  function applyFilter() {
    document.querySelectorAll(FEED_SECTION).forEach((section) => {
      let matched = 0;
      feedCards(section).forEach((card) => {
        const hit = matchesFilter(card);
        if (hit) matched += 1;
        card.classList.toggle('pcf-filtered', hit && !revealAll);
      });
      updateNote(section, matched);
    });
  }

  function applyFilterCfg(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    filter = {
      keywords: Array.isArray(c.keywords) ? c.keywords.map(String).filter(Boolean).slice(0, 100) : [],
      authors: Array.isArray(c.authors) ? c.authors.map(String).filter(Boolean).slice(0, 100) : []
    };
    revealAll = false;
    sync();
  }

  // ---------- 过滤设置浮层 ----------

  function buildFilterPop() {
    const el = document.createElement('div');
    el.id = 'pcf-filter-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '信息流过滤设置');
    el.hidden = true;
    el.innerHTML =
      '<div class="pcf-fp-head">' +
        '<strong>信息流过滤</strong>' +
        '<button type="button" class="pcf-fp-close" aria-label="关闭">×</button>' +
      '</div>' +
      '<label class="pcf-fp-field">' +
        '<span>屏蔽关键词<em>标题包含即隐藏，每行一个</em></span>' +
        '<textarea id="pcf-fp-keywords" rows="3" placeholder="例如：抽奖"></textarea>' +
      '</label>' +
      '<label class="pcf-fp-field">' +
        '<span>屏蔽作者<em>可写 @用户名，每行一个</em></span>' +
        '<textarea id="pcf-fp-authors" rows="2" placeholder="@用户名"></textarea>' +
      '</label>' +
      '<div class="pcf-fp-foot">' +
        '<button type="button" class="pcf-fp-btn" data-pcf-fp="clear">清空</button>' +
        '<button type="button" class="pcf-fp-btn pcf-fp-btn--primary" data-pcf-fp="save">保存并应用</button>' +
      '</div>';

    el.querySelector('.pcf-fp-close').addEventListener('click', closeFilterPop);
    el.querySelector('[data-pcf-fp="clear"]').addEventListener('click', () => {
      el.querySelector('#pcf-fp-keywords').value = '';
      el.querySelector('#pcf-fp-authors').value = '';
    });
    el.querySelector('[data-pcf-fp="save"]').addEventListener('click', () => {
      const next = {
        keywords: parseList(el.querySelector('#pcf-fp-keywords').value),
        authors: parseList(el.querySelector('#pcf-fp-authors').value)
      };
      filter = next;
      revealAll = false;
      try {
        chrome.storage.local.set({ [FILTER_KEY]: next });
      } catch (e) { /* 扩展上下文失效时忽略 */ }
      closeFilterPop();
      sync();
    });

    document.body.appendChild(el);
    return el;
  }

  function openFilterPop(anchor) {
    // 站点重渲染可能把浮层从 body 上摘掉，失效时重建
    if (!filterPop || !filterPop.isConnected) filterPop = buildFilterPop();
    filterPop.querySelector('#pcf-fp-keywords').value = filter.keywords.join('\n');
    filterPop.querySelector('#pcf-fp-authors').value = filter.authors.join('\n');
    filterPop.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');

    // 贴着按钮下方展开，右侧不够时向左收，底部不够时翻到按钮上方
    const rect = anchor.getBoundingClientRect();
    const width = filterPop.offsetWidth || 300;
    const height = filterPop.offsetHeight || 240;
    let left = rect.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    filterPop.style.left = left + 'px';
    filterPop.style.top = top + 'px';

    const input = filterPop.querySelector('#pcf-fp-keywords');
    if (input) input.focus();
  }

  function closeFilterPop() {
    if (!filterPop || filterPop.hidden) return;
    filterPop.hidden = true;
    const btn = document.querySelector('.pcf-filter-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleFilterPop(anchor) {
    if (filterPop && filterPop.isConnected && !filterPop.hidden) closeFilterPop();
    else openFilterPop(anchor);
  }

  // ============================ 5. 生命周期 ============================

  function boot() {
    try {
      chrome.storage.local.get([LAYOUT_KEY, FILTER_KEY], (raw) => {
        if (chrome.runtime.lastError) return;
        applyLayout(raw && raw[LAYOUT_KEY]);
        applyFilterCfg(raw && raw[FILTER_KEY]);
      });
    } catch (e) {
      applyLayout(null);
    }

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[LAYOUT_KEY]) applyLayout(changes[LAYOUT_KEY].newValue);
        if (changes[FILTER_KEY]) applyFilterCfg(changes[FILTER_KEY].newValue);
      });
    } catch (e) { /* noop */ }

    // 点空白处 / 按 Esc / 页面滚动时收起过滤浮层
    document.addEventListener('click', (e) => {
      if (!filterPop || filterPop.hidden) return;
      if (filterPop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.pcf-filter-btn')) return;
      closeFilterPop();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeFilterPop();
    });
    window.addEventListener('scroll', closeFilterPop, { passive: true });

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
