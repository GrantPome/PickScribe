/**
 * 收藏夹 Plus —— 管理台（弹窗 / 标签页共用的视图与交互层）
 *
 * 职责：分组切换条 + 搜索 + 标签筛选 + 失效筛选 + 视图密度 + 排序 +
 *      多选与批量整理 + 收藏项详情抽屉（备注 / 标签 / 归属）+ 分组管理。
 *
 * 用法：mountConsole(rootEl, { mode:'popup'|'tab', onOpenTab })
 *   - popup 模式：rootEl 为弹窗中的容器，底部提供「在标签页中打开」（UI-06）；
 *   - tab 模式：作为完整工作台，适配更宽画布。
 *
 * 所有结构性操作在动作当下立即持久化（弹窗会话约束），筛选与滚动位置持久化后下次恢复。
 */
import * as F from '../shared/favorites.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 收藏项封面占位：按 id 哈希取稳定渐变底色，避免空白等待 */
function coverStyle(id) {
  const palette = [
    ['#c7d6ff', '#e6ecff'], ['#ffe0cf', '#fff0e6'], ['#cdeee0', '#e9f7f1'],
    ['#e2d4ff', '#f4eefe'], ['#ffe1ea', '#fff0f4'], ['#d5e8ff', '#eef5ff']
  ];
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const c = palette[h % palette.length];
  return 'background:linear-gradient(135deg,' + c[0] + ',' + c[1] + ')';
}

export function mountConsole(root, opts = {}) {
  const mode = opts.mode === 'tab' ? 'tab' : 'popup';

  // ============================ 状态 ============================
  let groups = [];
  let items = [];
  let counts = { all: 0, inbox: 0, byGroup: {} };
  let settings = { ...F.DEFAULT_FAV_SETTINGS };
  const view = { group: 'all', query: '', tags: [], onlyDead: false, sort: 'time-desc', density: 'grid' };
  let selected = new Set();
  let previewId = null;
  let lastIndex = -1;          // Shift 区间选择的锚点
  let newGroupOpen = false;

  const groupById = (id) => groups.find((g) => g.id === id) || null;
  const validIds = () => groups.map((g) => g.id);

  // ============================ 骨架 ============================
  root.classList.add('pcf-console');
  root.classList.add(mode === 'tab' ? 'is-tab' : 'is-popup');
  root.innerHTML =
    '<div class="pcf-bar">' +
      '<span class="pcf-brand"><span class="pcf-logo"></span>收藏 Plus</span>' +
      '<span class="pcf-search"><input class="pcf-q" type="text" placeholder="搜索标题、作者、备注、标签…"><button class="pcf-qclear" data-act="qclear" title="清空">✕</button></span>' +
      '<button class="pcf-ico" data-act="dead" title="仅看失效">⚠</button>' +
      '<button class="pcf-ico" data-act="density" title="网格 / 列表"></button>' +
      '<select class="pcf-sort" title="排序方式"></select>' +
      '<button class="pcf-ico" data-act="newgroup" title="新建分组">＋</button>' +
      '<button class="pcf-ico" data-act="manage" title="管理分组">⚙</button>' +
    '</div>' +
    '<div class="pcf-gbar"><div class="pcf-groups"></div></div>' +
    '<div class="pcf-newrow" hidden><input class="pcf-newinput" type="text" maxlength="24" placeholder="新建分组名，回车创建"><span class="pcf-newmsg"></span></div>' +
    '<div class="pcf-tags"></div>' +
    '<div class="pcf-body"><div class="pcf-list"></div></div>' +
    '<div class="pcf-selbar" hidden></div>' +
    '<div class="pcf-foot"><span class="pcf-cond"></span>' +
      (mode === 'popup' ? '<button class="pcf-btn" data-act="opentab">在标签页中打开</button>' : '') +
    '</div>';

  const el = {
    bar: root.querySelector('.pcf-bar'),
    q: root.querySelector('.pcf-q'),
    qclear: root.querySelector('.pcf-qclear'),
    sort: root.querySelector('.pcf-sort'),
    densityBtn: root.querySelector('[data-act="density"]'),
    deadBtn: root.querySelector('[data-act="dead"]'),
    groups: root.querySelector('.pcf-groups'),
    newrow: root.querySelector('.pcf-newrow'),
    newinput: root.querySelector('.pcf-newinput'),
    newmsg: root.querySelector('.pcf-newmsg'),
    tags: root.querySelector('.pcf-tags'),
    body: root.querySelector('.pcf-body'),
    list: root.querySelector('.pcf-list'),
    selbar: root.querySelector('.pcf-selbar'),
    cond: root.querySelector('.pcf-cond'),
    foot: root.querySelector('.pcf-foot')
  };

  // ============================ 数据加载 ============================

  async function reload() {
    const [g, list, c, s] = await Promise.all([F.getGroups(), F.getItems(), F.getCounts(), F.getSettings()]);
    groups = g;
    items = list;
    counts = c;
    settings = s;
  }

  /** 首次进入：恢复上次的分组与筛选条件（BRW-03 筛选状态持久化） */
  async function restoreView() {
    const ui = await F.getUiState();
    view.group = ui.group || 'all';
    view.query = ui.query || '';
    view.tags = Array.isArray(ui.tags) ? ui.tags.slice() : [];
    view.onlyDead = !!ui.onlyDead;
    view.sort = ui.sort || settings.sort || 'time-desc';
    view.density = ui.density || settings.density || 'grid';
    el.q.value = view.query;
    if (ui.scrollTop) requestAnimationFrame(() => { el.body.scrollTop = ui.scrollTop || 0; });
  }

  const saveView = () => F.patchUiState({
    group: view.group, query: view.query, tags: view.tags, onlyDead: view.onlyDead,
    sort: view.sort, density: view.density
  });
  let scrollTimer = null;
  el.body.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => F.patchUiState({ scrollTop: el.body.scrollTop }), 300);
  });

  // ============================ 渲染：工具栏 ============================

  function renderBar() {
    el.qclear.hidden = !view.query;
    el.sort.innerHTML = F.SORT_OPTIONS.map((o) => '<option value="' + o.id + '">' + esc(o.name) + '</option>').join('');
    el.sort.value = view.sort;
    el.densityBtn.textContent = view.density === 'grid' ? '▦' : '☰';
    el.deadBtn.classList.toggle('is-on', view.onlyDead);
    el.deadBtn.title = view.onlyDead ? '显示全部' : '仅看失效';
  }

  // ============================ 渲染：分组切换条（BRW-01 / GRP-05） ============================

  function renderGroups() {
    const sys = F.SYSTEM_VIEWS.map((v) =>
      '<button class="pcf-gchip' + (view.group === v.id ? ' is-on' : '') + '" data-g="' + v.id + '">' +
        esc(v.name) + '<span class="n">' + (v.id === 'all' ? counts.all : counts.inbox) + '</span>' +
      '</button>').join('');

    // 置顶分组固定在前；折叠分组在切换条中收纳（GRP-05）
    const ordered = groups.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order || 0) - (b.order || 0));
    const shown = ordered.filter((g) => !g.collapsed);
    const hiddenCollapsed = ordered.filter((g) => g.collapsed);

    const mine = shown.map((g) =>
      '<button class="pcf-gchip' + (view.group === g.id ? ' is-on' : '') + '" data-g="' + g.id + '">' +
        (g.pinned ? '<span class="pin">📌</span>' : '') +
        '<i class="dot" style="background:' + esc(g.color || F.groupColorByName(g.name)) + '"></i>' +
        esc(g.name) + '<span class="n">' + (counts.byGroup[g.id] || 0) + '</span>' +
      '</button>').join('');

    const collapsedChip = hiddenCollapsed.length
      ? '<button class="pcf-gchip pcf-gmore" data-act="showcollapsed">已折叠 ' + hiddenCollapsed.length + ' 个 ▾</button>'
      : '';

    el.groups.innerHTML = sys +
      '<span class="pcf-gsep"></span>' + mine + collapsedChip;
  }

  /** 展开被折叠的分组（临时展开，不改变折叠设置） */
  let expandedCollapsed = false;
  function renderGroupsWithExpanded() {
    if (!expandedCollapsed) return renderGroups();
    const sys = F.SYSTEM_VIEWS.map((v) =>
      '<button class="pcf-gchip' + (view.group === v.id ? ' is-on' : '') + '" data-g="' + v.id + '">' +
        esc(v.name) + '<span class="n">' + (v.id === 'all' ? counts.all : counts.inbox) + '</span></button>').join('');
    const mine = groups.map((g) =>
      '<button class="pcf-gchip' + (view.group === g.id ? ' is-on' : '') + '" data-g="' + g.id + '">' +
        '<i class="dot" style="background:' + esc(g.color || F.groupColorByName(g.name)) + '"></i>' +
        esc(g.name) + '<span class="n">' + (counts.byGroup[g.id] || 0) + '</span></button>').join('');
    el.groups.innerHTML = sys + '<span class="pcf-gsep"></span>' + mine +
      '<button class="pcf-gchip pcf-gmore" data-act="hidecollapsed">收起 ▴</button>';
  }

  // ============================ 渲染：标签栏（BRW-04） ============================

  function renderTags() {
    // 标签栏只展示当前结果集（受分组 + 搜索 + 失效约束）中实际出现的标签
    const { tags } = F.tagsInResult(items, view, validIds());
    el.tags.innerHTML = tags.length
      ? tags.map((t) => '<button class="pcf-tchip' + (view.tags.includes(t.name) ? ' is-on' : '') +
          '" data-t="' + esc(t.name) + '">' + esc(t.name) + (t.count > 1 ? '<span class="n">' + t.count + '</span>' : '') + '</button>').join('')
      : '';
    el.tags.hidden = !tags.length;
  }

  // ============================ 渲染：内容区（BRW-05 / ITM-05 / ORG-01） ============================

  const selectedCount = () => selected.size;

  function renderList() {
    const res = F.filterItems(items, view, validIds());

    if (!res.length) {
      el.list.innerHTML = '<div class="pcf-empty">没有符合条件的收藏项<br>' +
        '<span>可尝试减少标签筛选，或切换到「未分组收集箱」整理新收藏</span></div>';
      renderFooter(res.length);
      renderSelBar();
      return;
    }

    if (view.density === 'list') {
      el.list.innerHTML = '<div class="pcf-lrows">' + res.map((it, i) => {
        const gs = (it.groupIds || []).map((id) => groupById(id)).filter(Boolean);
        return '<div class="pcf-lrow' + (selected.has(it.id) ? ' is-sel' : '') + (F.isDead(it) ? ' is-dead' : '') +
          '" data-id="' + esc(it.id) + '" data-i="' + i + '">' +
          '<label class="pcf-ck"><input type="checkbox" data-ck="' + esc(it.id) + '"' + (selected.has(it.id) ? ' checked' : '') + '></label>' +
          '<span class="pcf-cthumb" style="' + coverStyle(it.id) + '"></span>' +
          '<span class="pcf-ct">' + esc(it.title || '未命名帖子') + (F.isDead(it) ? '<span class="pcf-badge-dead">已失效</span>' : '') + '</span>' +
          '<span class="pcf-ca">' + esc(it.author || '未知作者') + '</span>' +
          '<span class="pcf-cg">' + esc(gs.length ? gs.map((g) => g.name).join(' / ') : '未分组') + '</span>' +
          '<span class="pcf-ctime">' + esc(F.formatTime(it.savedAt)) + '</span>' +
          '</div>';
      }).join('') + '</div>';
    } else {
      el.list.innerHTML = '<div class="pcf-grid">' + res.map((it, i) => {
        const gs = (it.groupIds || []).map((id) => groupById(id)).filter(Boolean);
        const note = it.note ? '<div class="pcf-cnote">备注：' + esc(it.note) + '</div>' : '';
        return '<div class="pcf-card' + (selected.has(it.id) ? ' is-sel' : '') + '" data-id="' + esc(it.id) + '" data-i="' + i + '">' +
          '<div class="pcf-cv" style="' + coverStyle(it.id) + '">' +
            (F.isDead(it) ? '<span class="pcf-badge-dead">已失效</span>' : '') +
            (it.siteState === 'unsaved' ? '<span class="pcf-badge-un">站点已取消</span>' : '') +
            '<label class="pcf-ck"><input type="checkbox" data-ck="' + esc(it.id) + '"' + (selected.has(it.id) ? ' checked' : '') + '></label>' +
          '</div>' +
          '<div class="pcf-cbody">' +
            '<div class="pcf-ct">' + esc(it.title || '未命名帖子') + '</div>' +
            '<div class="pcf-cm"><span>' + esc(it.author || '未知作者') + '</span><span>' + esc(F.formatTime(it.savedAt)) + '</span></div>' +
            '<div class="pcf-cm2">' + esc(gs.length ? gs.map((g) => g.name).join(' / ') : '未分组') +
              ((it.tags || []).length ? ' ｜ ' + esc(it.tags.join(' · ')) : '') + '</div>' +
            note +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    renderFooter(res.length);
    renderSelBar();
  }

  function renderFooter(hit) {
    const parts = [];
    parts.push(view.group === 'all' ? '全部收藏'
      : view.group === 'inbox' ? '未分组收集箱'
      : '分组：' + ((groupById(view.group) || {}).name || '—'));
    if (view.tags.length) parts.push('标签：' + view.tags.join(' + '));
    if (view.query) parts.push('搜索：' + view.query);
    if (view.onlyDead) parts.push('仅看失效');
    el.cond.textContent = parts.join(' ｜ ') + ' ｜ 命中 ' + hit + ' 项';
  }

  // ============================ 渲染：多选批量条（ORG-01/02/04） ============================

  function renderSelBar() {
    const n = selectedCount();
    el.selbar.hidden = n === 0;
    if (!n) { el.selbar.innerHTML = ''; return; }
    const customGroup = view.group !== 'all' && view.group !== 'inbox';
    el.selbar.innerHTML =
      '<span class="pcf-seln">已选 ' + n + ' 项</span>' +
      '<button class="pcf-btn" data-act="b-add">加入分组</button>' +
      '<button class="pcf-btn" data-act="b-remove"' + (customGroup ? '' : ' disabled') + '>移出当前分组</button>' +
      '<button class="pcf-btn" data-act="b-tag">打标签</button>' +
      '<button class="pcf-btn is-danger" data-act="b-del">移除记录</button>' +
      '<button class="pcf-btn" data-act="b-clear">取消选择</button>';
  }

  // ============================ 渲染总入口 ============================

  function render() {
    renderBar();
    expandedCollapsed ? renderGroupsWithExpanded() : renderGroups();
    renderTags();
    renderList();
  }

  // ============================ 收藏项详情抽屉（BRW-06 / ITM-02 / ITM-03 / ITM-04） ============================

  function openPreview(id) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    previewId = id;
    const gs = it.groupIds || [];
    const dlg = document.createElement('div');
    dlg.className = 'pcf-drawer';
    dlg.innerHTML =
      '<div class="pcf-dbg" data-close="1"></div>' +
      '<div class="pcf-dpanel">' +
        '<div class="pcf-dhead"><b>收藏项详情</b><button class="pcf-ico" data-close="1">✕</button></div>' +
        '<div class="pcf-dscroll">' +
          '<div class="pcf-dcover" style="' + coverStyle(it.id) + '"></div>' +
          '<label class="pcf-f"><span>标题（可手动修正）</span><input class="pcf-dtitle" value="' + esc(it.title || '') + '" maxlength="120" placeholder="未命名帖子"></label>' +
          '<div class="pcf-dmeta">作者：' + esc(it.author || '未知作者') + ' ｜ 收藏于 ' + esc(F.formatTime(it.savedAt)) +
            (F.isDead(it) ? ' ｜ <b class="pcf-danger">已失效</b>' : '') + '</div>' +
          '<div class="pcf-f"><span>所属分组（勾选即加入 / 取消即移出）</span><div class="pcf-dgroups"></div></div>' +
          '<label class="pcf-f"><span>标签（回车添加，上限 10 个）</span><div class="pcf-dtags"></div><input class="pcf-dtaginput" placeholder="输入标签后回车"></label>' +
          '<label class="pcf-f"><span>备注（上限 500 字）</span><textarea class="pcf-dnote" rows="3" maxlength="500" placeholder="写点笔记…">' + esc(it.note || '') + '</textarea></label>' +
        '</div>' +
        '<div class="pcf-dfoot">' +
          '<button class="pcf-btn" data-act="openurl">打开原帖</button>' +
          '<span class="spacer"></span>' +
          '<button class="pcf-btn is-danger" data-act="rem">移除记录</button>' +
        '</div>' +
      '</div>';
    root.appendChild(dlg);

    const dgroups = dlg.querySelector('.pcf-dgroups');
    const renderDgroups = () => {
      dgroups.innerHTML = groups.length
        ? groups.map((g) => '<label class="pcf-dgrow"><input type="checkbox" value="' + g.id + '"' +
            (gs.includes(g.id) ? ' checked' : '') + '><i style="background:' + esc(g.color || F.groupColorByName(g.name)) + '"></i> ' +
            esc(g.name) + '</label>').join('')
        : '<span class="pcf-muted">还没有分组</span>';
      dgroups.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', async () => {
        cb.checked ? await F.addToGroup([id], cb.value) : await F.removeFromGroup([id], cb.value);
        await refresh();
        const cur = items.find((x) => x.id === id);
        gs.length = 0;
        (cur ? cur.groupIds : []).forEach((x) => gs.push(x));
      }));
    };
    renderDgroups();

    const dtags = dlg.querySelector('.pcf-dtags');
    const renderDtags = () => {
      dtags.innerHTML = (it.tags || []).length
        ? it.tags.map((t) => '<span class="pcf-tagx">' + esc(t) + '<button data-rm="' + esc(t) + '">✕</button></span>').join('')
        : '<span class="pcf-muted">还没有标签</span>';
      dtags.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
        await F.removeTag([id], b.getAttribute('data-rm'));
        await refresh();
        const cur = items.find((x) => x.id === id);
        it.tags = cur ? cur.tags : [];
        renderDtags();
      }));
    };
    renderDtags();

    const tagInput = dlg.querySelector('.pcf-dtaginput');
    tagInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = tagInput.value.trim();
      if (!v) return;
      await F.addTags([id], [v]);
      tagInput.value = '';
      await refresh();
      const cur = items.find((x) => x.id === id);
      it.tags = cur ? cur.tags : [];
      renderDtags();
    });

    const titleInput = dlg.querySelector('.pcf-dtitle');
    titleInput.addEventListener('change', async () => {
      await F.patchItem(id, { title: titleInput.value.trim() || '未命名帖子' });
      await refresh();
    });

    const noteEl = dlg.querySelector('.pcf-dnote');
    noteEl.addEventListener('change', async () => {
      await F.setNote(id, noteEl.value);
      await refresh();
    });

    dlg.querySelector('[data-act="openurl"]').addEventListener('click', () => {
      if (it.url) window.open(it.url, '_blank', 'noopener');
    });
    dlg.querySelector('[data-act="rem"]').addEventListener('click', async () => {
      if (!confirm('仅从插件本地移除这条记录，站点收藏不受影响。是否继续？')) return;
      await F.removeItems([id]);
      closePreview();
      await refresh();
    });
    dlg.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', closePreview));
  }

  function closePreview() {
    previewId = null;
    const d = root.querySelector('.pcf-drawer');
    if (d) d.remove();
  }

  // ============================ 分组管理（GRP-02 / GRP-03 / GRP-04 / GRP-05） ============================

  function openManage() {
    const dlg = document.createElement('div');
    dlg.className = 'pcf-modal';
    dlg.innerHTML =
      '<div class="pcf-dbg" data-close="1"></div>' +
      '<div class="pcf-mpanel">' +
        '<div class="pcf-dhead"><b>管理分组</b><button class="pcf-ico" data-close="1">✕</button></div>' +
        '<p class="pcf-mhint">拖拽左侧手柄排序；删除分组前必须为成员选择去向，不允许成员凭空消失。</p>' +
        '<div class="pcf-mlist"></div>' +
        '<div class="pcf-dfoot"><button class="pcf-btn" data-act="add">＋ 新建分组</button></div>' +
      '</div>';
    root.appendChild(dlg);

    const list = dlg.querySelector('.pcf-mlist');

    const renderM = () => {
      list.innerHTML = groups.length ? groups.map((g, i) =>
        '<div class="pcf-mrow" draggable="true" data-id="' + g.id + '">' +
          '<span class="pcf-grip" title="拖拽排序">⠿</span>' +
          '<input class="pcf-mname" value="' + esc(g.name) + '" maxlength="24">' +
          '<button class="pcf-mcolor" data-color="' + g.id + '" title="颜色" style="background:' + esc(g.color || F.groupColorByName(g.name)) + '"></button>' +
          '<button class="pcf-micon" data-icon="' + g.id + '" title="图标">' + esc(g.icon || '📁') + '</button>' +
          '<button class="pcf-mpin' + (g.pinned ? ' is-on' : '') + '" data-pin="' + g.id + '" title="置顶">📌</button>' +
          '<button class="pcf-mfold' + (g.collapsed ? ' is-on' : '') + '" data-fold="' + g.id + '" title="折叠">🗂</button>' +
          '<button class="pcf-mdel" data-del="' + g.id + '" title="删除">🗑</button>' +
        '</div>').join('')
        : '<div class="pcf-empty">还没有分组，点下方新建。</div>';

      // 排序：HTML5 拖拽
      let dragId = null;
      list.querySelectorAll('.pcf-mrow').forEach((row) => {
        row.addEventListener('dragstart', () => { dragId = row.dataset.id; row.classList.add('is-drag'); });
        row.addEventListener('dragend', () => { row.classList.remove('is-drag'); dragId = null; });
        row.addEventListener('dragover', (e) => e.preventDefault());
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          const targetId = row.dataset.id;
          if (!dragId || dragId === targetId) return;
          const ids = groups.map((g) => g.id);
          const from = ids.indexOf(dragId);
          const to = ids.indexOf(targetId);
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          await F.reorderGroups(ids);
          await refresh();
          renderM();
        });
      });

      list.querySelectorAll('.pcf-mname').forEach((inp) => inp.addEventListener('change', async () => {
        const r = await F.updateGroup(inp.closest('.pcf-mrow').dataset.id, { name: inp.value });
        if (r && r.error) { alert(r.error); inp.value = (groups.find((g) => g.id === inp.closest('.pcf-mrow').dataset.id) || {}).name || ''; }
        await refresh();
        renderM();
      }));

      list.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-color');
        const cur = (groups.find((g) => g.id === id) || {}).color || F.GROUP_COLORS[0];
        const idx = F.GROUP_COLORS.indexOf(cur);
        const next = F.GROUP_COLORS[(idx + 1 + F.GROUP_COLORS.length) % F.GROUP_COLORS.length];
        await F.updateGroup(id, { color: next });
        await refresh(); renderM();
      }));

      list.querySelectorAll('[data-icon]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-icon');
        const cur = (groups.find((g) => g.id === id) || {}).icon || '';
        const idx = F.GROUP_ICONS.indexOf(cur);
        const next = F.GROUP_ICONS[(idx + 1) % F.GROUP_ICONS.length];
        await F.updateGroup(id, { icon: next });
        await refresh(); renderM();
      }));

      list.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-pin');
        const g = groups.find((x) => x.id === id);
        await F.updateGroup(id, { pinned: !g.pinned });
        await refresh(); renderM();
      }));

      list.querySelectorAll('[data-fold]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-fold');
        const g = groups.find((x) => x.id === id);
        await F.updateGroup(id, { collapsed: !g.collapsed });
        await refresh(); renderM();
      }));

      list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-del');
        const g = groups.find((x) => x.id === id);
        const others = groups.filter((x) => x.id !== id);
        const dest = others.length
          ? prompt('删除「' + g.name + '」后，其成员移到哪里？\n输入目标分组序号（留空 = 移入未分组收集箱）：\n' +
              others.map((x, i) => (i + 1) + '. ' + x.name).join('\n'))
          : '';
        if (dest === null) return;
        const opt = dest.trim()
          ? { mode: 'group', targetId: others[Number(dest.trim()) - 1] ? others[Number(dest.trim()) - 1].id : '' }
          : { mode: 'inbox' };
        if (opt.mode === 'group' && !opt.targetId) { alert('未匹配到该序号，已取消删除'); return; }
        const r = await F.deleteGroup(id, opt);
        if (r && r.error) { alert(r.error); return; }
        if (view.group === id) view.group = 'all';
        await refresh(); renderM();
      }));
    };
    renderM();

    dlg.querySelector('[data-act="add"]').addEventListener('click', async () => {
      const name = prompt('新建分组名称（1–24 字）：');
      if (name === null) return;
      const r = await F.createGroup(name);
      if (r && r.error) { alert(r.error); return; }
      await refresh();
      renderM();
    });
    dlg.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', () => dlg.remove()));
  }

  // ============================ 批量操作 ============================

  function openBatchAddGroups() {
    const ids = Array.from(selected);
    const dlg = document.createElement('div');
    dlg.className = 'pcf-modal';
    dlg.innerHTML =
      '<div class="pcf-dbg" data-close="1"></div>' +
      '<div class="pcf-mpanel is-slim">' +
        '<div class="pcf-dhead"><b>加入分组（' + ids.length + ' 项）</b><button class="pcf-ico" data-close="1">✕</button></div>' +
        '<div class="pcf-picklist">' +
          (groups.length ? groups.map((g) => '<label class="pcf-dgrow"><input type="checkbox" value="' + g.id + '"> ' + esc(g.name) + '</label>').join('') : '<span class="pcf-muted">还没有分组</span>') +
        '</div>' +
        '<div class="pcf-dfoot"><span class="spacer"></span><button class="pcf-btn is-primary" data-ok="1">加入</button></div>' +
      '</div>';
    root.appendChild(dlg);
    dlg.querySelector('[data-ok]').addEventListener('click', async () => {
      const picked = Array.from(dlg.querySelectorAll('input:checked')).map((c) => c.value);
      if (!picked.length) { alert('请至少选择一个分组'); return; }
      for (const gid of picked) await F.addToGroup(ids, gid);
      dlg.remove();
      selected.clear();
      await refresh();
      toast('已加入 ' + picked.length + ' 个分组');
    });
    dlg.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', () => dlg.remove()));
  }

  function openBatchAddTags() {
    const ids = Array.from(selected);
    const dlg = document.createElement('div');
    dlg.className = 'pcf-modal';
    dlg.innerHTML =
      '<div class="pcf-dbg" data-close="1"></div>' +
      '<div class="pcf-mpanel is-slim">' +
        '<div class="pcf-dhead"><b>打标签（' + ids.length + ' 项）</b><button class="pcf-ico" data-close="1">✕</button></div>' +
        '<div class="pcf-f" style="padding:12px 14px"><span>标签名（1–16 字，多个用空格分隔）</span><input class="pcf-taginp" placeholder="如：绘画 工具"></div>' +
        '<div class="pcf-dfoot"><span class="spacer"></span><button class="pcf-btn is-primary" data-ok="1">添加</button></div>' +
      '</div>';
    root.appendChild(dlg);
    const inp = dlg.querySelector('.pcf-taginp');
    inp.focus();
    dlg.querySelector('[data-ok]').addEventListener('click', async () => {
      const tags = inp.value.split(/\s+/).filter(Boolean);
      if (!tags.length) { alert('请输入标签名'); return; }
      const n = await F.addTags(ids, tags);
      dlg.remove();
      selected.clear();
      await refresh();
      toast('已为 ' + ids.length + ' 项添加标签' + (n ? '' : '（已存在，未重复添加）'));
    });
    dlg.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', () => dlg.remove()));
  }

  function toast(msg) {
    const old = root.querySelector('.pcf-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'pcf-toast';
    t.textContent = msg;
    root.appendChild(t);
    requestAnimationFrame(() => t.classList.add('on'));
    setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 400); }, 1800);
  }

  // ============================ 多选交互（ORG-01） ============================

  function toggleSelect(id, index, e) {
    const shift = e && e.shiftKey;
    const ctrl = e && (e.ctrlKey || e.metaKey);
    const visIds = F.filterItems(items, view, validIds()).map((x) => x.id);

    if (shift && lastIndex >= 0) {
      const a = Math.min(lastIndex, index);
      const b = Math.max(lastIndex, index);
      for (let i = a; i <= b; i++) selected.add(visIds[i]);
    } else if (ctrl) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
    } else {
      selected.has(id) ? selected.delete(id) : selected.add(id);
    }
    lastIndex = index;
  }

  // ============================ 事件绑定 ============================

  el.q.addEventListener('input', () => { view.query = el.q.value.trim(); saveView(); render(); });

  el.sort.addEventListener('change', () => { view.sort = el.sort.value; saveView(); render(); });

  el.bar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'qclear') { el.q.value = ''; view.query = ''; saveView(); render(); el.q.focus(); }
    else if (act === 'dead') { view.onlyDead = !view.onlyDead; saveView(); render(); }
    else if (act === 'density') { view.density = view.density === 'grid' ? 'list' : 'grid'; saveView(); render(); }
    else if (act === 'newgroup') { newGroupOpen = !newGroupOpen; el.newrow.hidden = !newGroupOpen; if (newGroupOpen) el.newinput.focus(); }
    else if (act === 'manage') openManage();
  });

  el.newinput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const r = await F.createGroup(el.newinput.value);
    if (r && r.error) { el.newmsg.textContent = r.error; return; }
    el.newinput.value = '';
    el.newmsg.textContent = r.existed ? '该分组已存在' : '已创建';
    await refresh();
    render();
  });

  el.groups.addEventListener('click', (e) => {
    const more = e.target.closest('[data-act]');
    if (more) {
      expandedCollapsed = more.getAttribute('data-act') === 'showcollapsed';
      render();
      return;
    }
    const chip = e.target.closest('[data-g]');
    if (!chip) return;
    view.group = chip.getAttribute('data-g');
    selected.clear();
    saveView();
    render();
  });

  el.tags.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (!t) return;
    const name = t.getAttribute('data-t');
    const i = view.tags.indexOf(name);
    i >= 0 ? view.tags.splice(i, 1) : view.tags.push(name);
    saveView();
    render();
  });

  el.list.addEventListener('click', (e) => {
    const ck = e.target.closest('[data-ck]');
    const card = e.target.closest('[data-id]');
    if (!card) return;
    const id = card.getAttribute('data-id');
    const index = Number(card.getAttribute('data-i'));

    if (ck) {
      e.stopPropagation();
      toggleSelect(id, index, e);
      renderList();
      return;
    }
    // 卡片主体：Ctrl/Shift 多选；普通点击打开详情抽屉
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      toggleSelect(id, index, e);
      renderList();
      return;
    }
    openPreview(id);
  });

  el.selbar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'b-add') openBatchAddGroups();
    else if (act === 'b-tag') openBatchAddTags();
    else if (act === 'b-remove') {
      const n = await F.removeFromGroup(Array.from(selected), view.group);
      selected.clear();
      await refresh();
      toast('已从当前分组移出 ' + n + ' 项');
    } else if (act === 'b-del') {
      const ids = Array.from(selected);
      if (!confirm('仅从插件本地移除这 ' + ids.length + ' 条记录，站点收藏不受影响。是否继续？')) return;
      await F.removeItems(ids);
      selected.clear();
      await refresh();
      toast('已移除 ' + ids.length + ' 条本地记录');
    } else if (act === 'b-clear') {
      selected.clear();
      renderList();
    }
  });

  if (mode === 'popup') {
    root.querySelector('[data-act="opentab"]').addEventListener('click', () => {
      if (opts.onOpenTab) opts.onOpenTab();
      else chrome.tabs.create({ url: chrome.runtime.getURL('favorites/favorites.html') });
    });
  }

  // Esc：优先关抽屉/弹层，其次清空选择
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const top = root.querySelector('.pcf-drawer, .pcf-modal');
    if (top) { top.remove(); previewId = null; return; }
    if (selected.size) { selected.clear(); renderList(); }
  };
  document.addEventListener('keydown', onKey);

  // ============================ 对外 API ============================

  async function refresh() {
    await reload();
    if (previewId && !items.some((x) => x.id === previewId)) closePreview();
    render();
  }

  const offSettings = F.onSettingsChange((s) => {
    settings = s;
    if (!settings.enabled) return;
    render();
  });

  async function init() {
    await reload();
    await restoreView();
    render();
  }

  return {
    refresh,
    init,
    destroy() {
      offSettings && offSettings();
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
    }
  };
}
