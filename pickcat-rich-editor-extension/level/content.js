/**
 * 等级成长弹窗 · 三维度与社区熟悉度进度。
 *
 * 个人主页点击 LV 徽章打开的「等级成长」弹窗里：
 *   - 能力 / 责任 / 爱三张卡片原本只有描述；
 *   - 社区熟悉度下的各项原本只有进度条。
 * 这里在它们的标题行右侧补上「当前 / 目标 · 完成百分比」，
 * 数据来自站点自己的 GET /api/v1/level-progress。
 *
 * 该接口与弹窗同源、同登录态，仅在本人主页的弹窗内展示，不上报任何数据。
 */
(function () {
  'use strict';

  if (window.__pickscribeLevelGrowthLoaded) return;
  window.__pickscribeLevelGrowthLoaded = true;

  const SCORE_SECTION_SEL = 'section[aria-label="当前成长状态"]';
  const FAM_SECTION_SEL = 'section[aria-labelledby="familiarity-title"]';
  const TICK_INTERVAL = 700;
  const CACHE_TTL = 3000;   // 弹窗短时间内反复开关时复用同一份结果

  const DIMS = [
    { key: 'ability', label: '能力' },
    { key: 'responsibility', label: '责任' },
    { key: 'care', label: '爱' }
  ];

  // 与站点弹窗里的「社区熟悉度」条目一一对应
  const FAMILIARITY = [
    { key: 'daysSinceEntranceExam', label: '社区陪伴', unit: '天' },
    { key: 'validVisitDays', label: '有效访问', unit: '天' },
    { key: 'topicsEntered', label: '浏览主题', unit: '个' },
    { key: 'postsRead', label: '内容阅读', unit: '篇' },
    { key: 'effectiveReadingSeconds', label: '有效阅读', unit: '分钟', scale: 1 / 60 }
  ];

  let cache = null;       // { at, promise }
  let loading = false;

  // ============================ 数据 ============================

  async function getProgress() {
    if (cache && Date.now() - cache.at < CACHE_TTL) return cache.promise;

    const entry = { at: Date.now(), promise: null };
    entry.promise = (async () => {
      const res = await fetch('/api/v1/level-progress', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      // 兼容接口直接返回 progress，或包一层 { progress } 的情况
      return json && json.progress ? json.progress : json;
    })();
    cache = entry;

    try {
      return await entry.promise;
    } catch (e) {
      cache = null;
      throw e;
    }
  }

  // ============================ 渲染 ============================

  /** 数字格式化：整数直接显示，小数保留一位 */
  function num(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /** 生成数值徽标：文字 + 百分比（百分比为空时只显示文字） */
  function buildBadge(kind, text, pct, done, title) {
    const badge = document.createElement('span');
    badge.className = 'pcl-metric ' + (kind === 'fam' ? 'pcl-fam' : 'pcl-score');
    if (done) badge.classList.add('is-done');
    if (title) badge.title = title;

    const numSpan = document.createElement('span');
    numSpan.className = 'pcl-num';
    numSpan.textContent = text;
    badge.appendChild(numSpan);

    if (pct !== null) {
      const pctSpan = document.createElement('span');
      pctSpan.className = 'pcl-pct';
      pctSpan.textContent = pct + '%';
      badge.appendChild(pctSpan);
    }
    return badge;
  }

  // ---------- 能力 / 责任 / 爱 ----------

  function pendingScores(section) {
    const out = [];
    for (const card of section.querySelectorAll('article')) {
      const h4 = card.querySelector('h4');
      if (!h4) continue;
      const dim = DIMS.find((d) => h4.textContent.trim().startsWith(d.label));
      if (!dim) continue;
      if (!h4.querySelector('.pcl-score')) out.push({ h4, dim });
    }
    return out;
  }

  function decorateScores(section, progress) {
    const next = progress && progress.nextLevel;
    if (!next || !next.scores) return;

    for (const { h4, dim } of pendingScores(section)) {
      const score = next.scores[dim.key];
      if (!score) continue;

      const current = Number(score.current) || 0;
      const required = Number(score.required) || 0;
      const pct = required > 0 ? Math.min(100, Math.round((current * 100) / required)) : 100;

      const text = required > 0 ? num(current) + ' / ' + num(required) : '已达成';
      const badge = buildBadge(
        'score',
        text,
        required > 0 ? pct : null,
        pct >= 100,
        dim.label + '：' + (required > 0 ? current + ' / ' + required + '，' : '') + pct + '%'
      );
      h4.appendChild(badge);
    }
  }

  // ---------- 社区熟悉度 ----------

  function pendingFamiliarity(section) {
    const out = [];
    for (const cfg of FAMILIARITY) {
      // 标题是唯一一个纯文本等于配置标签的 span
      const span = Array.from(section.querySelectorAll('span')).find(
        (s) => s.children.length === 0 && s.textContent.trim() === cfg.label
      );
      if (!span) continue;
      const row = span.parentElement;
      if (!row || row.querySelector('.pcl-fam')) continue;
      out.push({ row, cfg });
    }
    return out;
  }

  function decorateFamiliarity(section, progress) {
    const fam = progress && progress.nextLevel && progress.nextLevel.familiarity;
    if (!fam) return;

    for (const { row, cfg } of pendingFamiliarity(section)) {
      const item = fam[cfg.key];
      if (!item) continue;

      const current = Number(item.current) || 0;
      const required = Number(item.required) || 0;
      const pct = required > 0 ? Math.min(100, Math.round((current * 100) / required)) : 100;

      let text = '已达成';
      if (required > 0) {
        const scale = cfg.scale || 1;
        text = num(current * scale) + cfg.unit + ' / ' + num(required * scale) + cfg.unit;
      }

      const badge = buildBadge(
        'fam',
        text,
        required > 0 ? pct : null,
        pct >= 100,
        cfg.label + '：' + text + '，' + pct + '%'
      );

      // 放在标题行右端；若有完成勾选图标，则排在图标前面
      const icon = row.querySelector('svg');
      if (icon) row.insertBefore(badge, icon);
      else row.appendChild(badge);
    }
  }

  // ============================ 轮询 ============================

  function tick() {
    const scoreSection = document.querySelector(SCORE_SECTION_SEL);
    const famSection = document.querySelector(FAM_SECTION_SEL);
    if (!scoreSection && !famSection) return;

    const hasPending =
      (scoreSection && pendingScores(scoreSection).length > 0) ||
      (famSection && pendingFamiliarity(famSection).length > 0);
    if (!hasPending || loading) return;

    loading = true;
    getProgress()
      .then((progress) => {
        const score = document.querySelector(SCORE_SECTION_SEL);
        const fam = document.querySelector(FAM_SECTION_SEL);
        if (score) decorateScores(score, progress);
        if (fam) decorateFamiliarity(fam, progress);
      })
      .catch(() => {
        /* 未登录、接口失败或不在本人主页：保持原样 */
      })
      .finally(() => {
        loading = false;
      });
  }

  window.addEventListener('popstate', tick);
  setInterval(tick, TICK_INTERVAL);
  tick();
})();
