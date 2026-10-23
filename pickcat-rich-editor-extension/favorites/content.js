/**
 * 收藏夹 Plus —— 站点内容脚本（命名空间 pcf）
 *
 * 仅在帖子详情页（/forum/post/<id>）工作，不改动站点原有 DOM 结构与业务逻辑：
 *   1. 常驻看护监听 SPA 路由与收藏按钮的 aria-pressed / aria-label 变化；
 *   2. 站点收藏成功（false → true）后，按设置弹出「收藏到分组」浮动补归组条（COL-06），
 *      或直接归入最近使用分组（COL-02）/ 未分组收集箱；
 *   3. 站点取消收藏（true → false）按设置联动处理归组关系（COL-07）；
 *   4. 按钮旁显示「已归入 N 个分组」角标（COL-05 状态呈现）。
 *
 * 说明：本模块为经典内容脚本、无法 import shared/favorites.js，
 * 因此直接按同一份存储键结构（pcf_groups / pcf_items / pcf_settings）读写，并内联一份默认值兜底。
 * 与编辑器模块（pcr）和 AI 模块（pcai）完全隔离。
 */
(() => {
  'use strict';

  // 扩展被重载 / 更新后，旧内容脚本里的异步 chrome.* 调用会以
  // "Extension context invalidated" 拒绝；这是预期内的噪音，直接吞掉。
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason || '');
    if (msg.indexOf('Extension context invalidated') !== -1) e.preventDefault();
  });

  const NS = 'pcf';
  const KEYS = { groups: 'pcf_groups', items: 'pcf_items', settings: 'pcf_settings' };
  const SEL = {
    header: 'div[aria-label="作者与帖子操作"]',
    fav: 'button[aria-label*="收藏"]',
    cover: 'img[alt="文章封面"]',
    title: 'h1',
    body: '.markdown-body'
  };
  const DEFAULT_SETTINGS = {
    enabled: true, siteInject: true, behavior: 'panel', onUnfavorite: 'keep',
    syncFreq: 'popup', theme: 'system', density: 'grid', sort: 'time-desc',
    allowExternal: false, recentGroup: ''
  };
  const AUTO_DISMISS = 6000;   // 浮动条默认停留 6 秒，hover 时暂停计时

  // ============================ 1. 工具 ============================

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const isPostPage = () => /^\/forum\/post\/[^/]+/.test(location.pathname);

  function getPostId() {
    const m = location.pathname.match(/\/forum\/post\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  const groupColorByName = (name) => {
    const palette = ['#f03e46', '#3b6ef6', '#2f9e6f', '#b4690e', '#7a3bd6', '#0e9aa7', '#d6457a', '#5a6b7b'];
    const s = norm(name);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };

  /** 扩展上下文是否仍然有效：重载 / 停用扩展后，旧内容脚本的 chrome.* 会抛 "Extension context invalidated" */
  const extAlive = () => {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  const storageGet = (keys) => new Promise((resolve) => {
    if (!extAlive()) return resolve({});
    try {
      chrome.storage.local.get(keys, (raw) => resolve(raw || {}));
    } catch (e) {
      resolve({});
    }
  });

  const storageSet = (obj) => new Promise((resolve) => {
    if (!extAlive()) return resolve();
    try {
      chrome.storage.local.set(obj, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* 上下文已失效 */ }
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });

  // ============================ 2. 状态 ============================

  let settings = { ...DEFAULT_SETTINGS };
  let groups = [];              // 分组数组（按 order 升序）
  let items = {};               // 收藏项映射
  let mountedPostId = '';
  let lastPressed = null;       // 上一次观测到的收藏态（用于识别状态翻转）
  let bar = null;               // 浮动补归组条
  let barTimer = null;
  let badgeEl = null;           // 按钮角标

  async function loadState() {
    const raw = await storageGet([KEYS.groups, KEYS.items, KEYS.settings]);
    settings = { ...DEFAULT_SETTINGS, ...(raw[KEYS.settings] || {}) };
    groups = (raw[KEYS.groups] || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    items = raw[KEYS.items] || {};
  }

  async function saveItems() { await storageSet({ [KEYS.items]: items }); }
  async function saveSettings() { await storageSet({ [KEYS.settings]: settings }); }

  // ============================ 3. 样式 ============================

  const FALLBACK = {
    accent: '#f03e46', accentSoft: 'rgba(240,62,70,.12)', border: '#d4dbe4',
    surface: '#ffffff', surfaceHover: 'rgba(0,0,0,.045)', canvas: '#f3f4f6',
    text: '#171717', subtle: '#5f6875'
  };

  function injectStyle() {
    if (document.getElementById(NS + '-style')) return;
    const css = `
:root{
  --pcf-accent: var(--ui-accent, ${FALLBACK.accent});
  --pcf-accent-soft: var(--ui-accent-soft, ${FALLBACK.accentSoft});
  --pcf-border: var(--ui-border, ${FALLBACK.border});
  --pcf-surface: var(--ui-surface, ${FALLBACK.surface});
  --pcf-canvas: var(--ui-canvas, ${FALLBACK.canvas});
  --pcf-text: var(--ui-foreground, ${FALLBACK.text});
  --pcf-subtle: var(--ui-muted, ${FALLBACK.subtle});
  --pcf-r: var(--radius-surface, .5rem);
  --pcf-rc: var(--radius-control, .375rem);
  --pcf-font: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
}
.${NS}-badge{
  position:absolute; top:-5px; right:-5px; min-width:15px; height:15px; padding:0 4px;
  border-radius:999px; background:var(--pcf-accent); color:#fff; font-size:10px; line-height:15px;
  text-align:center; font-family:var(--pcf-font); font-weight:600; pointer-events:none;
  box-shadow:0 0 0 2px var(--pcf-surface);
}
.${NS}-bar{
  position:fixed; z-index:2147483000; width:290px;
  background:var(--pcf-surface); color:var(--pcf-text);
  border:1px solid var(--pcf-border); border-radius:var(--pcf-r);
  box-shadow:0 12px 34px rgba(20,24,31,.16);
  font-family:var(--pcf-font); font-size:13px; line-height:1.6;
  animation:${NS}-in .34s cubic-bezier(.22,1,.36,1) both;
}
@keyframes ${NS}-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
.${NS}-bar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:9px 12px;border-bottom:1px solid var(--pcf-border);}
.${NS}-bar-head b{font-size:13px;font-weight:600;}
.${NS}-bar-head span{font-size:11.5px;color:var(--pcf-subtle);}
.${NS}-glist{max-height:170px;overflow:auto;padding:5px 0;}
.${NS}-grow{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;}
.${NS}-grow:hover{background:var(--pcf-canvas);}
.${NS}-grow input{accent-color:var(--pcf-accent);}
.${NS}-grow i{width:9px;height:9px;border-radius:3px;display:inline-block;flex:none;}
.${NS}-grow .n{margin-left:auto;font-size:11.5px;color:var(--pcf-subtle);}
.${NS}-grow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.${NS}-gnew{display:flex;gap:6px;padding:4px 12px 9px;}
.${NS}-gnew input{flex:1;min-width:0;padding:5px 9px;border:1px solid var(--pcf-border);
  border-radius:var(--pcf-rc);background:var(--pcf-canvas);color:var(--pcf-text);font:inherit;font-size:12.5px;}
.${NS}-gnew input:focus{outline:none;border-color:var(--pcf-accent);}
.${NS}-bar-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--pcf-border);}
.${NS}-bar-foot .msg{flex:1;font-size:11.5px;color:var(--pcf-accent);}
.${NS}-btn{border:1px solid var(--pcf-border);background:var(--pcf-surface);color:var(--pcf-text);
  font:inherit;font-size:12.5px;padding:5px 12px;border-radius:var(--pcf-rc);cursor:pointer;
  transition:background .26s cubic-bezier(.22,1,.36,1);}
.${NS}-btn:hover{background:var(--pcf-canvas);}
.${NS}-btn.is-primary{background:var(--pcf-accent);border-color:var(--pcf-accent);color:#fff;font-weight:500;}
.${NS}-btn.is-primary:hover{filter:brightness(.94);}
.${NS}-toast{position:fixed;left:50%;bottom:32px;transform:translate(-50%,8px);z-index:2147483000;
  background:var(--pcf-text);color:var(--pcf-surface);padding:7px 16px;border-radius:999px;
  font-size:13px;font-family:var(--pcf-font);opacity:0;pointer-events:none;
  transition:opacity .3s cubic-bezier(.22,1,.36,1),transform .3s cubic-bezier(.22,1,.36,1);
  display:flex;align-items:center;gap:12px;}
.${NS}-toast.on{opacity:1;transform:translate(-50%,0);pointer-events:auto;}
.${NS}-toast button{background:transparent;border:0;color:var(--pcf-accent);font:inherit;font-size:13px;
  cursor:pointer;text-decoration:underline;padding:0;}
`;
    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================ 4. 轻提示 ============================

  function toast(msg, action) {
    const old = document.getElementById(NS + '-toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = NS + '-toast';
    el.className = NS + '-toast';
    el.innerHTML = '<span>' + esc(msg) + '</span>';
    if (action && action.label) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.addEventListener('click', () => { el.remove(); action.onClick && action.onClick(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 400);
    }, action ? 5000 : 1800);
  }

  // ============================ 5. 站点元素与元数据 ============================

  /** 找收藏按钮：优先在「作者与帖子操作」头行内查找，回退到全页按钮 */
  function findFavButton() {
    const head = document.querySelector(SEL.header);
    if (head) {
      const b = head.querySelector(SEL.fav) || Array.from(head.querySelectorAll('button[aria-label]'))
        .find((x) => (x.getAttribute('aria-label') || '').includes('收藏'));
      if (b) return b;
    }
    return Array.from(document.querySelectorAll('button[aria-label]'))
      .find((x) => (x.getAttribute('aria-label') || '').includes('收藏')) || null;
  }

  /** 收藏按钮当前是否处于「已收藏」态 */
  function isPressed(btn) {
    if (!btn) return false;
    const label = btn.getAttribute('aria-label') || '';
    return btn.getAttribute('aria-pressed') === 'true' || label.includes('已收藏');
  }

  /** 抓取收藏项元数据（ITM-01；抓取失败不阻塞，留空占位） */
  function extractMeta() {
    const art = document.querySelector('article.relative') || document.body;
    const h = art.querySelector(SEL.title) || document.querySelector(SEL.title);
    let title = h ? (h.innerText || '').trim() : '';
    if (!title) title = (document.title || '').split(/[|｜\-–—]/)[0].trim();

    let author = '';
    const head = document.querySelector(SEL.header);
    if (head) {
      const link = head.querySelector('a[href*="/profile/"]');
      if (link) author = (link.innerText || '').trim();
      if (!author) {
        const img = head.querySelector('img[alt]');
        if (img) author = (img.getAttribute('alt') || '').trim();
      }
    }

    let cover = '';
    const cov = document.querySelector(SEL.cover) || document.querySelector('article img');
    if (cov) cover = cov.getAttribute('src') || '';

    return { id: getPostId(), title, author, cover, url: location.href, type: '', savedAt: Date.now() };
  }

  // ============================ 6. 归组数据操作 ============================

  function groupCountOf(id) {
    const it = items[id];
    if (!it) return 0;
    const valid = new Set(groups.map((g) => g.id));
    return (it.groupIds || []).filter((x) => valid.has(x)).length;
  }

  /** 记录/刷新站点收藏成功的收藏项（已存在则只更新站点元数据，保留本地备注与归组） */
  function upsertOnFavorite() {
    const meta = extractMeta();
    if (!meta.id) return null;
    const old = items[meta.id];
    if (!old) {
      items[meta.id] = {
        id: meta.id, title: meta.title, author: meta.author, cover: meta.cover, url: meta.url,
        type: meta.type, savedAt: meta.savedAt, updatedAt: Date.now(), dead: 'normal',
        siteState: 'saved', note: '', tags: [], groupIds: [], manual: {}
      };
    } else {
      const manual = old.manual || {};
      ['title', 'author', 'cover', 'url'].forEach((k) => { if (!manual[k] && meta[k]) old[k] = meta[k]; });
      old.siteState = 'saved';
      old.updatedAt = Date.now();
    }
    return items[meta.id];
  }

  /** 站内联新建分组（GRP-01，同名复用不创建副本） */
  function createGroupInline(name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) return { error: '分组名不能为空' };
    if (clean.length > 24) return { error: '分组名不能超过 24 个字符' };
    const key = norm(clean);
    const exist = groups.find((g) => norm(g.name) === key);
    if (exist) return { group: exist, existed: true };
    const order = groups.length ? Math.max(...groups.map((g) => g.order || 0)) + 1 : 0;
    const group = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), name: clean, icon: '', color: groupColorByName(clean), order, pinned: false, collapsed: false, createdAt: Date.now() };
    groups.push(group);
    storageSet({ [KEYS.groups]: groups });
    return { group, existed: false };
  }

  /** 按行为设置把收藏项归入最近分组 / 收集箱 */
  function applyQuickBehavior(item) {
    const recent = settings.recentGroup;
    if (settings.behavior === 'recent' && recent && groups.some((g) => g.id === recent)) {
      item.groupIds = Array.from(new Set((item.groupIds || []).concat(recent)));
      const g = groups.find((x) => x.id === recent);
      toast('已收藏并归入「' + g.name + '」');
    } else {
      toast('已收藏，可在「未分组收集箱」中归组');
    }
  }

  // ============================ 7. 角标（COL-05 状态呈现） ============================

  function refreshBadge() {
    const btn = findFavButton();
    if (!btn) { badgeEl = null; return; }
    const id = getPostId();
    const n = groupCountOf(id);
    const label = n ? '收藏 · 已归入 ' + n + ' 个分组' : '收藏';
    btn.setAttribute('title', label);

    if (badgeEl && !btn.contains(badgeEl)) { badgeEl = null; }
    if (n > 0) {
      if (!badgeEl) {
        badgeEl = document.createElement('span');
        badgeEl.className = NS + '-badge';
        badgeEl.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openBar(); });
        // 站点按钮为图标按钮，绝对定位角标不参与其 flex 布局；按钮需有定位上下文
        if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
        btn.appendChild(badgeEl);
      }
      badgeEl.textContent = String(n);
      badgeEl.style.pointerEvents = 'auto';
      badgeEl.style.cursor = 'pointer';
    } else if (badgeEl && badgeEl.parentElement) {
      badgeEl.remove();
      badgeEl = null;
    }
  }

  // ============================ 8. 浮动补归组条（COL-06 / COL-01 / COL-05） ============================

  function closeBar() {
    if (barTimer) { clearTimeout(barTimer); barTimer = null; }
    if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    bar = null;
  }

  function scheduleDismiss() {
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(closeBar, AUTO_DISMISS);
  }

  /** 打开浮动条；勾选态默认回填该收藏项当前归属的分组 */
  function openBar() {
    if (!isPostPage()) return;
    closeBar();
    injectStyle();

    const id = getPostId();
    const item = items[id] || { groupIds: [] };
    const picked = new Set((item.groupIds || []).filter((g) => groups.some((x) => x.id === g)));

    const el = document.createElement('div');
    el.className = NS + '-bar';
    el.innerHTML =
      '<div class="' + NS + '-bar-head"><b>收藏到分组</b><span class="' + NS + '-cnt"></span></div>' +
      '<div class="' + NS + '-glist"></div>' +
      '<div class="' + NS + '-gnew">' +
        '<input type="text" maxlength="24" placeholder="新建分组，如：课堂素材">' +
        '<button class="' + NS + '-btn" data-new="1">新建</button>' +
      '</div>' +
      '<div class="' + NS + '-bar-foot">' +
        '<span class="msg"></span>' +
        '<button class="' + NS + '-btn" data-cancel="1">取消</button>' +
        '<button class="' + NS + '-btn is-primary" data-ok="1">完成</button>' +
      '</div>';

    const glist = el.querySelector('.' + NS + '-glist');
    const cnt = el.querySelector('.' + NS + '-cnt');
    const msg = el.querySelector('.msg');

    const renderList = () => {
      const counts = {};
      groups.forEach((g) => { counts[g.id] = 0; });
      Object.values(items).forEach((it) => (it.groupIds || []).forEach((gid) => { if (counts[gid] !== undefined) counts[gid]++; }));
      glist.innerHTML = groups.length
        ? groups.map((g) =>
            '<label class="' + NS + '-grow">' +
              '<input type="checkbox" value="' + g.id + '"' + (picked.has(g.id) ? ' checked' : '') + '>' +
              '<i style="background:' + (g.color || groupColorByName(g.name)) + '"></i>' +
              '<span class="nm">' + esc(g.name) + '</span>' +
              '<span class="n">' + (counts[g.id] || 0) + '</span>' +
            '</label>').join('')
        : '<div style="padding:10px 12px;color:var(--pcf-subtle);font-size:12.5px">还没有分组，可在下方新建。</div>';
      glist.querySelectorAll('input').forEach((cb) => {
        cb.addEventListener('change', () => {
          cb.checked ? picked.add(cb.value) : picked.delete(cb.value);
          cnt.textContent = '已选 ' + picked.size + ' 个';
        });
      });
      cnt.textContent = '已选 ' + picked.size + ' 个';
    };
    renderList();

    // 定位到收藏按钮正下方
    const btn = findFavButton();
    const rect = btn ? btn.getBoundingClientRect() : { bottom: 120, left: 40, right: 240 };
    el.style.top = Math.min(window.innerHeight - 60, rect.bottom + 8) + 'px';
    el.style.left = Math.max(8, Math.min(window.innerWidth - 300, rect.left)) + 'px';
    document.body.appendChild(el);
    bar = el;

    // 交互期间不自动关闭
    el.addEventListener('mouseenter', () => { if (barTimer) { clearTimeout(barTimer); barTimer = null; } });
    el.addEventListener('mouseleave', scheduleDismiss);
    scheduleDismiss();

    const input = el.querySelector('input[type="text"]');
    const doNew = () => {
      const r = createGroupInline(input.value);
      if (r.error) { msg.textContent = r.error; return; }
      picked.add(r.group.id);
      msg.textContent = r.existed ? '该分组已存在，已直接勾选' : '已新建并勾选';
      input.value = '';
      renderList();
    };
    el.querySelector('[data-new]').addEventListener('click', doNew);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doNew(); } });

    // 取消：不产生任何写入
    el.querySelector('[data-cancel]').addEventListener('click', closeBar);
    el.querySelector('[data-ok]').addEventListener('click', async () => {
      const it = items[id];
      if (it) {
        it.groupIds = Array.from(picked);
        it.updatedAt = Date.now();
        await saveItems();
        // 最近使用分组（COL-02）：取本次选择中的第一个
        const first = Array.from(picked)[0];
        if (first) { settings.recentGroup = first; await saveSettings(); }
        refreshBadge();
        toast(picked.size ? '已归入 ' + picked.size + ' 个分组' : '已移出所有分组，进入未分组收集箱');
      } else {
        toast('未找到该收藏项记录，请稍后重试');
      }
      closeBar();
    });

    // Esc 等同取消：不产生任何写入
    const onKey = (e) => {
      if (e.key === 'Escape' && bar === el) { closeBar(); document.removeEventListener('keydown', onKey, true); }
    };
    document.addEventListener('keydown', onKey, true);
  }

  // ============================ 9. 状态翻转处理 ============================

  async function handlePressedChange(btn) {
    const id = getPostId();
    const pressed = isPressed(btn);

    if (pressed) {
      // 站点收藏成功 → 记录收藏项并归组
      const item = upsertOnFavorite();
      if (!item) return;
      await saveItems();
      if (settings.behavior === 'panel') openBar();
      else { applyQuickBehavior(item); await saveItems(); }
      refreshBadge();
    } else {
      // 站点取消收藏 → 按设置联动
      const it = items[id];
      if (!it) return;
      const mode = settings.onUnfavorite;
      if (mode === 'remove') it.groupIds = [];
      it.siteState = 'unsaved';
      it.updatedAt = Date.now();
      await saveItems();
      refreshBadge();
      if (mode === 'prompt') {
        toast('站点已取消收藏，本地记录仍保留', {
          label: '撤销',
          onClick: async () => {
            const cur = items[id];
            if (!cur) return;
            cur.siteState = 'saved';
            await saveItems();
            refreshBadge();
          }
        });
      } else if (mode === 'keep') {
        toast('站点已取消收藏，归组已保留并标记');
      } else {
        toast('站点已取消收藏，归组关系已移除');
      }
    }
  }

  // ============================ 10. 挂载与看护 ============================

  function unmount() {
    closeBar();
    if (badgeEl && badgeEl.parentElement) badgeEl.remove();
    badgeEl = null;
    mountedPostId = '';
    lastPressed = null;
  }

  function tick() {
    if (!isPostPage() || !settings.enabled || !settings.siteInject) {
      if (bar) closeBar();
      if (badgeEl && badgeEl.parentElement) badgeEl.remove();
      badgeEl = null;
      lastPressed = null;
      return;
    }
    const pid = getPostId();
    if (pid !== mountedPostId) {
      // 切换帖子：清理旧 UI 与状态
      closeBar();
      if (badgeEl && badgeEl.parentElement) badgeEl.remove();
      badgeEl = null;
      mountedPostId = pid;
      lastPressed = null;
    }
    const btn = findFavButton();
    if (!btn) return;

    const pressed = isPressed(btn);
    if (lastPressed === null) {
      // 首次只记录基线，不触发归组（避免进入已收藏帖子时误弹）
      lastPressed = pressed;
      refreshBadge();
      return;
    }
    if (pressed !== lastPressed) {
      lastPressed = pressed;
      handlePressedChange(btn);
    }
    refreshBadge();
  }

  // ============================ 11. 启动 ============================

  (async () => {
    if (!extAlive()) return;      // 扩展已重载：旧脚本直接退出
    await loadState();
    if (!extAlive()) return;
    injectStyle();

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[KEYS.settings]) settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.settings].newValue || {}) };
        if (changes[KEYS.groups]) groups = (changes[KEYS.groups].newValue || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        if (changes[KEYS.items]) items = changes[KEYS.items].newValue || {};
        refreshBadge();
      });
    } catch (e) {
      return;                     // 上下文失效，后续看护不再启动
    }

    // SPA 路由与按钮重渲染看护
    let lastHref = location.href;
    const timer = setInterval(() => {
      if (!extAlive()) {
        clearInterval(timer);
        if (mo) mo.disconnect();
        unmount();
        return;
      }
      if (location.href !== lastHref) { lastHref = location.href; unmount(); }
      tick();
    }, 700);

    // 站点按钮 aria 变化即时响应（收藏按钮可能被 SPA 重渲染）
    const mo = new MutationObserver(() => { tick(); });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-pressed', 'aria-label']
    });

    tick();
  })();

  // 调试句柄（不影响站点）
  window.__pickcatFav = {
    get settings() { return settings; },
    get groups() { return groups; },
    get items() { return items; },
    openBar,
    tick
  };
})();
