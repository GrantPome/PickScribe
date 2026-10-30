/**
 * 搜索页美化 —— 站点内容脚本（命名空间 pcs）
 *
 * 触发条件：站点搜索页 /search（可带 ?q= 与 ?category=），站内 SPA 跳转同样生效。
 *
 * 改造方式（只增强样式与布局，不接管站点业务逻辑）：
 *   1. 隐藏站点顶栏与左侧筛选栏，把结果区收进一条居中窄栏，四周留出大面积空白；
 *   2. 顶部插入「居中 LOGO + 大搜索框 + 筛选胶囊」；
 *   3. 搜索提交与筛选切换都代理给站点原有控件，因此仍走客户端路由，
 *      结果列表、分页、空状态等站点逻辑完全不变；
 *   4. 胶囊上的文案、数量、图标与选中态都从站点原控件实时同步，站点改版也能自动跟随。
 */

(() => {
  'use strict';

  // ============================ 0. 常量 ============================

  const SEARCH_PATH = '/search';
  const LOGO_LIGHT = '/images/brand/pickcat-logo-light.png';
  const LOGO_DARK = '/images/brand/pickcat-logo-dark.png';
  const FALLBACK_LABELS = ['全部', '帖子', '用户', '标签'];
  /** 与上面标签一一对应的 category 参数，仅在没有站点原控件时兜底使用 */
  const FALLBACK_CATEGORIES = ['', 'forum', 'users', 'tags'];
  const SYNC_INTERVAL = 500;
  /** 设置与搜索记录（与 options/options.js 的定义保持一致） */
  const SETTINGS_KEY = 'pcs_settings';
  const HISTORY_KEY = 'pcs_history';
  const DEFAULT_SETTINGS = { enabled: true, sticky: true, history: true, historyLimit: 8 };

  const SEL = {
    main: 'main',
    filters: 'aside[aria-label="搜索筛选"] nav[aria-label="搜索分类"] button',
    filtersMobile: '#mobile-top-bar-extra nav[aria-label="搜索分类"] button',
    siteSearch: 'header[role="banner"] input[role="searchbox"]',
    logo: 'header[role="banner"] a[aria-label="PICKCAT 首页"] img'
  };

  const ICONS = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>'
  };

  const HOME_BTN = 'pcs-searchtab';

  // ============================ 1. 工具 ============================

  let page = null;        // 注入的整块搜索页结构
  let inputEl = null;     // 大搜索框
  let formEl = null;      // 搜索框表单
  let formWrapEl = null;  // 搜索框外层（搜索记录面板的定位容器）
  let filtersEl = null;   // 筛选胶囊容器
  let statsEl = null;     // 结果条数
  let historyEl = null;   // 搜索记录容器
  let timer = null;
  let activeIdx = 0;
  let lastEmpty = null;   // 上一次的空状态，用于避免 tick 反复收起记录面板
  let settings = { ...DEFAULT_SETTINGS };
  let history = [];

  const isSearchPage = () => location.pathname === SEARCH_PATH || location.pathname.indexOf(SEARCH_PATH + '/') === 0;

  const currentQ = () => {
    try {
      return new URLSearchParams(location.search).get('q') || '';
    } catch (e) {
      return '';
    }
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** 站点自己的筛选按钮（桌面侧栏优先，移动端顶栏兜底） */
  function siteFilterButtons() {
    const desk = [...document.querySelectorAll(SEL.filters)];
    if (desk.length) return desk;
    return [...document.querySelectorAll(SEL.filtersMobile)];
  }

  // ============================ 2. 结构 ============================

  function brandSrc() {
    const imgs = [...document.querySelectorAll(SEL.logo)];
    const light = imgs.find((i) => /light/i.test(i.getAttribute('src') || ''));
    const dark = imgs.find((i) => /dark/i.test(i.getAttribute('src') || ''));
    return {
      light: (light && light.getAttribute('src')) || LOGO_LIGHT,
      dark: (dark && dark.getAttribute('src')) || LOGO_DARK
    };
  }

  function build() {
    const logo = brandSrc();
    const wrap = document.createElement('div');
    wrap.className = 'pcs-page';
    wrap.innerHTML =
      '<div class="pcs-topbar">' +
        '<a class="pcs-back" href="/">' + ICONS.back + '<span>返回社区</span></a>' +
        '<a class="pcs-sitelink" href="/works">作品广场</a>' +
      '</div>' +
      '<section class="pcs-hero" aria-label="社区搜索">' +
        '<a class="pcs-logo" href="/" aria-label="PICKCAT 首页">' +
          '<img class="pcs-logo-img pcs-logo-light" src="' + esc(logo.light) + '" alt="PICKCAT" />' +
          '<img class="pcs-logo-img pcs-logo-dark" src="' + esc(logo.dark) + '" alt="" aria-hidden="true" />' +
        '</a>' +
        '<div class="pcs-form-wrap">' +
          '<form class="pcs-form" role="search" autocomplete="off">' +
            '<span class="pcs-form-ico">' + ICONS.search + '</span>' +
            '<input class="pcs-input" type="search" name="q" placeholder="搜索帖子、用户和作品" ' +
              'autocomplete="off" spellcheck="false" aria-label="搜索帖子、用户和作品" />' +
            '<button class="pcs-submit" type="submit">查找</button>' +
          '</form>' +
          '<div class="pcs-history">' +
            '<div class="pcs-history-head">' +
              '<span class="pcs-history-title">最近搜索</span>' +
              '<button class="pcs-history-clear" type="button">清除</button>' +
            '</div>' +
            '<div class="pcs-history-list"></div>' +
          '</div>' +
        '</div>' +
        '<nav class="pcs-filters" aria-label="搜索分类"></nav>' +
        '<p class="pcs-stats" aria-live="polite"></p>' +
        '<p class="pcs-empty-hint">输入关键词，搜索社区里的帖子、用户与标签</p>' +
      '</section>';

    formEl = wrap.querySelector('.pcs-form');
    formWrapEl = wrap.querySelector('.pcs-form-wrap');
    inputEl = wrap.querySelector('.pcs-input');
    filtersEl = wrap.querySelector('.pcs-filters');
    statsEl = wrap.querySelector('.pcs-stats');
    historyEl = wrap.querySelector('.pcs-history');

    formEl.addEventListener('submit', onSubmit);
    inputEl.addEventListener('keydown', onInputKeydown);
    historyEl.addEventListener('click', onHistoryClick);

    // 点搜索框任意位置（含图标）都聚焦输入框，第一次点击就能直接输入
    formEl.addEventListener('pointerdown', (e) => {
      if (e.target === inputEl || e.target.closest('.pcs-submit')) return;
      e.preventDefault();
      inputEl.focus();
    });
    // 聚焦输入框时展开记录面板；离开搜索区后收起
    formEl.addEventListener('focusin', (e) => {
      if (e.target === inputEl) setHistoryOpen(true);
    });
    // 记录面板里的按钮不抢走输入框焦点，保证点击后仍可继续输入
    historyEl.addEventListener('mousedown', (e) => e.preventDefault());

    // 站点 LOGO 资源异常时退回文字，避免破图
    wrap.querySelectorAll('.pcs-logo-img').forEach((img) => {
      img.addEventListener('error', () => {
        const box = img.closest('.pcs-logo');
        if (box) box.classList.add('pcs-logo-broken');
      });
    });

    filtersEl.addEventListener('click', onFilterClick);
    return wrap;
  }

  /** 用站点原控件的文案 / 数量 / 图标渲染筛选胶囊 */
  function renderFilters(force) {
    if (!filtersEl) return;

    const siteBtns = siteFilterButtons();
    const sameCount = filtersEl.children.length === (siteBtns.length || FALLBACK_LABELS.length);
    if (!force && sameCount && filtersEl.children.length) return;

    let html = '';
    if (siteBtns.length) {
      siteBtns.forEach((btn, idx) => {
        const spans = btn.querySelectorAll('span');
        const label = ((spans[0] && spans[0].textContent) || btn.textContent || '').trim();
        const count = ((spans[1] && spans[1].textContent) || '').trim();
        const svg = btn.querySelector('svg');
        html += pillHtml(idx, label, count, svg ? svg.innerHTML : '');
      });
    } else {
      FALLBACK_LABELS.forEach((label, idx) => {
        html += pillHtml(idx, label, '', '');
      });
    }

    filtersEl.innerHTML = html;
  }

  function pillHtml(idx, label, count, iconInner) {
    return '<button type="button" class="pcs-filter" data-idx="' + idx + '" aria-pressed="false">' +
      (iconInner ? '<span class="pcs-filter-ico"><svg viewBox="0 0 24 24" aria-hidden="true">' + iconInner + '</svg></span>' : '') +
      '<span class="pcs-filter-label">' + esc(label) + '</span>' +
      '<span class="pcs-count">' + esc(count) + '</span>' +
      '</button>';
  }

  // ============================ 3. 同步 ============================

  /** 让胶囊的选中态与数量跟随站点原控件 */
  function syncFilters() {
    if (!filtersEl) return;
    const siteBtns = siteFilterButtons();
    const pills = [...filtersEl.children];

    if (siteBtns.length) {
      if (pills.length !== siteBtns.length) renderFilters(true);
      siteBtns.forEach((btn, idx) => {
        const pill = filtersEl.children[idx];
        if (!pill) return;
        const on = btn.getAttribute('aria-pressed') === 'true';
        if (on) activeIdx = idx;
        pill.classList.toggle('is-on', on);
        pill.setAttribute('aria-pressed', on ? 'true' : 'false');

        const spans = btn.querySelectorAll('span');
        const countEl = pill.querySelector('.pcs-count');
        const count = ((spans[1] && spans[1].textContent) || '').trim();
        if (countEl && countEl.textContent !== count) countEl.textContent = count;
      });
    } else {
      // 站点控件暂未渲染时，用 URL 里的 category 兜底
      const cat = new URLSearchParams(location.search).get('category') || '';
      const idx = Math.max(0, FALLBACK_CATEGORIES.indexOf(cat));
      activeIdx = idx;
      pills.forEach((pill, i) => {
        const on = i === idx;
        pill.classList.toggle('is-on', on);
        pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    updateStats();
  }

  /** 结果条数：跟搜索框下方的筛选数量保持一致，形成搜索引擎式的「约 N 个结果」 */
  function updateStats() {
    if (!statsEl) return;
    if (!currentQ()) {
      statsEl.textContent = '';
      return;
    }

    const nums = siteFilterButtons().map((btn) => {
      const spans = btn.querySelectorAll('span');
      const raw = spans[1] ? spans[1].textContent : '';
      const n = parseInt(String(raw).replace(/[^\d]/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    });

    let n = null;
    if (nums.length) {
      if (activeIdx === 0) n = nums.reduce((sum, v) => sum + (v || 0), 0);
      else n = nums[activeIdx];
    }

    statsEl.textContent = n == null ? '' : '约 ' + n + ' 个结果';
  }

  function syncInput(q) {
    if (!inputEl) return;
    // 用户正在输入时不覆盖内容
    if (document.activeElement === inputEl) return;
    if (inputEl.value === q) return;
    inputEl.value = q;
  }

  // ============================ 3.1 设置与搜索记录 ============================

  const storageAlive = () => {
    try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; }
  };

  async function loadStore() {
    if (!storageAlive()) return;
    try {
      const raw = await chrome.storage.local.get([SETTINGS_KEY, HISTORY_KEY]);
      settings = { ...DEFAULT_SETTINGS, ...(raw[SETTINGS_KEY] || {}) };
      history = cleanHistory(raw[HISTORY_KEY]);
    } catch (e) {
      /* 扩展重载后上下文可能失效，按默认设置工作即可 */
    }
  }

  function cleanHistory(list) {
    const cap = Math.max(1, Number(settings.historyLimit) || DEFAULT_SETTINGS.historyLimit);
    if (!Array.isArray(list)) return [];
    return list.filter((s) => typeof s === 'string' && s.trim()).slice(0, cap);
  }

  function saveHistory() {
    if (!storageAlive()) return;
    try { chrome.storage.local.set({ [HISTORY_KEY]: history }); } catch (e) { /* 忽略 */ }
  }

  /** 记一条搜索词：去重后置顶，按设置的条数截断 */
  function rememberQuery(q) {
    if (!settings.history || !q) return;
    const key = q.toLowerCase();
    history = [q].concat(history.filter((s) => s.toLowerCase() !== key));
    history = history.slice(0, Math.max(1, Number(settings.historyLimit) || DEFAULT_SETTINGS.historyLimit));
    saveHistory();
    renderHistory();
  }

  /** 记录面板：只在聚焦搜索框时展开，且设置开启并确有记录 */
  function setHistoryOpen(open) {
    if (!historyEl) return;
    historyEl.classList.toggle('is-open', !!open && !!settings.history && history.length > 0);
  }

  function renderHistory() {
    if (!historyEl) return;
    const list = historyEl.querySelector('.pcs-history-list');
    if (list) {
      list.innerHTML = settings.history
        ? history.map((q) =>
            '<button type="button" class="pcs-chip" data-q="' + esc(q) + '" title="' + esc(q) + '">' + esc(q) + '</button>'
          ).join('')
        : '';
    }
    if (!settings.history || !history.length) setHistoryOpen(false);
  }

  function onHistoryClick(e) {
    const chip = e.target.closest('.pcs-chip');
    if (chip) {
      const q = chip.getAttribute('data-q') || '';
      if (inputEl) inputEl.value = q;
      setHistoryOpen(false);
      runSearch(q);
      return;
    }
    if (e.target.closest('.pcs-history-clear')) {
      history = [];
      saveHistory();
      renderHistory();
      if (inputEl) inputEl.focus();
    }
  }

  /** 吸顶判定：结果态下顶栏一旦贴到视口顶部就加阴影，靠 CSS 的 sticky 完成固定 */
  function updateStuck() {
    const hero = page && page.querySelector('.pcs-hero');
    const on = !!hero
      && document.documentElement.classList.contains('pcs-result')
      && document.documentElement.classList.contains('pcs-sticky')
      && hero.getBoundingClientRect().top <= 0.5;
    document.documentElement.classList.toggle('pcs-stuck', on);
  }

  /** 设置变化后即时生效：总开关、吸顶、搜索记录 */
  function applySettings() {
    if (!settings.enabled) {
      unmount();
      clearHomeSearch();
      return;
    }
    document.documentElement.classList.toggle('pcs-sticky', isSearchPage() && !!settings.sticky);
    renderHistory();
    tick();
    updateStuck();
  }

  function setEmptyState(empty) {
    document.documentElement.classList.toggle('pcs-empty', empty);
    document.documentElement.classList.toggle('pcs-result', !empty);
    // 只有空状态 / 结果状态真的切换时才收起记录面板（tick 会反复调用本函数）
    if (lastEmpty !== empty) setHistoryOpen(false);
    lastEmpty = empty;
    updateStuck();
  }

  // ============================ 4. 交互（代理给站点） ============================

  function onSubmit(e) {
    e.preventDefault();
    runSearch(inputEl.value);
  }

  function runSearch(raw) {
    const q = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!q) {
      inputEl.focus();
      return;
    }

    setHistoryOpen(false);
    rememberQuery(q);

    const siteInput = document.querySelector(SEL.siteSearch);
    if (siteInput) {
      // 走站点自己的搜索框：先同步 value（原生 setter 才能触发 Vue 的 v-model），
      // 再模拟回车，让 Nuxt 客户端路由完成跳转，不整页刷新。
      try {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(siteInput, q);
        siteInput.dispatchEvent(new Event('input', { bubbles: true }));
        siteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        siteInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      } catch (err) {
        /* 兜底走下方地址跳转 */
      }
    }

    // 站点控件缺失或代理未生效时，退化为普通跳转
    const before = location.pathname + location.search;
    setTimeout(() => {
      if (location.pathname + location.search === before) {
        location.assign(SEARCH_PATH + '?q=' + encodeURIComponent(q));
      }
    }, 700);
  }

  function onInputKeydown(e) {
    if (e.key === 'Escape') {
      setHistoryOpen(false);
      inputEl.value = '';
      inputEl.blur();
    }
  }

  function onFilterClick(e) {
    const pill = e.target.closest('.pcs-filter');
    if (!pill) return;
    const idx = Number(pill.dataset.idx) || 0;

    // 先乐观更新选中态，站点路由完成后再由 syncFilters 校正
    activeIdx = idx;
    [...filtersEl.children].forEach((el, i) => {
      el.classList.toggle('is-on', i === idx);
      el.setAttribute('aria-pressed', i === idx ? 'true' : 'false');
    });

    const siteBtns = siteFilterButtons();
    if (siteBtns[idx]) {
      siteBtns[idx].click();
      return;
    }

    const q = currentQ();
    const cat = FALLBACK_CATEGORIES[idx] || '';
    let url = SEARCH_PATH;
    if (q) url += '?q=' + encodeURIComponent(q) + (cat ? '&category=' + cat : '');
    else if (cat) url += '?category=' + cat;
    location.assign(url);
  }

  // ============================ 5. 挂载 / 卸载 ============================

  /**
   * 非搜索页：把站点顶栏里的搜索输入框换成「搜索」按钮，点击进入美化后的搜索页。
   * 原输入框只做隐藏不删除，站点组件与布局逻辑保持原样。
   */
  function syncHomeSearch() {
    const heads = [...document.querySelectorAll('header[role="banner"]')];

    heads.forEach((head) => {
      const form = head.querySelector('form[role="search"]');
      const btn = head.querySelector('.' + HOME_BTN);
      if (!form) {
        if (btn) btn.remove();
        return;
      }
      form.classList.add('pcs-searchtab-orig');
      if (btn) return;

      const next = document.createElement('a');
      next.href = SEARCH_PATH;
      next.className = HOME_BTN;
      next.setAttribute('role', 'button');
      next.setAttribute('aria-label', '搜索');
      next.innerHTML = ICONS.search + '<span>搜索</span>';
      form.parentNode.insertBefore(next, form);
    });

    // 站点重渲染后可能留下没有对应输入框的孤立按钮
    document.querySelectorAll('.' + HOME_BTN).forEach((btn) => {
      if (!btn.closest('header[role="banner"]')) btn.remove();
    });

    document.documentElement.classList.toggle('pcs-home-search', !!document.querySelector('.' + HOME_BTN));
  }

  function clearHomeSearch() {
    document.querySelectorAll('.' + HOME_BTN).forEach((btn) => btn.remove());
    document.querySelectorAll('form.pcs-searchtab-orig').forEach((form) => form.classList.remove('pcs-searchtab-orig'));
    document.documentElement.classList.remove('pcs-home-search');
  }

  function attach() {
    if (!settings.enabled) return false;

    const main = document.querySelector(SEL.main);
    if (!main) return false;

    document.documentElement.classList.add('pcs-search');
    document.documentElement.classList.toggle('pcs-sticky', !!settings.sticky);

    if (!page) page = build();
    if (!page.isConnected) main.insertBefore(page, main.firstChild);

    const q = currentQ();
    setEmptyState(!q);
    renderFilters(false);
    syncInput(q);
    syncFilters();
    renderHistory();
    return true;
  }

  function unmount() {
    document.documentElement.classList.remove('pcs-search', 'pcs-empty', 'pcs-result', 'pcs-stuck', 'pcs-sticky');
    if (page && page.parentNode) page.parentNode.removeChild(page);
    page = null;
    inputEl = null;
    formEl = null;
    formWrapEl = null;
    filtersEl = null;
    statsEl = null;
    historyEl = null;
  }

  function tick() {
    if (!isSearchPage()) {
      if (page || document.documentElement.classList.contains('pcs-search')) unmount();
      if (settings.enabled) syncHomeSearch();
      else clearHomeSearch();
      return;
    }
    // 搜索页不再需要顶栏的搜索按钮
    clearHomeSearch();
    if (!settings.enabled) {
      if (page || document.documentElement.classList.contains('pcs-search')) unmount();
      return;
    }
    attach();
  }

  // ============================ 6. 启动 ============================

  if (window.__pickscribeSearchLoaded) return;
  window.__pickscribeSearchLoaded = true;

  // 扩展被重载后旧脚本里的 chrome.* 调用会报 context invalidated，属预期噪音
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  // 站内 SPA 跳转靠 history.pushState / replaceState 完成，这里轻量包一层，
  // 路由一变就立即同步，避免出现「顶栏先闪一下再被收起」。
  ['pushState', 'replaceState'].forEach((name) => {
    const original = history[name];
    if (typeof original !== 'function' || original.__pcsHooked) return;
    const wrapped = function () {
      const result = original.apply(this, arguments);
      setTimeout(tick, 0);
      return result;
    };
    wrapped.__pcsHooked = true;
    history[name] = wrapped;
  });

  // 先立即判断一次并加类，避免站点顶栏在搜索页闪一下再消失
  if (isSearchPage()) {
    document.documentElement.classList.add('pcs-search');
    if (currentQ()) document.documentElement.classList.add('pcs-result');
  }

  timer = setInterval(tick, SYNC_INTERVAL);
  window.addEventListener('popstate', tick);
  document.addEventListener('scroll', updateStuck, true);

  // 站点在搜索页有「点搜索区就聚焦它自己搜索框」的行为，而原搜索框已被隐藏，
  // 会导致第一次点击落在空处、要再点一次才能输入。这里在捕获阶段拦下并直接聚焦新搜索框。
  document.addEventListener('pointerdown', (e) => {
    if (!page || !inputEl) return;

    if (formEl && formEl.contains(e.target)) return;
    if (formWrapEl && formWrapEl.contains(e.target)) return;

    const r = formEl ? formEl.getBoundingClientRect() : null;
    const onForm = r
      && e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;

    if (onForm) {
      e.preventDefault();
      e.stopPropagation();
      inputEl.focus();
      return;
    }
    setHistoryOpen(false);
  }, true);

  // 兜底：若站点仍把焦点塞回被隐藏的原搜索框，立刻收回到新搜索框
  document.addEventListener('focusin', (e) => {
    if (!page || !inputEl) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || page.contains(t) || !t.matches(SEL.siteSearch)) return;
    if (t.getClientRects().length) return;
    t.blur();
    inputEl.focus();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  // 设置 / 搜索记录改完即时生效（设置页改动不用刷新搜索页）
  if (storageAlive()) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SETTINGS_KEY]) {
          settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
          applySettings();
        }
        if (changes[HISTORY_KEY]) {
          history = cleanHistory(changes[HISTORY_KEY].newValue);
          renderHistory();
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  // 先按默认设置把页面跑起来，读到真实设置后再校正（关闭时立即卸载）
  loadStore().then(() => applySettings());
})();
