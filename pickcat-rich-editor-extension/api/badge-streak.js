/**
 * 工牌挂件 · 小鱼干（独立于 api/badge.js 的成就逻辑）。
 *
 * 规则：
 *   连续 7 个「本地自然日」都发过主题帖 → 绳子中段挂上一枚小鱼干，永久保留。
 *   断签判定：今天还没发帖不算断（当天剩余时间仍然有效）；如果昨天也没有记录，
 *   连续天数直接归零，重新从 1 天开始算。
 *
 * 数据：
 *   依次尝试站点按作者过滤的主题列表接口，取 createdAt 的本地日期；
 *   任何一步失败都不影响工牌本身，只是不显示挂件。
 *   结果按日期合并进 pcr_badge_streak 缓存，避免每次开牌都重新拉取。
 *
 * 对外接口（供 api/badge.js 调用）：
 *   PCRBadgeStreak.attach(svg)          绑定绳子 SVG，创建挂件节点（默认隐藏）
 *   PCRBadgeStreak.sync(userId)         拉取并合并数据，返回 Promise<boolean>
 *   PCRBadgeStreak.position(a, c, b)    按绳子二次贝塞尔曲线摆放挂件
 *   PCRBadgeStreak.hide()               脱手时先藏起来
 */

(() => {
  'use strict';

  if (window.PCRBadgeStreak) return;

  const STORE_KEY = 'pcr_badge_streak';
  const STREAK_DAYS = 7;            // 连续多少天解锁
  const KEEP_DAYS = 40;             // 缓存最多保留多少天记录
  const SYNC_TTL = 30 * 60 * 1000;  // 同一份数据 30 分钟内不重复拉取
  const CURVE_T = 0.5;              // 挂在绳子曲线的哪个位置（0 = 头像端，1 = 工牌端）

  /** localStorage 兜底：mock / 非扩展环境里也能记住数据 */
  let memory = { userId: '', days: [], fish: false, at: 0 };

  let svg = null;
  let fishEl = null;
  let fishOn = false;
  let hidden = false;

  // ============================ 日期 ============================

  /** 本地日期键：跨天判断一律用本地时区，避免 UTC 偏移导致刚过零点就算新一天 */
  function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function shiftDay(key, delta) {
    const parts = key.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  }

  /**
   * 连续天数：从今天往回数。
   * 今天还没发帖时看昨天，昨天也没有就归零（今天仍有时间补上）。
   */
  function streakOf(daySet) {
    const today = dayKey(new Date());
    let cursor = today;
    if (!daySet.has(today)) {
      const yesterday = shiftDay(today, -1);
      if (!daySet.has(yesterday)) return 0;
      cursor = yesterday;
    }
    let count = 0;
    while (daySet.has(cursor)) {
      count += 1;
      cursor = shiftDay(cursor, -1);
    }
    return count;
  }

  // ============================ 存储 ============================

  function readStore() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORE_KEY, (raw) => {
          if (chrome.runtime.lastError || !raw) {
            resolve({ ...memory });
            return;
          }
          const value = raw[STORE_KEY];
          resolve(value && typeof value === 'object' ? value : { ...memory });
        });
      } catch (e) {
        resolve({ ...memory });
      }
    });
  }

  function writeStore(data) {
    memory = { ...data };
    try {
      chrome.storage.local.set({ [STORE_KEY]: data }, () => void chrome.runtime.lastError);
    } catch (e) { /* 非扩展环境只留内存 */ }
  }

  // ============================ 数据 ============================

  /** 站点没有公开「某用户的主题列表」文档，这里按常见命名逐个试探，能拿到就用 */
  function probeUrls(userId) {
    const id = encodeURIComponent(userId);
    return [
      '/api/v1/users/' + id + '/topics?limit=30&sort=-createdAt',
      '/api/v1/topics?filter[author]=' + id + '&sort=-createdAt&limit=30',
      '/api/v1/topics?author=' + id + '&sort=-createdAt&limit=30'
    ];
  }

  function pickItems(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.items)) return json.items;
    if (json.data && Array.isArray(json.data.items)) return json.data.items;
    if (Array.isArray(json.data)) return json.data;
    return [];
  }

  async function fetchDays(userId) {
    for (const url of probeUrls(userId)) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!res.ok) continue;
        const items = pickItems(await res.json());
        if (!items.length) continue;

        const days = [];
        for (const item of items) {
          const raw = (item && (item.createdAt || (item.attributes && item.attributes.createdAt))) || '';
          if (!raw) continue;
          const key = dayKey(raw);
          if (key) days.push(key);
        }
        if (days.length) return days;
      } catch (e) { /* 试下一个 */ }
    }
    return [];
  }

  // ============================ 挂件 ============================

  /** 小鱼干：身体 + 尾巴 + 骨头短线 + 眼睛，尺寸固定在 22×13 左右，不挡工牌文字 */
  function buildFish() {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'pcr-badge-fish');
    g.setAttribute('data-pcr-fish', '');
    g.innerHTML =
      '<path class="pcr-badge-fish-body" d="M-9-3.4c3.4-3.4 9.4-3.4 12.8 0 3 3 3 6.8 0 9.8-3.4 3.4-9.4 3.4-12.8 0-2.6-2.6-2.6-7.2 0-9.8Z"/>' +
      '<path class="pcr-badge-fish-tail" d="M3.4 1.4 9.6-3.4 8.2 1.6 9.6 6.8 3.4 4.4"/>' +
      '<path class="pcr-badge-fish-bone" d="M-5.4-1.8v7.6M-2.4-2.6v9.2"/>' +
      '<circle class="pcr-badge-fish-eye" cx="-6.2" cy="-0.6" r="0.95"/>';
    return g;
  }

  function attach(target) {
    if (!target) return;
    svg = target;
    if (!fishEl || !fishEl.isConnected) {
      fishEl = buildFish();
      svg.appendChild(fishEl);
    }
    fishEl.classList.toggle('is-on', fishOn);
  }

  /**
   * 按二次贝塞尔曲线摆放：a = 头像端，c = 控制点，b = 工牌端。
   * 挂件随绳子拉伸 / 摆动一起滑动，并沿曲线切线转一点点角度。
   */
  function position(a, c, b) {
    if (!fishEl || !fishOn) return;
    if (!fishEl.isConnected && svg) svg.appendChild(fishEl);

    const t = CURVE_T;
    const mt = 1 - t;
    const x = mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x;
    const y = mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y;

    // 切线方向决定小鱼干的倾斜，跟绳子保持同一条弧线
    const dx = 2 * mt * (c.x - a.x) + 2 * t * (b.x - c.x);
    const dy = 2 * mt * (c.y - a.y) + 2 * t * (b.y - c.y);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
    deg = Math.max(-38, Math.min(38, deg));

    fishEl.setAttribute('transform',
      'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + deg.toFixed(1) + ')');
    if (hidden) {
      hidden = false;
      fishEl.classList.remove('is-hidden');
    }
  }

  function hide() {
    if (!fishEl) return;
    hidden = true;
    fishEl.classList.add('is-hidden');
  }

  // ============================ 同步 ============================

  async function sync(userId) {
    if (!userId) return false;
    const store = await readStore();
    const sameUser = store.userId === userId;
    const days = new Set(sameUser && Array.isArray(store.days) ? store.days : []);
    const fresh = sameUser && store.at && Date.now() - store.at < SYNC_TTL;

    if (!fresh) {
      const fetched = await fetchDays(userId);
      fetched.forEach((key) => days.add(key));
    }

    // 只留最近 KEEP_DAYS 天，缓存不会无限增长
    const sorted = Array.from(days).sort();
    const kept = sorted.slice(Math.max(0, sorted.length - KEEP_DAYS));
    const streak = streakOf(new Set(kept));
    // 达成过就一直保留，断签也不会把挂件收回
    const fish = (sameUser && store.fish === true) || streak >= STREAK_DAYS;

    writeStore({
      userId,
      days: kept,
      fish,
      streak,
      at: fresh ? store.at : Date.now()
    });

    fishOn = fish;
    if (fishEl) fishEl.classList.toggle('is-on', fishOn);
    return fishOn;
  }

  window.PCRBadgeStreak = {
    attach,
    sync,
    position,
    hide,
    /** 给调试与自检用 */
    debug: () => ({ fishOn, fish: !!fishEl, hidden })
  };
})();
