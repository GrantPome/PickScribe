/**
 * 信息流右侧小组件 —— 内容脚本（命名空间 pcw）
 *
 * 结构：不再把小组件包在一块独立面板里，而是让每张小组件卡片成为
 *      "右侧栏板块堆叠容器" 的直接子节点，和站点原有板块同级。
 *      这样小组件可以和原站板块互相插入、一起拖拽排序。
 *
 * 关键做法：
 *   - 站点板块保持原 DOM 位置，只用 CSS order 改变视觉顺序，避免破坏 Vue 的节点树；
 *   - 小组件卡片同样用 order 排序，宽度用 flex-basis 控制 1/2 列；
 *   - 站点板块的拖拽手柄由一层绝对定位的 overlay 提供，不往站点节点里插按钮；
 *   - 排序结果写入 pcw_board.order，站点板块用 aria-label / href / 文本生成稳定 key；
 *   - 站点重渲染后按 key 重新套用顺序，离开信息流页或关闭开关时还原站点右栏。
 *
 * 间距规则（与站点一致）：
 *   站点板块之间 24px；小组件之间 10px；小组件后接站点板块时补 14px，
 *   合计仍是 24px；最后一项去掉底部间距。
 */

(() => {
  'use strict';

  // ============================ 0. 常量 ============================

  /** 设置键：小组件布局与右栏顺序 */
  const BOARD_KEY = 'pcw_board';
  /** 视为信息流页面的路径：与 feed/content.js 保持一致 */
  const FEED_PATH = /^\/$|^\/forum\/?$|^\/forum\/category\/[^/?#]+\/?$/;
  /** 右侧栏根节点 */
  const ASIDE_SEL = 'main aside';
  /** 网格尺寸：必须与 widgets.css 保持一致 */
  const ROW_H = 72;
  const ROW_GAP = 10;
  const MAX_COLS = 2;

  const ICONS = {
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    grip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M9 6h.01"/><path d="M15 6h.01"/><path d="M9 12h.01"/><path d="M15 12h.01"/>' +
      '<path d="M9 18h.01"/><path d="M15 18h.01"/></svg>',
    close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    check: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m20 6-11 11-5-5"/></svg>',
    pencil: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    done: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m20 6-11 11-5-5"/></svg>'
  };

  // ============================ 1. 组件注册表 ============================

  const WIDGETS = {
    weather: {
      name: '天气',
      desc: '当前天气与今日高低温',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 4 },
      defaultSpan: { w: 2, h: 3 },
      settings: () => Object.assign({}, DEFAULT_CITY, { data: null, fetchedAt: 0, error: '' }),
      normalize: normalizeWeather,
      render: renderWeather,
      afterRender(card, item) { refreshWeather(item, false); }
    },
    countdown: {
      name: '倒数日',
      desc: '距离重要日子还有几天',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 4 },
      defaultSpan: { w: 2, h: 2 },
      settings: () => ({ items: [] }),
      normalize: normalizeCountdown,
      render: renderCountdown
    },
    note: {
      name: '便签',
      desc: '随手记一段文字',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 5 },
      defaultSpan: { w: 2, h: 3 },
      settings: () => ({ text: '' }),
      normalize: normalizeNote,
      render: renderNote
    },
    todo: {
      name: '待办',
      desc: '勾掉今天要做的事',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 5 },
      defaultSpan: { w: 2, h: 4 },
      settings: () => ({ items: [] }),
      normalize: normalizeTodo,
      render: renderTodo
    },
    feed: {
      name: '信息流速览',
      desc: '当前页面前五条帖子',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 5 },
      defaultSpan: { w: 2, h: 3 },
      settings: () => ({ items: [], fetchedAt: 0 }),
      normalize: normalizeFeed,
      render: renderFeed,
      afterRender(card, item) { refreshFeed(item, false); }
    },
    mystats: {
      name: '我的数据',
      desc: '等级、小鱼干与社区统计',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 4 },
      defaultSpan: { w: 2, h: 3 },
      settings: () => ({ data: null, fetchedAt: 0, error: '' }),
      normalize: normalizeStats,
      render: renderStats,
      afterRender(card, item) { refreshStats(item, false); }
    },
    notify: {
      name: '未读通知',
      desc: '站内未读条数',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 3 },
      defaultSpan: { w: 1, h: 2 },
      settings: () => ({ count: 0, fetchedAt: 0, error: '' }),
      normalize: normalizeNotify,
      render: renderNotify,
      afterRender(card, item) { refreshNotify(item, false); }
    },
    heatmap: {
      name: '发帖热力图',
      desc: '最近 5 周的发帖活跃度',
      minSpan: { w: 1, h: 2 },
      maxSpan: { w: 2, h: 4 },
      defaultSpan: { w: 2, h: 3 },
      settings: () => ({ days: {}, fetchedAt: 0, error: '' }),
      normalize: normalizeHeatmap,
      render: renderHeatmap,
      afterRender(card, item) { refreshHeatmap(item, false); }
    }
  };

  // ============================ 2. 工具函数 ============================

  function isFeedPage() {
    return FEED_PATH.test(location.pathname || '/');
  }

  let idSeq = 0;
  function makeId(type) {
    idSeq += 1;
    return type + '-' + Date.now().toString(36) + '-' + idSeq;
  }

  function clampSpan(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeSpan(span, def) {
    const s = span && typeof span === 'object' ? span : {};
    const maxW = Math.min(def.maxSpan.w, MAX_COLS);
    return {
      w: clampSpan(s.w, def.minSpan.w, maxW, def.defaultSpan.w),
      h: clampSpan(s.h, def.minSpan.h, def.maxSpan.h, def.defaultSpan.h)
    };
  }

  /** 组件卡片高度：h 行 + 行间距 */
  function widgetHeight(h) {
    return h * ROW_H + (h - 1) * ROW_GAP;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  /** 目标日期与今天相差的自然天数（正数=未来） */
  function dayDiff(dateStr, todayMs) {
    const p = dateStr.split('-').map(Number);
    return Math.round((new Date(p[0], p[1] - 1, p[2]).getTime() - todayMs) / 86400000);
  }

  /** 倒数日设置统一收口：丢掉空标题、非法日期与重复 id */
  function normalizeCountdown(raw) {
    const src = raw && Array.isArray(raw.items) ? raw.items : [];
    const items = [];
    const used = new Set();
    src.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const title = typeof it.title === 'string' ? it.title.trim().slice(0, 24) : '';
      const date = typeof it.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : '';
      if (!title || !date) return;
      let id = typeof it.id === 'string' && it.id ? it.id : makeId('cd');
      if (used.has(id)) id = makeId('cd');
      used.add(id);
      items.push({ id, title, date });
    });
    return { items };
  }

  // ---------- 2.1 组件实现：通用 ----------

  const DEFAULT_CITY = { city: '北京', lat: 39.9042, lon: 116.4074 };
  const WEATHER_TTL = 30 * 60 * 1000;
  const STATS_TTL = 5 * 60 * 1000;
  const NOTIFY_TTL = 2 * 60 * 1000;
  const FEED_TTL = 2 * 60 * 1000;

  /** WMO 天气代码 → 中文描述 */
  const WMO_TEXT = {
    0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '阵雪',
    95: '雷阵雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹'
  };

  /** 随机雨滴：位置、长短、速度、透明度都不同 */
  function rainParticles() {
    let out = '';
    for (let i = 0; i < 24; i += 1) {
      const left = (Math.random() * 96).toFixed(1);
      const h = Math.round(7 + Math.random() * 9);
      const d = (0.55 + Math.random() * 0.55).toFixed(2);
      const dl = (-Math.random() * 1.2).toFixed(2);
      const sx = Math.round(-55 + Math.random() * 35);
      const o = (0.22 + Math.random() * 0.35).toFixed(2);
      out += '<i class="pcw-wx-drop" style="left:' + left + '%;--h:' + h + 'px;--d:' +
        d + 's;--dl:' + dl + 's;--sx:' + sx + 'px;--o:' + o + '"></i>';
    }
    return out;
  }

  /** 随机雪花：大小、下落速度、横向漂移都不同 */
  function snowParticles() {
    let out = '';
    for (let i = 0; i < 20; i += 1) {
      const left = (Math.random() * 96).toFixed(1);
      const s = (1.6 + Math.random() * 2.6).toFixed(1);
      const d = (6 + Math.random() * 7).toFixed(1);
      const dl = (-Math.random() * 12).toFixed(1);
      const dx = Math.round(-14 + Math.random() * 28);
      const o = (0.5 + Math.random() * 0.4).toFixed(2);
      out += '<i class="pcw-wx-flake" style="left:' + left + '%;--s:' + s + 'px;--d:' +
        d + 's;--dl:' + dl + 's;--dx:' + dx + 'px;--o:' + o + '"></i>';
    }
    return out;
  }

  /** 天气代码 → 卡片动效分组 */
  function weatherGroup(code) {
    if (code === null || code === undefined) return '';
    const c = Number(code);
    if (c === 0 || c === 1) return 'clear';
    if (c === 2) return 'cloud';
    if (c === 3) return 'overcast';
    if (c === 45 || c === 48) return 'fog';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
    if (c >= 95) return 'storm';
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
    return '';
  }

  function roundOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  /** 12345 → 1.2 万 */
  function formatNum(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) < 10000) return String(n);
    return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  }

  /** 默认同源带 Cookie；跨域（天气）不带凭据，兼容 Access-Control-Allow-Origin: * */
  async function fetchJson(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, Object.assign({
        headers: { Accept: 'application/json' },
        signal: ctrl.signal
      }, opts || {}));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function itemOf(el) {
    if (!el) return null;
    const card = el.classList && el.classList.contains('pcw-card')
      ? el
      : (el.closest ? el.closest('.pcw-card') : null);
    return card ? findItem(card.getAttribute('data-id')) : null;
  }

  // ---------- 2.2 天气 ----------

  let weatherPending = new Set();

  function normalizeWeather(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    const d = s.data && typeof s.data === 'object' ? s.data : null;
    return {
      city: typeof s.city === 'string' && s.city.trim() ? s.city.trim().slice(0, 24) : DEFAULT_CITY.city,
      lat: Number.isFinite(lat) ? lat : DEFAULT_CITY.lat,
      lon: Number.isFinite(lon) ? lon : DEFAULT_CITY.lon,
      data: d ? {
        temp: roundOrNull(d.temp),
        max: roundOrNull(d.max),
        min: roundOrNull(d.min),
        humidity: roundOrNull(d.humidity),
        wind: roundOrNull(d.wind),
        code: roundOrNull(d.code)
      } : null,
      fetchedAt: Number(s.fetchedAt) || 0,
      error: typeof s.error === 'string' ? s.error.slice(0, 40) : ''
    };
  }

  function refreshWeather(item, force) {
    const s = item.settings;
    if (weatherPending.has(item.id)) return;
    if (!force && s.fetchedAt && Date.now() - s.fetchedAt < WEATHER_TTL) return;

    weatherPending.add(item.id);
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(s.lat) +
      '&longitude=' + encodeURIComponent(s.lon) +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';

    fetchJson(url, { credentials: 'omit' })
      .then((data) => {
        const cur = (data && data.current) || {};
        const daily = (data && data.daily) || {};
        const next = {
          temp: roundOrNull(cur.temperature_2m),
          humidity: roundOrNull(cur.relative_humidity_2m),
          code: roundOrNull(cur.weather_code),
          wind: roundOrNull(cur.wind_speed_10m),
          max: roundOrNull((daily.temperature_2m_max || [])[0]),
          min: roundOrNull((daily.temperature_2m_min || [])[0])
        };
        if (next.temp === null) throw new Error('empty weather');
        item.settings.data = next;
        item.settings.fetchedAt = Date.now();
        item.settings.error = '';
      })
      .catch(() => {
        item.settings.error = '天气获取失败，点刷新重试';
      })
      .finally(() => {
        weatherPending.delete(item.id);
        saveBoard();
        renderCard(item);
      });
  }

  function searchCity(item, raw) {
    const name = String(raw || '').trim().slice(0, 20);
    if (!name) return;
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=' +
      encodeURIComponent(name);

    fetchJson(url, { credentials: 'omit' })
      .then((data) => {
        const hit = data && Array.isArray(data.results) ? data.results[0] : null;
        if (!hit || !Number.isFinite(Number(hit.latitude))) {
          item.settings.error = '没找到「' + name + '」';
          renderCard(item);
          return;
        }
        item.settings.city = hit.name || name;
        item.settings.lat = Number(hit.latitude);
        item.settings.lon = Number(hit.longitude);
        item.settings.data = null;
        item.settings.fetchedAt = 0;
        item.settings.error = '';
        saveBoard();
        renderCard(item);
        refreshWeather(item, true);
      })
      .catch(() => {
        item.settings.error = '城市搜索失败，检查网络后重试';
        renderCard(item);
      });
  }

  function locateWeather(item) {
    if (!navigator.geolocation) {
      item.settings.error = '当前环境不支持定位';
      renderCard(item);
      return;
    }
    item.settings.error = '正在定位…';
    renderCard(item);

    navigator.geolocation.getCurrentPosition((pos) => {
      item.settings.city = '当前位置';
      item.settings.lat = Math.round(pos.coords.latitude * 10000) / 10000;
      item.settings.lon = Math.round(pos.coords.longitude * 10000) / 10000;
      item.settings.data = null;
      item.settings.fetchedAt = 0;
      item.settings.error = '';
      saveBoard();
      renderCard(item);
      refreshWeather(item, true);
    }, () => {
      item.settings.error = '定位失败，可手动搜索城市';
      renderCard(item);
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 });
  }

  function renderWeather(body, item) {
    const s = item.settings;
    const d = s.data;
    const cond = d && d.code !== null ? (WMO_TEXT[d.code] || '—') : '';
    const temp = d && d.temp !== null ? d.temp + '°' : '--°';
    const group = d ? weatherGroup(d.code) : '';

    // 按天气类型往卡片上铺一层动效背景（云、雨、雪、雾、闪电）
    const card = body.closest('.pcw-card');
    if (card) {
      card.querySelectorAll('.pcw-wx-sky').forEach((node) => node.remove());
      if (group) {
        const rainy = group === 'rain' || group === 'storm';
        const snowy = group === 'snow';
        card.setAttribute('data-wx', group);
        card.insertAdjacentHTML('afterbegin',
          '<div class="pcw-wx-sky" aria-hidden="true">' +
            '<span class="pcw-wx-sun"></span>' +
            '<span class="pcw-wx-cloud pcw-wx-cloud--a"></span>' +
            '<span class="pcw-wx-cloud pcw-wx-cloud--b"></span>' +
            '<span class="pcw-wx-cloud pcw-wx-cloud--c"></span>' +
            '<span class="pcw-wx-rain">' + (rainy ? rainParticles() : '') + '</span>' +
            '<span class="pcw-wx-snow">' + (snowy ? snowParticles() : '') + '</span>' +
            '<span class="pcw-wx-fog"></span>' +
            '<span class="pcw-wx-flash"></span>' +
          '</div>');
      } else {
        card.removeAttribute('data-wx');
      }
    }

    const foot = d
      ? '<div class="pcw-wx-foot">' +
          '<span>最高 <b>' + (d.max === null ? '—' : d.max + '°') + '</b></span>' +
          '<span>最低 <b>' + (d.min === null ? '—' : d.min + '°') + '</b></span>' +
          '<span>湿度 <b>' + (d.humidity === null ? '—' : d.humidity + '%') + '</b></span>' +
        '</div>'
      : '<div class="pcw-wx-foot is-empty">' + escapeHtml(s.error || '正在获取天气…') + '</div>';

    body.innerHTML =
      '<div class="pcw-widget pcw-wx">' +
        '<div class="pcw-widget-head">' +
          '<span class="pcw-wx-city" title="' + escapeHtml(s.city) + '">' + escapeHtml(s.city) + '</span>' +
          '<button type="button" class="pcw-icon-btn" data-pcw-act="wx-refresh" ' +
            'title="刷新天气" aria-label="刷新天气">' + ICONS.refresh + '</button>' +
        '</div>' +
        '<div class="pcw-wx-main">' +
          '<span class="pcw-wx-temp">' + temp + '</span>' +
          (cond ? '<span class="pcw-wx-cond">' + cond + '</span>' : '') +
        '</div>' +
        foot +
        '<div class="pcw-wx-edit">' +
          '<input class="pcw-input" data-wx-city maxlength="20" placeholder="城市，如 杭州" aria-label="城市名称" />' +
          '<button type="button" class="pcw-mini-btn" data-pcw-act="wx-search">搜索</button>' +
          '<button type="button" class="pcw-mini-btn" data-pcw-act="wx-geo">定位</button>' +
        '</div>' +
      '</div>';
  }

  // ---------- 2.3 倒数日 ----------

  function renderCountdown(body, item) {
    const list = (item.settings.items || []).slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    const today = startOfToday();

    const rows = list.map((it) => {
      const diff = dayDiff(it.date, today);
      let label = '';
      if (diff > 1) label = '<b>' + diff + '</b><i>天</i>';
      else if (diff === 1) label = '<span class="pcw-cd-text">明天</span>';
      else if (diff === 0) label = '<span class="pcw-cd-text">今天</span>';
      else if (diff === -1) label = '<span class="pcw-cd-text">昨天</span>';
      else label = '<b>' + (-diff) + '</b><i>天前</i>';

      return '<div class="pcw-cd-row">' +
        '<div class="pcw-cd-info">' +
          '<span class="pcw-cd-title" title="' + escapeHtml(it.title) + '">' + escapeHtml(it.title) + '</span>' +
          '<span class="pcw-cd-date">' + it.date + '</span>' +
        '</div>' +
        '<span class="pcw-cd-days">' + label + '</span>' +
        '<button type="button" class="pcw-cd-del" data-pcw-act="cd-del" ' +
          'data-cd-id="' + it.id + '" title="删除" aria-label="删除倒数日">' + ICONS.close + '</button>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="pcw-widget pcw-cd' + (list.length === 1 ? ' is-single' : '') + '">' +
        '<div class="pcw-widget-head"><span class="pcw-caption">倒数日</span></div>' +
        '<div class="pcw-cd-list">' +
          (rows || '<span class="pcw-empty">还没有倒数日，点「自定义」后添加</span>') +
        '</div>' +
        '<div class="pcw-cd-edit">' +
          '<input class="pcw-input" data-cd-title maxlength="24" placeholder="名称" aria-label="倒数日名称" />' +
          '<input class="pcw-input" data-cd-date type="date" aria-label="倒数日日期" />' +
          '<button type="button" class="pcw-mini-btn" data-pcw-act="cd-add">添加</button>' +
        '</div>' +
      '</div>';
  }

  // ---------- 2.4 便签 ----------

  function normalizeNote(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return { text: typeof s.text === 'string' ? s.text.slice(0, 2000) : '' };
  }

  function renderNote(body, item) {
    body.innerHTML =
      '<div class="pcw-widget pcw-note">' +
        '<textarea class="pcw-note-input" data-note maxlength="2000" ' +
          'placeholder="随手记点什么…" aria-label="便签">' +
          escapeHtml(item.settings.text || '') +
        '</textarea>' +
      '</div>';
  }

  // ---------- 2.5 待办 ----------

  function normalizeTodo(raw) {
    const src = raw && Array.isArray(raw.items) ? raw.items : [];
    const items = [];
    const used = new Set();
    src.slice(0, 50).forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const text = typeof it.text === 'string' ? it.text.trim().slice(0, 60) : '';
      if (!text) return;
      let id = typeof it.id === 'string' && it.id ? it.id : makeId('td');
      if (used.has(id)) id = makeId('td');
      used.add(id);
      items.push({ id, text, done: !!it.done });
    });
    return { items };
  }

  function renderTodo(body, item) {
    const items = item.settings.items || [];
    const doneCount = items.filter((it) => it.done).length;

    const rows = items.map((it) =>
      '<div class="pcw-todo-row' + (it.done ? ' is-done' : '') + '">' +
        '<button type="button" class="pcw-todo-check" data-pcw-act="todo-toggle" ' +
          'data-todo-id="' + it.id + '" aria-pressed="' + (it.done ? 'true' : 'false') + '" ' +
          'aria-label="标记完成">' + (it.done ? ICONS.check : '') + '</button>' +
        '<span class="pcw-todo-text">' + escapeHtml(it.text) + '</span>' +
        '<button type="button" class="pcw-todo-del" data-pcw-act="todo-del" ' +
          'data-todo-id="' + it.id + '" title="删除" aria-label="删除待办">' + ICONS.close + '</button>' +
      '</div>'
    ).join('');

    body.innerHTML =
      '<div class="pcw-widget pcw-todo">' +
        '<div class="pcw-widget-head">' +
          '<span class="pcw-caption">待办</span>' +
          '<span class="pcw-caption">' + doneCount + '/' + items.length + '</span>' +
        '</div>' +
        '<div class="pcw-todo-list">' +
          (rows || '<span class="pcw-empty">还没有待办</span>') +
        '</div>' +
        '<div class="pcw-todo-add">' +
          '<input class="pcw-input" data-todo-input maxlength="60" placeholder="添加待办…" aria-label="添加待办" />' +
          '<button type="button" class="pcw-mini-btn" data-pcw-act="todo-add">添加</button>' +
        '</div>' +
      '</div>';
  }

  // ---------- 2.6 信息流速览 ----------

  function normalizeFeed(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const src = Array.isArray(s.items) ? s.items : [];
    const items = [];
    src.slice(0, 6).forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const href = typeof it.href === 'string' && /^\/forum\/post\//.test(it.href) ? it.href : '';
      const title = typeof it.title === 'string'
        ? it.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      if (!href || !title) return;
      items.push({ href, title });
    });
    return { items, fetchedAt: Number(s.fetchedAt) || 0 };
  }

  /** 从当前信息流页面抓前五条帖子链接，只读 DOM，不发请求 */
  function readFeedLinks() {
    let links = document.querySelectorAll('article[data-slot="root"] a[href*="/forum/post/"]');
    if (!links.length) links = document.querySelectorAll('main a[href*="/forum/post/"]');

    const out = [];
    const seen = new Set();
    for (let i = 0; i < links.length && out.length < 5; i += 1) {
      const a = links[i];
      const href = a.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 4) continue;
      seen.add(href);
      out.push({ href, title: title.slice(0, 80) });
    }
    return out;
  }

  function refreshFeed(item, force) {
    const s = item.settings;
    if (!force && s.fetchedAt && Date.now() - s.fetchedAt < FEED_TTL) return;
    s.items = readFeedLinks();
    s.fetchedAt = Date.now();
    saveBoard();
    renderCard(item);
  }

  function renderFeed(body, item) {
    const items = item.settings.items || [];
    const rows = items.map((it) =>
      '<a class="pcw-feed-row" href="' + escapeHtml(it.href) + '">' + escapeHtml(it.title) + '</a>'
    ).join('');

    body.innerHTML =
      '<div class="pcw-widget pcw-feed">' +
        '<div class="pcw-widget-head">' +
          '<span class="pcw-caption">信息流</span>' +
          '<button type="button" class="pcw-icon-btn" data-pcw-act="feed-refresh" ' +
            'title="刷新" aria-label="刷新信息流">' + ICONS.refresh + '</button>' +
        '</div>' +
        '<div class="pcw-feed-list">' +
          (rows || '<span class="pcw-empty">暂无内容，点右上角刷新</span>') +
        '</div>' +
      '</div>';
  }

  // ---------- 2.7 我的数据 ----------

  let statsPending = false;

  function normalizeStats(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const d = s.data && typeof s.data === 'object' ? s.data : null;
    return {
      data: d ? {
        name: typeof d.name === 'string' ? d.name.slice(0, 24) : '',
        level: roundOrNull(d.level) || 0,
        fish: roundOrNull(d.fish) || 0,
        topics: roundOrNull(d.topics) || 0,
        replies: roundOrNull(d.replies) || 0,
        followers: roundOrNull(d.followers) || 0
      } : null,
      fetchedAt: Number(s.fetchedAt) || 0,
      error: typeof s.error === 'string' ? s.error.slice(0, 40) : ''
    };
  }

  function displayName(user, profile) {
    const idLike = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(v || '').trim());
    const list = [
      profile && profile.username,
      user && user.nickname,
      user && user.name,
      user && user.username
    ];
    for (let i = 0; i < list.length; i += 1) {
      const text = typeof list[i] === 'string' ? list[i].trim() : '';
      if (text && !idLike(text)) return text.slice(0, 24);
    }
    return '我的账号';
  }

  function refreshStats(item, force) {
    const s = item.settings;
    if (statsPending) return;
    if (!force && s.fetchedAt && Date.now() - s.fetchedAt < STATS_TTL) return;

    statsPending = true;
    fetchJson('/api/v1/session')
      .then((data) => {
        const user = (data && (data.user || data.data || data)) || null;
        if (!user || (!user.id && !user.username)) throw new Error('unauth');
        return fetchJson('/api/v1/users/' + encodeURIComponent(user.id))
          .then((profile) => ({ user, profile }))
          .catch(() => ({ user, profile: null }));
      })
      .then(({ user, profile }) => {
        const stats = (profile && profile.stats) || user.stats || {};
        s.data = {
          name: displayName(user, profile),
          level: roundOrNull(profile && profile.level && profile.level.current) ||
            roundOrNull(user.level && user.level.current) || 0,
          fish: roundOrNull(user.tokenBalance) || 0,
          topics: roundOrNull(stats.topics) || 0,
          replies: roundOrNull(stats.replies) || 0,
          followers: roundOrNull(stats.followers) || 0
        };
        s.fetchedAt = Date.now();
        s.error = '';
      })
      .catch((err) => {
        s.error = err && err.message === 'unauth' ? '未登录，先登录站点' : '数据获取失败，点刷新重试';
      })
      .finally(() => {
        statsPending = false;
        saveBoard();
        renderCard(item);
      });
  }

  function renderStats(body, item) {
    const s = item.settings;
    const d = s.data;
    const head =
      '<div class="pcw-widget-head">' +
        '<span class="pcw-caption">我的数据</span>' +
        '<button type="button" class="pcw-icon-btn" data-pcw-act="stats-refresh" ' +
          'title="刷新" aria-label="刷新我的数据">' + ICONS.refresh + '</button>' +
      '</div>';

    if (!d) {
      body.innerHTML = '<div class="pcw-widget pcw-stats">' + head +
        '<span class="pcw-empty">' + escapeHtml(s.error || '正在读取账号…') + '</span></div>';
      return;
    }

    const cells = [
      { label: '帖子', value: d.topics },
      { label: '回复', value: d.replies },
      { label: '粉丝', value: d.followers }
    ].map((it) =>
      '<div class="pcw-stat"><b>' + formatNum(it.value) + '</b><span>' + it.label + '</span></div>'
    ).join('');

    body.innerHTML =
      '<div class="pcw-widget pcw-stats">' + head +
        '<div class="pcw-stats-user">' +
          '<span class="pcw-stats-name" title="' + escapeHtml(d.name || '') + '">' +
            escapeHtml(d.name || '我的账号') + '</span>' +
          '<span class="pcw-chip">Lv.' + (d.level || 0) + '</span>' +
        '</div>' +
        '<div class="pcw-stats-grid">' + cells + '</div>' +
        '<div class="pcw-stats-foot">小鱼干 <b>' + formatNum(d.fish) + '</b></div>' +
      '</div>';
  }

  // ---------- 2.8 未读通知 ----------

  let notifyPending = false;

  function normalizeNotify(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      count: Math.max(0, roundOrNull(s.count) || 0),
      fetchedAt: Number(s.fetchedAt) || 0,
      error: typeof s.error === 'string' ? s.error.slice(0, 40) : ''
    };
  }

  function refreshNotify(item, force) {
    const s = item.settings;
    if (notifyPending) return;
    if (!force && s.fetchedAt && Date.now() - s.fetchedAt < NOTIFY_TTL) return;

    notifyPending = true;
    fetchJson('/api/v1/notification-summary')
      .then((data) => {
        s.count = Math.max(0, roundOrNull(data && data.unreadCount) || 0);
        s.fetchedAt = Date.now();
        s.error = '';
      })
      .catch(() => {
        s.error = '读取失败';
      })
      .finally(() => {
        notifyPending = false;
        saveBoard();
        renderCard(item);
      });
  }

  function renderNotify(body, item) {
    const s = item.settings;
    const count = Number(s.count) || 0;

    body.innerHTML =
      '<div class="pcw-widget pcw-notify">' +
        '<div class="pcw-widget-head">' +
          '<span class="pcw-caption">通知</span>' +
          '<button type="button" class="pcw-icon-btn" data-pcw-act="notify-refresh" ' +
            'title="刷新" aria-label="刷新未读通知">' + ICONS.refresh + '</button>' +
        '</div>' +
        '<div class="pcw-notify-main">' +
          '<b class="pcw-notify-count' + (count ? '' : ' is-zero') + '">' +
            (s.error ? '—' : formatNum(count)) + '</b>' +
          '<span class="pcw-caption">条未读</span>' +
        '</div>' +
        '<a class="pcw-notify-link" href="/notifications">查看通知</a>' +
      '</div>';
  }

  // ---------- 2.9 发帖热力图 ----------

  let heatPending = false;
  const HEAT_WEEKS = 5;

  function normalizeHeatmap(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const days = {};
    const src = s.days && typeof s.days === 'object' ? s.days : {};
    Object.keys(src).forEach((key) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      const n = roundOrNull(src[key]);
      if (n > 0) days[key] = Math.min(99, n);
    });
    return {
      days,
      fetchedAt: Number(s.fetchedAt) || 0,
      error: typeof s.error === 'string' ? s.error.slice(0, 40) : ''
    };
  }

  function dayKeyOf(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function pickList(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.items)) return json.items;
    if (json.data && Array.isArray(json.data.items)) return json.data.items;
    if (Array.isArray(json.data)) return json.data;
    return [];
  }

  /** 站点没有公开的主题列表文档，按常见命名逐个试探 */
  function fetchTopicDays(userId) {
    const id = encodeURIComponent(userId);
    const urls = [
      '/api/v1/users/' + id + '/topics?limit=50&sort=-createdAt',
      '/api/v1/topics?filter[author]=' + id + '&sort=-createdAt&limit=50',
      '/api/v1/topics?author=' + id + '&sort=-createdAt&limit=50'
    ];
    const attempt = (i) => {
      if (i >= urls.length) return Promise.resolve([]);
      return fetchJson(urls[i])
        .then((json) => {
          const days = pickList(json).map((it) => {
            const raw = (it && (it.createdAt || (it.attributes && it.attributes.createdAt))) || '';
            return dayKeyOf(raw);
          }).filter(Boolean);
          return days.length ? days : attempt(i + 1);
        })
        .catch(() => attempt(i + 1));
    };
    return attempt(0);
  }

  function refreshHeatmap(item, force) {
    const s = item.settings;
    if (heatPending) return;
    if (!force && s.fetchedAt && Date.now() - s.fetchedAt < STATS_TTL) return;

    heatPending = true;
    fetchJson('/api/v1/session')
      .then((data) => {
        const user = (data && (data.user || data.data || data)) || null;
        const uid = user && (user.id || user.username);
        if (!uid) throw new Error('unauth');
        return fetchTopicDays(uid);
      })
      .then((days) => {
        const counts = {};
        days.forEach((key) => { counts[key] = (counts[key] || 0) + 1; });
        s.days = counts;
        s.fetchedAt = Date.now();
        s.error = '';
      })
      .catch((err) => {
        s.error = err && err.message === 'unauth' ? '未登录，先登录站点' : '读取失败，点刷新重试';
      })
      .finally(() => {
        heatPending = false;
        saveBoard();
        renderCard(item);
      });
  }

  function renderHeatmap(body, item) {
    const s = item.settings;
    const head =
      '<div class="pcw-widget-head">' +
        '<span class="pcw-caption">发帖热力图</span>' +
        '<button type="button" class="pcw-icon-btn" data-pcw-act="heat-refresh" ' +
          'title="刷新" aria-label="刷新发帖热力图">' + ICONS.refresh + '</button>' +
      '</div>';

    // 从本周一往前推 5 周，按列排周、行排星期
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7);

    const cells = [];
    let activeDays = 0;
    let total = 0;
    for (let i = 0; i < HEAT_WEEKS * 7; i += 1) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = dayKeyOf(d);
      const n = s.days[key] || 0;
      if (n) { activeDays += 1; total += n; }
      const lv = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4;
      cells.push('<span class="pcw-heat-cell" data-lv="' + lv + '" title="' +
        key + (n ? ' · ' + n + ' 篇' : ' · 没有发帖') + '"></span>');
    }

    body.innerHTML =
      '<div class="pcw-widget pcw-heat">' + head +
        '<div class="pcw-heat-grid" role="img" aria-label="最近 ' + HEAT_WEEKS + ' 周发帖活跃度">' +
          cells.join('') +
        '</div>' +
        '<div class="pcw-heat-foot">' +
          (s.error
            ? escapeHtml(s.error)
            : '近 ' + HEAT_WEEKS + ' 周 <b>' + total + '</b> 篇 · 活跃 ' + activeDays + ' 天') +
        '</div>' +
      '</div>';
  }

  function defaultBoard() {
    return {
      v: 1,
      enabled: true,
      items: [
        {
          id: 'weather-default',
          type: 'weather',
          span: { w: 2, h: 3 },
          settings: Object.assign({}, DEFAULT_CITY, { data: null, fetchedAt: 0, error: '' })
        },
        {
          id: 'countdown-default',
          type: 'countdown',
          span: { w: 2, h: 2 },
          settings: { items: [] }
        }
      ],
      order: ['w:weather-default', 'w:countdown-default'],
      hidden: {}
    };
  }

  /** 读取存储时统一收口：未知类型丢弃、尺寸修正、order 去重 */
  function normalizeBoard(raw) {
    const src = raw && typeof raw === 'object' ? raw : null;
    if (!src) return defaultBoard();

    const source = Array.isArray(src.items) ? src.items : defaultBoard().items;
    const items = [];
    const seen = new Set();

    source.forEach((it) => {
      if (!it || typeof it !== 'object') return;
      const def = WIDGETS[it.type];
      if (!def) return;
      let id = typeof it.id === 'string' && it.id ? it.id : makeId(it.type);
      if (seen.has(id)) id = makeId(it.type);
      seen.add(id);
      items.push({
        id,
        type: it.type,
        span: normalizeSpan(it.span, def),
        settings: def.normalize
          ? def.normalize(it.settings)
          : (it.settings && typeof it.settings === 'object' ? it.settings : def.settings())
      });
    });

    const order = [];
    const seenOrder = new Set();
    const hasItem = (key) => key.startsWith('w:') &&
      items.some((it) => 'w:' + it.id === key);

    if (Array.isArray(src.order)) {
      src.order.forEach((key) => {
        if (typeof key !== 'string' || seenOrder.has(key)) return;
        // 组件 key 必须对应现存组件；站点 key 先保留，便于换页后恢复
        if (key.startsWith('w:') && !hasItem(key)) return;
        if (!key.startsWith('w:') && !key.startsWith('s:')) return;
        seenOrder.add(key);
        order.push(key);
      });
    }

    // 没登记过顺序的组件放到最后一个组件后面；没有组件时放到最前
    items.forEach((it) => {
      const key = 'w:' + it.id;
      if (seenOrder.has(key)) return;
      let at = -1;
      order.forEach((k, i) => { if (k.startsWith('w:')) at = i; });
      order.splice(at + 1, 0, key);
      seenOrder.add(key);
    });

    // 被移除的站点板块：key -> 名称，换页后仍能在「添加」菜单里恢复
    const hidden = {};
    if (src.hidden && typeof src.hidden === 'object') {
      Object.keys(src.hidden).forEach((key) => {
        if (!key.startsWith('s:')) return;
        const label = typeof src.hidden[key] === 'string' ? src.hidden[key].trim().slice(0, 24) : '';
        hidden[key] = label || '站点板块';
      });
    }

    return { v: 1, enabled: src.enabled !== false, items, order, hidden };
  }

  // ============================ 3. 运行状态 ============================

  let board = null;
  let loaded = false;
  let editing = false;

  let currentHost = null;      // 当前右栏板块堆叠容器
  let boundHost = null;        // 已绑定事件的容器
  let headerEl = null;
  let layerEl = null;          // 站点拖拽手柄层
  let emptyEl = null;
  let widgetCards = new Map(); // widget id -> card
  let siteEntries = [];        // [{ key, el, container }]
  let siteElByKey = new Map();
  let siteContainerByKey = new Map(); // 站点 key -> 所属容器（host 或嵌套网格）
  let siteHandles = new Map(); // site key -> button
  let siteRemoveHandles = new Map(); // site key -> 移除按钮

  let gesture = null;
  let syncTimer = 0;
  let observer = null;
  let resizeObserver = null;

  function findItem(id) {
    return board ? board.items.find((it) => it.id === id) : null;
  }

  function widgetKey(id) {
    return 'w:' + id;
  }

  function siteKeyOf(el, used) {
    let base = '';
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) {
      base = 'aria:' + aria;
    } else if (el.tagName === 'A' && el.getAttribute('href')) {
      base = 'href:' + el.getAttribute('href');
    } else {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      base = 'text:' + (text || el.tagName.toLowerCase());
    }
    let key = 's:' + base;
    let n = 2;
    while (used.has(key)) {
      key = 's:' + base + '#' + n;
      n += 1;
    }
    used.add(key);
    return key;
  }

  /** 站点板块用于恢复菜单的展示名称 */
  function siteLabelOf(el) {
    if (!el) return '站点板块';
    const aria = (el.getAttribute('aria-label') || '').trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return (aria || text || '站点板块').slice(0, 24);
  }

  // ============================ 4. 存储 ============================

  function saveBoard() {
    try {
      chrome.storage.local.set({ [BOARD_KEY]: board }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* 扩展上下文失效时忽略 */ }
  }

  function loadBoard() {
    try {
      chrome.storage.local.get(BOARD_KEY, (raw) => {
        if (chrome.runtime.lastError) {
          board = defaultBoard();
          loaded = true;
          syncMount();
          return;
        }
        board = normalizeBoard(raw && raw[BOARD_KEY]);
        loaded = true;
        if (!raw || !raw[BOARD_KEY]) saveBoard();
        syncMount();
      });
    } catch (e) {
      board = defaultBoard();
      loaded = true;
      syncMount();
    }
  }

  // ============================ 5. 找到右栏板块堆叠容器 ============================

  function findHost() {
    const aside = document.querySelector(ASIDE_SEL);
    if (!aside) return null;

    let host = aside;
    for (let depth = 0; depth < 4; depth += 1) {
      if (host.classList.contains('pcw-host')) return host;
      // 排除我们自己插入的节点，避免只剩一个手柄时误往下钻
      const kids = Array.from(host.children).filter((el) => !el.hasAttribute('data-pcw-own'));
      if (kids.length > 1) return host;
      const only = kids[0];
      if (!only || only.matches('section, article, a')) return host;
      host = only;
    }
    return host;
  }

  // ============================ 6. 挂载与自愈 ============================

  function syncMount() {
    if (!loaded) return;
    if (!isFeedPage() || !board.enabled) {
      teardown();
      return;
    }

    const host = findHost();
    if (!host) {
      teardown();
      return;
    }
    if (host !== currentHost) {
      if (currentHost) teardown();
      currentHost = host;
    }
    bindHost(host);
    applyRail();
  }

  function teardown() {
    cancelGesture();
    setEditing(false);

    if (headerEl) headerEl.remove();
    if (layerEl) layerEl.remove();
    widgetCards.forEach((card) => card.remove());
    if (emptyEl) emptyEl.remove();

    if (currentHost) {
      currentHost.classList.remove('pcw-host', 'is-editing');
      currentHost.querySelectorAll('.pcw-rail-item').forEach(resetSiteItem);
    }
    if (boundHost) {
      boundHost.removeEventListener('click', onRailClick);
      boundHost.removeEventListener('keydown', onRailKeydown);
      boundHost.removeEventListener('pointerdown', onRailPointerDown, true);
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    headerEl = null;
    layerEl = null;
    emptyEl = null;
    currentHost = null;
    boundHost = null;
    widgetCards.clear();
    siteHandles.clear();
    siteRemoveHandles.clear();
    siteEntries = [];
    siteElByKey = new Map();
    siteContainerByKey = new Map();
  }

  function resetSiteItem(el) {
    el.classList.remove('pcw-rail-item', 'pcw-rail-site', 'pcw-rail-widget',
      'pcw-gap-before', 'pcw-last', 'pcw-site-hidden');
    el.style.order = '';
    delete el.dataset.pcwKey;
  }

  function bindHost(host) {
    if (boundHost === host) return;
    if (boundHost) {
      boundHost.removeEventListener('click', onRailClick);
      boundHost.removeEventListener('keydown', onRailKeydown);
      boundHost.removeEventListener('pointerdown', onRailPointerDown, true);
      boundHost.removeEventListener('input', onRailInput);
    }
    host.addEventListener('click', onRailClick);
    host.addEventListener('keydown', onRailKeydown);
    host.addEventListener('pointerdown', onRailPointerDown, true);
    host.addEventListener('input', onRailInput);
    boundHost = host;
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncMount();
    }, 120);
  }

  // ============================ 7. 我们自己的节点 ============================

  function buildHeader() {
    const el = document.createElement('div');
    el.className = 'pcw-rail-head';
    el.setAttribute('data-pcw-own', '');
    el.innerHTML =
      '<span class="pcw-board-title">小组件</span>' +
      '<div class="pcw-board-tools">' +
        '<button type="button" class="pcw-btn pcw-btn-add" data-pcw-act="add" ' +
          'title="添加小组件" aria-label="添加小组件">' + ICONS.plus + '</button>' +
        '<button type="button" class="pcw-btn pcw-btn-edit" data-pcw-act="edit" ' +
          'aria-pressed="false" title="自定义小组件" aria-label="自定义小组件">' +
          ICONS.pencil + '</button>' +
      '</div>';
    el.appendChild(buildAddMenu());
    return el;
  }

  function buildAddMenu() {
    const menu = document.createElement('div');
    menu.className = 'pcw-add-menu';
    menu.setAttribute('data-pcw-own', '');
    menu.hidden = true;
    renderAddMenu(menu);
    return menu;
  }

  /** 菜单内容：可添加的组件 + 已移除的站点板块（可恢复） */
  function renderAddMenu(menu) {
    const hidden = board && board.hidden ? board.hidden : {};
    const hiddenKeys = Object.keys(hidden);

    menu.innerHTML = Object.keys(WIDGETS).map((type) => {
      const def = WIDGETS[type];
      return '<button type="button" class="pcw-add-item" data-pcw-act="pick" ' +
        'data-type="' + type + '">' +
        '<span class="pcw-add-name">' + def.name + '</span>' +
        '<span class="pcw-add-desc">' + def.desc + '</span>' +
      '</button>';
    }).join('') + (hiddenKeys.length
      ? '<div class="pcw-add-sep"></div>' +
        '<div class="pcw-add-group">已移除的站点板块</div>' +
        hiddenKeys.map((key) =>
          '<button type="button" class="pcw-add-item" data-pcw-act="unhide-site" ' +
            'data-key="' + escapeHtml(key) + '">' +
            '<span class="pcw-add-name">' + escapeHtml(hidden[key]) + '</span>' +
            '<span class="pcw-add-desc">点击恢复到右栏</span>' +
          '</button>'
        ).join('')
      : '');
  }

  function setAddMenu(open) {
    if (!headerEl) return;
    const menu = headerEl.querySelector('.pcw-add-menu');
    if (!menu) return;
    const next = !!open;
    if (next) renderAddMenu(menu);
    menu.hidden = !next;
    headerEl.classList.toggle('is-add-open', next);
    if (next) {
      const first = menu.querySelector('.pcw-add-item');
      if (first) first.focus();
    }
  }

  function buildCard(item) {
    const def = WIDGETS[item.type];
    const card = document.createElement('article');
    card.className = 'pcw-card pcw-rail-item pcw-rail-widget';
    card.setAttribute('data-pcw-own', '');
    card.setAttribute('data-id', item.id);
    card.setAttribute('data-type', item.type);

    card.innerHTML =
      '<div class="pcw-card-tools">' +
        '<button type="button" class="pcw-card-btn pcw-drag" data-pcw-act="drag" ' +
          'data-key="' + widgetKey(item.id) + '" title="拖动排序；聚焦后用上下方向键移动" ' +
          'aria-label="拖动排序">' + ICONS.grip + '</button>' +
        '<button type="button" class="pcw-card-btn pcw-del" data-pcw-act="del" ' +
          'title="删除组件" aria-label="删除组件">' + ICONS.close + '</button>' +
      '</div>' +
      '<div class="pcw-card-body"></div>' +
      '<button type="button" class="pcw-resize" data-pcw-act="resize" ' +
        'title="拖动调整大小；聚焦后用方向键调整" aria-label="调整组件大小"></button>';

    def.render(card.querySelector('.pcw-card-body'), item);
    paintWidgetSize(card, item);
    return card;
  }

  function buildEmpty() {
    const el = document.createElement('div');
    el.className = 'pcw-rail-empty';
    el.setAttribute('data-pcw-own', '');
    el.innerHTML =
      '<span>还没有小组件</span>' +
      '<button type="button" class="pcw-btn" data-pcw-act="add">添加小组件</button>';
    return el;
  }

  function ensureOwnElements(host) {
    if (!headerEl) headerEl = buildHeader();
    if (headerEl.parentElement !== host) host.prepend(headerEl);

    if (!layerEl) {
      layerEl = document.createElement('div');
      layerEl.className = 'pcw-site-layer';
      layerEl.setAttribute('data-pcw-own', '');
    }
    if (layerEl.parentElement !== host) host.appendChild(layerEl);

    board.items.forEach((item) => {
      let card = widgetCards.get(item.id);
      if (!card) {
        card = buildCard(item);
        widgetCards.set(item.id, card);
      }
      if (card.parentElement !== host) {
        host.appendChild(card);
        // 等卡片进入 DOM、且已登记到 widgetCards 后再拉数据，异步回来才能就地重绘
        mountCard(card, item);
      }
    });

    Array.from(widgetCards.keys()).forEach((id) => {
      if (board.items.some((it) => it.id === id)) return;
      const card = widgetCards.get(id);
      if (card) card.remove();
      widgetCards.delete(id);
    });

    if (!board.items.length) {
      if (!emptyEl) emptyEl = buildEmpty();
      if (emptyEl.parentElement !== host) host.appendChild(emptyEl);
    } else if (emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
  }

  /** 卡片首次进入 DOM 时触发一次数据拉取（天气 / 信息流 / 帐号 / 通知） */
  function mountCard(card, item) {
    if (card.dataset.pcwMounted === '1') return;
    card.dataset.pcwMounted = '1';
    const def = WIDGETS[item.type];
    if (def && def.afterRender) def.afterRender(card, item);
  }

  // ============================ 8. 站点板块识别与整栏排序 ============================

  function isSiteCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute('data-pcw-own')) return false;
    if (el.matches('script, style, link, template, noscript')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const pos = window.getComputedStyle(el).position;
    if (pos === 'absolute' || pos === 'fixed') return false;
    return true;
  }

  /** 是否是「卡片网格」：直接子项都是链接 / 按钮这类可点卡片 */
  function isCardGrid(el) {
    const style = window.getComputedStyle(el);
    if (style.display !== 'grid' && style.display !== 'inline-grid') return false;
    const kids = Array.from(el.children);
    if (kids.length < 2) return false;
    const cards = kids.filter((c) => c.nodeType === 1 &&
      c.matches('a, button, li, [role="link"], [role="button"]'));
    return cards.length >= Math.ceil(kids.length / 2) && cards.length >= 2;
  }

  /** 顶层板块内部嵌套的卡片网格（如「创作与作品 / 学习与技术」那一组） */
  function findGroupGrids(el) {
    const out = [];
    const walk = (node, depth) => {
      if (depth > 3) return;
      Array.from(node.children).forEach((child) => {
        if (child.nodeType !== 1) return;
        if (child.hasAttribute('data-pcw-own')) return;
        if (child.matches('script, style, link, template, noscript, svg')) return;
        if (isCardGrid(child)) {
          out.push(child);
          return;   // 网格内部的卡片不再继续往下拆
        }
        walk(child, depth + 1);
      });
    };
    walk(el, 0);
    return out;
  }

  function applyRail() {
    if (!board || !currentHost || gesture) return;
    const host = currentHost;

    ensureOwnElements(host);
    host.classList.add('pcw-host');
    host.classList.toggle('is-editing', editing);

    // 收集站点原有板块，打上稳定 key；被移除的板块保持占位以便恢复
    const entries = [];
    const used = new Set();

    const collect = (el, container) => {
      if (!el || el.nodeType !== 1) return;
      if (el.hasAttribute('data-pcw-own')) return;
      if (el.matches('script, style, link, template, noscript')) return;
      const key = siteKeyOf(el, used);
      const hidden = !!(board.hidden && board.hidden[key]);
      // 已经隐藏的板块尺寸为 0，不能用可见性判断；恢复时要先摘掉隐藏类再量
      if (!hidden) {
        if (el.classList.contains('pcw-site-hidden')) el.classList.remove('pcw-site-hidden');
        if (!isSiteCandidate(el)) {
          used.delete(key);
          return;
        }
      }
      if (el.dataset.pcwKey !== key) el.dataset.pcwKey = key;
      el.classList.add('pcw-rail-item', 'pcw-rail-site');
      el.classList.remove('pcw-rail-widget');
      el.classList.toggle('pcw-site-hidden', hidden);
      entries.push({ key, el, hidden, container });
    };

    Array.from(host.children).forEach((el) => {
      collect(el, host);
      if (!el || el.nodeType !== 1 || el.hasAttribute('data-pcw-own')) return;
      const grids = isCardGrid(el) ? [el].concat(findGroupGrids(el)) : findGroupGrids(el);
      grids.forEach((grid) => {
        Array.from(grid.children).forEach((child) => collect(child, grid));
      });
    });

    siteEntries = entries;
    siteElByKey = new Map(entries.map(({ key, el }) => [key, el]));
    siteContainerByKey = new Map(entries.map(({ key, container }) => [key, container]));

    // 合并顺序：现存组件 + 站点 key；新站点板块按 DOM 顺序追加
    let order = board.order.filter((key) => {
      if (key.startsWith('w:')) return board.items.some((it) => widgetKey(it.id) === key);
      return key.startsWith('s:');
    });
    board.items.forEach((item) => {
      const key = widgetKey(item.id);
      if (order.includes(key)) return;
      let at = -1;
      order.forEach((k, i) => { if (k.startsWith('w:')) at = i; });
      order.splice(at + 1, 0, key);
    });
    entries.forEach(({ key }) => {
      if (!order.includes(key)) order.push(key);
    });

    if (order.join('|') !== board.order.join('|')) {
      board.order = order;
      saveBoard();
    }

    paintOrder();
    board.items.forEach((item) => {
      const card = widgetCards.get(item.id);
      if (card) paintWidgetSize(card, item);
    });
    layoutSiteHandles();
    if (editing) watchHostSize();
  }

  /** 按 order 视觉顺序设置 flex order 与间距类；不重建节点 */
  function paintOrder() {
    // 顶层（host）与每个嵌套网格各自维护一条 order 序列，互不干扰
    const hostSeq = [];
    const gridSeqs = new Map();

    board.order.forEach((key) => {
      const container = key.startsWith('w:')
        ? currentHost
        : siteContainerByKey.get(key) || currentHost;
      const el = key.startsWith('w:')
        ? widgetCards.get(key.slice(2))
        : siteElByKey.get(key);
      if (!el || !el.isConnected) return;
      // 被移除的板块不参与视觉顺序与间距计算
      if (el.classList.contains('pcw-site-hidden')) return;

      if (container === currentHost) {
        hostSeq.push(key);
        return;
      }
      if (!gridSeqs.has(container)) gridSeqs.set(container, []);
      gridSeqs.get(container).push(key);
    });

    let prevWidget = false;
    let lastEl = null;

    hostSeq.forEach((key, index) => {
      const el = key.startsWith('w:')
        ? widgetCards.get(key.slice(2))
        : siteElByKey.get(key);
      if (!el || !el.isConnected) return;

      const isWidget = key.startsWith('w:');
      el.style.order = String(index);
      el.classList.toggle('pcw-rail-widget', isWidget);
      el.classList.toggle('pcw-rail-site', !isWidget);
      el.classList.remove('pcw-gap-before', 'pcw-last');

      // 站点板块接在小组件后面时补 14px，加上小组件 10px 底距正好 24px
      if (!isWidget && prevWidget) el.classList.add('pcw-gap-before');
      prevWidget = isWidget;
      lastEl = el;
    });

    if (lastEl) lastEl.classList.add('pcw-last');

    // 嵌套网格：卡片之间由网格自身控制间距，只换顺序
    gridSeqs.forEach((keys) => {
      keys.forEach((key, index) => {
        const el = siteElByKey.get(key);
        if (!el || !el.isConnected) return;
        el.style.order = String(index);
        el.classList.remove('pcw-gap-before', 'pcw-last');
      });
    });
  }

  function paintWidgetSize(card, item) {
    card.dataset.w = String(item.span.w);
    card.style.height = widgetHeight(item.span.h) + 'px';
  }

  // ============================ 9. 站点板块拖拽手柄 ============================

  function layoutSiteHandles() {
    if (!layerEl) return;

    if (!editing) {
      if (layerEl.childElementCount) layerEl.innerHTML = '';
      siteHandles.clear();
      siteRemoveHandles.clear();
      return;
    }

    const visible = siteEntries.filter((entry) => !entry.hidden);
    const wanted = new Set(visible.map((entry) => entry.key));
    siteHandles.forEach((btn, key) => {
      if (wanted.has(key)) return;
      btn.remove();
      siteHandles.delete(key);
    });
    siteRemoveHandles.forEach((btn, key) => {
      if (wanted.has(key)) return;
      btn.remove();
      siteRemoveHandles.delete(key);
    });

    const hostRect = currentHost ? currentHost.getBoundingClientRect() : { left: 0, top: 0 };
    visible.forEach(({ key, el }) => {
      let btn = siteHandles.get(key);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pcw-site-handle';
        btn.setAttribute('data-pcw-own', '');
        btn.setAttribute('data-pcw-act', 'drag-site');
        btn.setAttribute('data-key', key);
        btn.title = '拖动排序；聚焦后用上下方向键移动';
        btn.setAttribute('aria-label', '拖动排序');
        btn.innerHTML = ICONS.grip;
        layerEl.appendChild(btn);
        siteHandles.set(key, btn);
      }
      // 用视口坐标换算，嵌套网格里的卡片也能对齐
      const rect = el.getBoundingClientRect();
      const left = rect.left - hostRect.left;
      const top = rect.top - hostRect.top;
      btn.style.left = (left + 6) + 'px';
      btn.style.top = (top + 6) + 'px';

      let rm = siteRemoveHandles.get(key);
      if (!rm) {
        rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'pcw-site-remove';
        rm.setAttribute('data-pcw-own', '');
        rm.setAttribute('data-pcw-act', 'hide-site');
        rm.setAttribute('data-key', key);
        rm.title = '从右栏移除；之后可在「添加」菜单恢复';
        rm.setAttribute('aria-label', '移除这个站点板块');
        rm.innerHTML = ICONS.close;
        layerEl.appendChild(rm);
        siteRemoveHandles.set(key, rm);
      }
      rm.style.left = (left + rect.width - 28) + 'px';
      rm.style.top = (top + 6) + 'px';
    });
  }

  function watchHostSize() {
    if (!currentHost || typeof ResizeObserver === 'undefined') return;
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(() => layoutSiteHandles());
    }
    resizeObserver.disconnect();
    resizeObserver.observe(currentHost);
    const seen = new Set();
    siteEntries.forEach(({ el }) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      resizeObserver.observe(el);
    });
    siteContainerByKey.forEach((container) => {
      if (!container || container === currentHost || seen.has(container)) return;
      seen.add(container);
      resizeObserver.observe(container);
    });
  }

  // ============================ 11. 自定义模式 ============================

  function setEditing(next) {
    editing = !!next;
    if (currentHost) currentHost.classList.toggle('is-editing', editing);
    if (headerEl) {
      const btn = headerEl.querySelector('.pcw-btn-edit');
      if (btn) {
        btn.setAttribute('aria-pressed', editing ? 'true' : 'false');
        btn.innerHTML = editing ? ICONS.done : ICONS.pencil;
        btn.title = editing ? '完成自定义' : '自定义小组件';
        btn.setAttribute('aria-label', btn.title);
      }
    }
    if (editing) document.documentElement.setAttribute('data-pcw-editing', '1');
    else document.documentElement.removeAttribute('data-pcw-editing');

    if (!editing) cancelGesture();
    layoutSiteHandles();
    if (editing) watchHostSize();
    else if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  function addWidget(type) {
    const def = WIDGETS[type];
    if (!def) return;
    const item = {
      id: makeId(type),
      type,
      span: { ...def.defaultSpan },
      settings: def.settings()
    };
    board.items.push(item);

    // 新组件插到最后一个组件后面；没有组件时放到最前
    const key = widgetKey(item.id);
    let at = -1;
    board.order.forEach((k, i) => { if (k.startsWith('w:')) at = i; });
    board.order.splice(at + 1, 0, key);

    saveBoard();
    applyRail();
    setEditing(true);
    const card = widgetCards.get(item.id);
    const handle = card && card.querySelector('[data-pcw-act="drag"]');
    if (handle) handle.focus();
  }

  function deleteWidget(id) {
    const index = board.items.findIndex((it) => it.id === id);
    if (index < 0) return;
    board.items.splice(index, 1);
    board.order = board.order.filter((key) => key !== widgetKey(id));
    saveBoard();
    const card = widgetCards.get(id);
    if (card) card.remove();
    widgetCards.delete(id);
    applyRail();
  }

  /** 把某个条目插到 target 之前/之后（保留其他页面留下的站点 key） */
  function moveKeyTo(key, targetKey, after) {
    const order = board.order.slice();
    const from = order.indexOf(key);
    if (from < 0) return;
    order.splice(from, 1);

    let at;
    if (!targetKey) {
      at = order.length;
    } else {
      const ti = order.indexOf(targetKey);
      at = ti < 0 ? order.length : ti + (after ? 1 : 0);
    }
    order.splice(at, 0, key);
    board.order = order;
  }

  function visualItems() {
    return board.order.map((key) => {
      const isWidget = key.startsWith('w:');
      const el = isWidget ? widgetCards.get(key.slice(2)) : siteElByKey.get(key);
      if (!el || !el.isConnected) return null;
      if (el.classList.contains('pcw-site-hidden')) return null;
      return {
        key,
        el,
        container: isWidget ? currentHost : (siteContainerByKey.get(key) || currentHost),
        rect: el.getBoundingClientRect()
      };
    }).filter(Boolean);
  }

  // ============================ 10. 排序位移动画（FLIP） ============================

  function reducedMotion() {
    return typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** 记录当前顺序下每个条目的位置，用于顺序变化后的 FLIP 过渡 */
  function rectMap() {
    const map = new Map();
    visualItems().forEach(({ key, el }) => map.set(key, el.getBoundingClientRect()));
    return map;
  }

  /** 先按旧位置反向位移，再过渡回新位置；不改 DOM 顺序 */
  function playReorderFlip(before) {
    if (!before || !before.size || reducedMotion()) return;
    visualItems().forEach(({ key, el }) => {
      const prev = before.get(key);
      if (!prev) return;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (!dx && !dy) return;

      const prevTransform = el.style.transform;
      const prevTransition = el.style.transition;
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
      void el.offsetWidth;   // 强制回流，让反向位移先生效
      el.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = prevTransform;

      let done = false;
      const finish = (ev) => {
        // 忽略子元素冒泡上来的 transitionend
        if (ev && ev.target !== el) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeEventListener('transitionend', finish);
        el.style.transition = prevTransition;
        el.style.transform = prevTransform;
      };
      const timer = setTimeout(finish, 240);
      el.addEventListener('transitionend', finish);
    });
  }

  function renderCard(item) {
    const card = widgetCards.get(item.id);
    if (!card) return;
    const body = card.querySelector('.pcw-card-body');
    if (body) WIDGETS[item.type].render(body, item);
  }

  function addCountdown(card) {
    if (!card) return;
    const item = findItem(card.getAttribute('data-id'));
    if (!item) return;
    const titleEl = card.querySelector('[data-cd-title]');
    const dateEl = card.querySelector('[data-cd-date]');
    if (!titleEl || !dateEl) return;

    const title = titleEl.value.trim().slice(0, 24);
    const date = dateEl.value;
    const items = item.settings.items || (item.settings.items = []);
    if (!title) { titleEl.focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { dateEl.focus(); return; }

    items.push({ id: makeId('cd'), title, date });
    saveBoard();
    renderCard(item);

    const next = widgetCards.get(item.id);
    const nextTitle = next && next.querySelector('[data-cd-title]');
    if (nextTitle) nextTitle.focus();
  }

  function deleteCountdown(card, id) {
    if (!card || !id) return;
    const item = findItem(card.getAttribute('data-id'));
    if (!item || !Array.isArray(item.settings.items)) return;
    item.settings.items = item.settings.items.filter((it) => it.id !== id);
    saveBoard();
    renderCard(item);
  }

  function addTodo(card) {
    const item = itemOf(card);
    if (!item) return;
    const input = card.querySelector('[data-todo-input]');
    if (!input) return;
    const text = input.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) { input.focus(); return; }
    const items = item.settings.items || (item.settings.items = []);
    if (items.length >= 50) return;
    items.push({ id: makeId('td'), text, done: false });
    saveBoard();
    renderCard(item);

    const next = widgetCards.get(item.id);
    const nextInput = next && next.querySelector('[data-todo-input]');
    if (nextInput) nextInput.focus();
  }

  function toggleTodo(card, id) {
    const item = itemOf(card);
    if (!item) return;
    const target = (item.settings.items || []).find((it) => it.id === id);
    if (!target) return;
    target.done = !target.done;
    saveBoard();
    renderCard(item);
  }

  function deleteTodo(card, id) {
    const item = itemOf(card);
    if (!item) return;
    item.settings.items = (item.settings.items || []).filter((it) => it.id !== id);
    saveBoard();
    renderCard(item);
  }

  let noteSaveTimer = 0;

  /** 便签防抖保存：不重绘卡片，避免打断输入 */
  function onRailInput(e) {
    const ta = e.target.closest && e.target.closest('[data-note]');
    if (!ta) return;
    const item = itemOf(ta);
    if (!item) return;
    item.settings.text = ta.value.slice(0, 2000);
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      noteSaveTimer = 0;
      saveBoard();
    }, 500);
  }

  /** 触发一次即时刷新（按钮 / 回车） */
  function forceRefresh(item) {
    if (!item) return;
    if (item.type === 'weather') refreshWeather(item, true);
    else if (item.type === 'feed') refreshFeed(item, true);
    else if (item.type === 'mystats') refreshStats(item, true);
    else if (item.type === 'notify') refreshNotify(item, true);
    else if (item.type === 'heatmap') refreshHeatmap(item, true);
  }

  function moveKeyBy(key, dir) {
    const container = siteContainerByKey.get(key) || currentHost;
    const present = visualItems().filter((it) => it.container === container);
    const index = present.findIndex((it) => it.key === key);
    if (index < 0) return;
    const neighbor = present[index + dir];
    if (!neighbor) return;
    const before = rectMap();
    moveKeyTo(key, neighbor.key, dir > 0);
    saveBoard();
    paintOrder();
    playReorderFlip(before);
    layoutSiteHandles();
  }

  function resizeBy(id, dw, dh) {
    const item = findItem(id);
    if (!item) return;
    const def = WIDGETS[item.type];
    const next = normalizeSpan({ w: item.span.w + dw, h: item.span.h + dh }, def);
    if (next.w === item.span.w && next.h === item.span.h) return;
    item.span = next;
    const card = widgetCards.get(id);
    if (card) paintWidgetSize(card, item);
    layoutSiteHandles();
    saveBoard();
  }

  // ============================ 12. 事件 ============================

  function onRailClick(e) {
    const own = e.target.closest && e.target.closest('[data-pcw-own]');
    if (!own || !currentHost || !currentHost.contains(own)) return;
    const btn = e.target.closest('[data-pcw-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-pcw-act');

    if (act === 'edit') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(!editing);
      return;
    }
    if (act === 'add') {
      e.preventDefault();
      e.stopPropagation();
      setAddMenu(!(headerEl && headerEl.classList.contains('is-add-open')));
      return;
    }
    if (act === 'pick') {
      e.preventDefault();
      e.stopPropagation();
      const type = btn.getAttribute('data-type');
      setAddMenu(false);
      if (type) addWidget(type);
      return;
    }
    if (act === 'hide-site') {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.getAttribute('data-key');
      const el = key && siteElByKey.get(key);
      if (!key || !el) return;
      board.hidden[key] = siteLabelOf(el);
      saveBoard();
      applyRail();
      layoutSiteHandles();
      return;
    }
    if (act === 'unhide-site') {
      e.preventDefault();
      e.stopPropagation();
      const key = btn.getAttribute('data-key');
      if (!key || !board.hidden || !board.hidden[key]) return;
      delete board.hidden[key];
      saveBoard();
      applyRail();
      layoutSiteHandles();
      const menu = headerEl && headerEl.querySelector('.pcw-add-menu');
      if (menu) renderAddMenu(menu);
      return;
    }
    if (act === 'del') {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.pcw-card');
      if (card) deleteWidget(card.getAttribute('data-id'));
      return;
    }
    if (act === 'cd-add') {
      e.preventDefault();
      e.stopPropagation();
      addCountdown(btn.closest('.pcw-card'));
      return;
    }
    if (act === 'cd-del') {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.pcw-card');
      if (card) deleteCountdown(card, btn.getAttribute('data-cd-id'));
      return;
    }
    if (act === 'todo-add') {
      e.preventDefault();
      e.stopPropagation();
      addTodo(btn.closest('.pcw-card'));
      return;
    }
    if (act === 'todo-toggle') {
      e.preventDefault();
      e.stopPropagation();
      toggleTodo(btn.closest('.pcw-card'), btn.getAttribute('data-todo-id'));
      return;
    }
    if (act === 'todo-del') {
      e.preventDefault();
      e.stopPropagation();
      deleteTodo(btn.closest('.pcw-card'), btn.getAttribute('data-todo-id'));
      return;
    }
    if (act === 'wx-search') {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest('.pcw-card');
      const input = card && card.querySelector('[data-wx-city]');
      searchCity(itemOf(btn), input ? input.value : '');
      return;
    }
    if (act === 'wx-geo') {
      e.preventDefault();
      e.stopPropagation();
      locateWeather(itemOf(btn));
      return;
    }
    if (act === 'wx-refresh' || act === 'feed-refresh' ||
        act === 'stats-refresh' || act === 'notify-refresh' || act === 'heat-refresh') {
      e.preventDefault();
      e.stopPropagation();
      forceRefresh(itemOf(btn));
    }
  }

  function onRailKeydown(e) {
    if (!editing) return;
    const own = e.target.closest && e.target.closest('[data-pcw-own]');
    if (!own) return;

    // 倒数日输入框里回车即添加
    if (e.key === 'Enter' && e.target.closest && e.target.closest('.pcw-cd-edit')) {
      e.preventDefault();
      e.stopPropagation();
      addCountdown(e.target.closest('.pcw-card'));
      return;
    }

    // 天气城市 / 待办输入框回车即提交
    if (e.key === 'Enter' && e.target.closest) {
      const wxInput = e.target.closest('[data-wx-city]');
      if (wxInput) {
        e.preventDefault();
        e.stopPropagation();
        searchCity(itemOf(wxInput), wxInput.value);
        return;
      }
      const todoInput = e.target.closest('[data-todo-input]');
      if (todoInput) {
        e.preventDefault();
        e.stopPropagation();
        addTodo(todoInput.closest('.pcw-card'));
        return;
      }
    }

    // 输入中不响应删除 / 方向键排序
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;

    const dragBtn = e.target.closest('[data-pcw-act="drag"], [data-pcw-act="drag-site"]');
    if (dragBtn && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      const key = dragBtn.getAttribute('data-key');
      if (key) moveKeyBy(key, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    const resizeBtn = e.target.closest('[data-pcw-act="resize"]');
    if (resizeBtn && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const card = resizeBtn.closest('.pcw-card');
      if (!card) return;
      const dw = e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowLeft' ? -1 : 0);
      const dh = e.key === 'ArrowDown' ? 1 : (e.key === 'ArrowUp' ? -1 : 0);
      resizeBy(card.getAttribute('data-id'), dw, dh);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const card = e.target.closest('.pcw-card');
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        deleteWidget(card.getAttribute('data-id'));
      }
    }
  }

  function onRailPointerDown(e) {
    if (!editing || e.button !== 0) return;
    const own = e.target.closest && e.target.closest('[data-pcw-own]');
    if (!own) return;

    const dragBtn = e.target.closest('[data-pcw-act="drag"], [data-pcw-act="drag-site"]');
    const resizeBtn = e.target.closest('[data-pcw-act="resize"]');
    if (!dragBtn && !resizeBtn) return;

    if (dragBtn) {
      const key = dragBtn.getAttribute('data-key');
      const el = key && (key.startsWith('w:')
        ? widgetCards.get(key.slice(2))
        : siteElByKey.get(key));
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      startDrag(e, el, key);
      return;
    }

    const card = e.target.closest('.pcw-card');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    startResize(e, card);
  }

  // ============================ 13. 手势：排序 / 缩放 ============================

  function addGestureListeners() {
    document.addEventListener('pointermove', onGestureMove, true);
    document.addEventListener('pointerup', onGestureEnd, true);
    document.addEventListener('pointercancel', onGestureEnd, true);
  }

  function removeGestureListeners() {
    document.removeEventListener('pointermove', onGestureMove, true);
    document.removeEventListener('pointerup', onGestureEnd, true);
    document.removeEventListener('pointercancel', onGestureEnd, true);
  }

  function startDrag(e, el, key) {
    gesture = {
      kind: 'drag',
      key,
      el,
      container: siteContainerByKey.get(key) || currentHost,
      prevPointerEvents: el.style.pointerEvents,
      startOrder: board.order.slice(),
      moved: false,
      raf: 0
    };
    el.classList.add('is-dragging');
    el.style.pointerEvents = 'none';
    currentHost.classList.add('is-busy');
    addGestureListeners();
  }

  function startResize(e, card) {
    const item = findItem(card.getAttribute('data-id'));
    if (!item || !currentHost) return;
    gesture = {
      kind: 'resize',
      id: item.id,
      card,
      startX: e.clientX,
      startY: e.clientY,
      startSpan: { ...item.span },
      unitX: Math.max(1, (currentHost.clientWidth - ROW_GAP) / 2),
      unitY: ROW_H + ROW_GAP,
      moved: false
    };
    currentHost.classList.add('is-busy');
    addGestureListeners();
  }

  function onGestureMove(e) {
    if (!gesture) return;
    e.preventDefault();

    if (gesture.kind === 'drag') {
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      if (gesture.raf) return;
      const x = e.clientX;
      const y = e.clientY;
      gesture.raf = requestAnimationFrame(() => {
        if (!gesture) return;
        gesture.raf = 0;
        reorderAt(x, y);
      });
      return;
    }

    const g = gesture;
    const item = findItem(g.id);
    if (!item) return;
    const def = WIDGETS[item.type];
    const dw = Math.round((e.clientX - g.startX) / g.unitX);
    const dh = Math.round((e.clientY - g.startY) / g.unitY);
    const next = normalizeSpan({ w: g.startSpan.w + dw, h: g.startSpan.h + dh }, def);
    if (next.w === item.span.w && next.h === item.span.h) return;
    item.span = next;
    paintWidgetSize(g.card, item);
    layoutSiteHandles();
    g.moved = true;
  }

  /** 拖动排序：优先看指针下的条目，找不到再用中点坐标兜底；只在同一容器内换位 */
  function reorderAt(x, y) {
    if (!gesture || gesture.kind !== 'drag') return;
    const key = gesture.key;
    const container = gesture.container || currentHost;
    // 嵌套网格里的卡片不跨出网格
    if (container !== currentHost) {
      const cr = container.getBoundingClientRect();
      const pad = 16;
      if (x < cr.left - pad || x > cr.right + pad ||
          y < cr.top - pad || y > cr.bottom + pad) return;
    }
    const present = visualItems().filter((it) => it.container === container);
    if (present.length < 2) return;

    let target = null;
    let after = false;

    const under = document.elementFromPoint(x, y);
    const holder = under && under.closest
      ? under.closest('[data-pcw-key], .pcw-card[data-id], .pcw-site-handle[data-key]')
      : null;
    if (holder) {
      let hkey = holder.getAttribute('data-pcw-key') || '';
      if (!hkey && holder.classList.contains('pcw-site-handle')) {
        hkey = holder.getAttribute('data-key') || '';
      }
      if (!hkey && holder.getAttribute('data-id')) {
        hkey = widgetKey(holder.getAttribute('data-id'));
      }
      if (hkey && hkey !== key) {
        target = present.find((it) => it.key === hkey) || null;
        if (target) {
          const r = target.rect;
          after = r.width < currentHost.clientWidth * 0.75
            ? x > r.left + r.width / 2
            : y > r.top + r.height / 2;
        }
      }
    }

    if (!target) {
      for (const it of present) {
        if (it.key === key) continue;
        const r = it.rect;
        if (y < r.top + r.height / 2) {
          target = it;
          after = false;
          break;
        }
      }
    }
    if (!target) {
      const last = present[present.length - 1];
      if (!last || last.key === key) return;
      target = last;
      after = true;
    }
    if (target.key === key) return;

    const before = rectMap();
    const prevOrder = board.order.join('|');
    moveKeyTo(key, target.key, after);
    if (board.order.join('|') === prevOrder) return;
    gesture.moved = true;
    paintOrder();
    playReorderFlip(before);
    layoutSiteHandles();
  }

  function cleanupGesture() {
    removeGestureListeners();
    if (gesture) {
      if (gesture.raf) cancelAnimationFrame(gesture.raf);
      if (gesture.el) {
        gesture.el.classList.remove('is-dragging');
        gesture.el.style.pointerEvents = gesture.prevPointerEvents || '';
      }
      if (currentHost) currentHost.classList.remove('is-busy');
    }
    gesture = null;
  }

  function onGestureEnd() {
    if (!gesture) return;
    const g = gesture;

    // 快速甩动时 rAF 可能还没跑，松手前按最后一次指针位置收尾，避免白拖
    if (g.kind === 'drag' && !g.moved && typeof g.lastX === 'number') {
      reorderAt(g.lastX, g.lastY);
    }

    cleanupGesture();

    if (g.kind === 'drag' && g.moved) {
      saveBoard();
      applyRail();
    } else if (g.kind === 'resize' && g.moved) {
      saveBoard();
      layoutSiteHandles();
    }
  }

  /** Esc / 关闭编辑时撤销拖动与缩放 */
  function cancelGesture() {
    if (!gesture) return;
    const g = gesture;
    cleanupGesture();

    if (g.kind === 'resize') {
      const item = findItem(g.id);
      if (item) item.span = g.startSpan;
      const card = widgetCards.get(g.id);
      if (card && item) paintWidgetSize(card, item);
    } else if (g.kind === 'drag') {
      const before = rectMap();
      board.order = g.startOrder;
      paintOrder();
      playReorderFlip(before);
    }
    layoutSiteHandles();
  }

  // ============================ 14. 生命周期 ============================

  function boot() {
    loadBoard();

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[BOARD_KEY]) return;
        const next = normalizeBoard(changes[BOARD_KEY].newValue);
        if (JSON.stringify(next) === JSON.stringify(board)) return;
        board = next;
        syncMount();
        board.items.forEach(renderCard);
      });
    } catch (e) { /* noop */ }

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (headerEl && headerEl.classList.contains('is-add-open')) {
        e.preventDefault();
        setAddMenu(false);
        return;
      }
      if (gesture) {
        e.preventDefault();
        cancelGesture();
        return;
      }
      if (editing) {
        e.preventDefault();
        setEditing(false);
      }
    }, true);

    // 点添加菜单以外的位置就收起
    document.addEventListener('pointerdown', (e) => {
      if (!headerEl || !headerEl.classList.contains('is-add-open')) return;
      if (e.target.closest && e.target.closest('.pcw-rail-head')) return;
      setAddMenu(false);
    }, true);

    syncMount();

    observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', scheduleSync);
    window.addEventListener('resize', () => {
      if (editing) layoutSiteHandles();
    });
    // 跨天后刷新倒数日天数（编辑中不打断输入）
    let renderedDay = startOfToday();
    setInterval(() => {
      const today = startOfToday();
      if (today === renderedDay) return;
      renderedDay = today;
      if (!board || editing) return;
      board.items.forEach(renderCard);
    }, 60000);

    // 数据类组件按各自的 TTL 静默刷新（天气 30 分钟、数据卡 5 分钟、通知 / 信息流 2 分钟）
    setInterval(() => {
      if (!board || !isFeedPage() || editing) return;
      board.items.forEach((item) => {
        if (item.type === 'weather') refreshWeather(item, false);
        else if (item.type === 'mystats') refreshStats(item, false);
        else if (item.type === 'notify') refreshNotify(item, false);
        else if (item.type === 'feed') refreshFeed(item, false);
      });
    }, 45000);

    setInterval(scheduleSync, 1500);
  }

  if (window.__pickscribeWidgetsLoaded) return;
  window.__pickscribeWidgetsLoaded = true;

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
