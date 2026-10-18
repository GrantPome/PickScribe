/**
 * 收藏夹 Plus —— 本地数据层（chrome.storage.local）
 *
 * 设计原则（对应 PRD 第 3 节「数据源单一」）：
 *   - 收藏项本体来自站点收藏夹，插件只在本地附加「分组 / 标签 / 备注」三样站点没有的数据；
 *   - 该模块供 background / options / popup / favorites 页以 ES module 方式导入；
 *     站点内容脚本（favorites/content.js）为经典脚本、无法 import，故只按同一份键结构读写。
 *
 * 存储键（全部以 pcf_ 前缀，与 AI 模块 pcai_ 隔离）：
 *   pcf_groups   分组数组
 *   pcf_items    收藏项映射 { [postId]: Item }
 *   pcf_settings 收藏夹 Plus 设置
 *   pcf_ui       弹窗/工作台的筛选与视图状态（弹窗关闭即销毁，需持久化恢复）
 *   pcf_drafts   未完成的编辑草稿（新建分组名等）
 */

// ============================ 1. 常量与默认值 ============================

export const FAV_STORAGE_KEYS = {
  groups: 'pcf_groups',
  items: 'pcf_items',
  settings: 'pcf_settings',
  ui: 'pcf_ui',
  drafts: 'pcf_drafts'
};

/** 分组预设色板（GRP-04） */
export const GROUP_COLORS = [
  '#f03e46', '#3b6ef6', '#2f9e6f', '#b4690e', '#7a3bd6',
  '#0e9aa7', '#d6457a', '#5a6b7b'
];

/** 分组预设图标（GRP-04，用 emoji 保证跨平台一致且零资源依赖） */
export const GROUP_ICONS = ['📁', '⭐', '🎨', '📌', '🧩', '📚', '🎬', '💡', '🔧', '🧪', '🌱', '🗂️'];

/** 收藏夹 Plus 默认设置（SET-01 ~ SET-04） */
export const DEFAULT_FAV_SETTINGS = {
  enabled: true,             // 模块总开关（弹窗入口 + 站点注入）
  siteInject: true,          // 站点详情页注入（浮动归组条 / 归组角标）
  // SET-01 收藏时行为：panel 弹层选组 / recent 直接进最近使用分组 / inbox 直接进未分组收集箱
  behavior: 'panel',
  // SET-02 站点取消收藏时：remove 移除归组 / keep 保留并标记 / prompt 仅提示
  onUnfavorite: 'keep',
  // SET-02 同步触发频率（本里程碑仅保存，站点同步在后续接入）
  syncFreq: 'popup',
  // SET-04 / UI-04 外观
  theme: 'system',           // system 跟随系统 / light / dark
  density: 'grid',           // grid 网格 / list 列表
  sort: 'time-desc',         // time-desc / time-asc / title / author
  // SET-03 数据与隐私：是否允许与站点通信以外的外部请求（默认不允许）
  allowExternal: false,
  // COL-02 最近使用分组 id
  recentGroup: ''
};

export const DEFAULT_FAV_UI = {
  group: 'all',        // all | inbox | <groupId>
  query: '',
  tags: [],
  onlyDead: false,
  scrollTop: 0
};

/** 收藏项失效状态取值（ITM-05 与第 5 节状态机） */
export const ITEM_STATE = {
  NORMAL: 'normal',      // 正常
  PENDING: 'pending',    // 待确认（检查超时，不参与批量清理）
  DEAD: 'dead'          // 已失效（帖子删除 / 不可访问 / 被设为私密）
};

/** 排序方式（BRW-02） */
export const SORT_OPTIONS = [
  { id: 'time-desc', name: '收藏时间（新→旧）' },
  { id: 'time-asc', name: '收藏时间（旧→新）' },
  { id: 'title', name: '按标题' },
  { id: 'author', name: '按作者' }
];

export const DENSITY_OPTIONS = [
  { id: 'grid', name: '网格视图' },
  { id: 'list', name: '列表视图' }
];

export const BEHAVIOR_OPTIONS = [
  { id: 'panel', name: '弹出面板选分组' },
  { id: 'recent', name: '直接进最近使用的分组' },
  { id: 'inbox', name: '直接进未分组收集箱' }
];

export const ON_UNFAVORITE_OPTIONS = [
  { id: 'remove', name: '移除归组关系' },
  { id: 'keep', name: '保留归组并标记「站点已取消」' },
  { id: 'prompt', name: '仅提示不处理' }
];

export const SYNC_FREQ_OPTIONS = [
  { id: 'popup', name: '每次打开弹窗' },
  { id: 'daily', name: '每天一次' },
  { id: 'manual', name: '仅手动' }
];

export const THEME_OPTIONS = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' }
];

/** 系统内置虚拟视图（不可删除、不可拖拽、固定置顶） */
export const SYSTEM_VIEWS = [
  { id: 'all', name: '全部收藏' },
  { id: 'inbox', name: '未分组收集箱' }
];

// ============================ 2. 底层读写 ============================

/** 读一个键，缺失时回退默认值 */
async function readKey(key, fallback) {
  const raw = await chrome.storage.local.get(key);
  const v = raw[key];
  return v === undefined || v === null ? fallback : v;
}

/** 写一个键 */
async function writeKey(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/** 生成短 id：g + 时间戳 base36 + 两位随机，避免同毫秒碰撞 */
function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
}

/** 分组名归一化：去首尾空格、内部连续空白压成一个空格、转小写（用于唯一性判断） */
export function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 名称非法时的原因（空 / 超长），合法返回 '' */
export function validateGroupName(name) {
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '分组名不能为空';
  if (raw.length > 24) return '分组名不能超过 24 个字符';
  return '';
}

/** 由名称哈希得到稳定的默认色（GRP-04：未选色时按名称分配，刷新不变） */
export function groupColorByName(name) {
  const s = normalizeName(name);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

// ============================ 3. 分组（GRP-01 ~ GRP-05） ============================

/** 全部分组，按 order 升序 */
export async function getGroups() {
  const list = await readKey(FAV_STORAGE_KEYS.groups, []);
  return list.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

async function saveGroups(list) {
  await writeKey(FAV_STORAGE_KEYS.groups, list);
  return list;
}

/**
 * 新建分组（GRP-01）。
 * 同名（归一化后）视为同一分组：返回已有分组并标记 existed，不静默创建副本。
 */
export async function createGroup(name, opts = {}) {
  const invalid = validateGroupName(name);
  if (invalid) return { error: invalid };

  const clean = String(name).replace(/\s+/g, ' ').trim();
  const key = normalizeName(clean);
  const groups = await getGroups();

  const exist = groups.find((g) => normalizeName(g.name) === key);
  if (exist) return { group: exist, existed: true };

  const group = {
    id: uid('g'),
    name: clean,
    icon: opts.icon || '',
    color: opts.color || groupColorByName(clean),
    order: groups.length ? Math.max(...groups.map((g) => g.order || 0)) + 1 : 0,
    pinned: false,
    collapsed: false,
    createdAt: Date.now()
  };
  groups.push(group);
  await saveGroups(groups);
  return { group, existed: false };
}

/** 局部更新分组（重命名 / 图标 / 颜色 / 置顶 / 折叠） */
export async function updateGroup(id, patch) {
  const groups = await getGroups();
  const g = groups.find((x) => x.id === id);
  if (!g) return null;

  if (patch.name !== undefined) {
    const invalid = validateGroupName(patch.name);
    if (invalid) return { error: invalid };
    const clean = String(patch.name).replace(/\s+/g, ' ').trim();
    const key = normalizeName(clean);
    // 重名（排除自身）时复用既有分组语义，这里拒绝改名以免产生重复
    if (groups.some((x) => x.id !== id && normalizeName(x.name) === key)) {
      return { error: '已存在同名分组' };
    }
    g.name = clean;
  }
  ['icon', 'color', 'pinned', 'collapsed', 'order'].forEach((k) => {
    if (patch[k] !== undefined) g[k] = patch[k];
  });
  await saveGroups(groups);
  return { group: g };
}

/**
 * 删除分组（GRP-02）：删除前必须选择成员去向，不允许成员凭空消失。
 * opts.mode = 'inbox'（默认，移入未分组收集箱）| 'group'（移入指定分组 targetId）
 */
export async function deleteGroup(id, opts = {}) {
  const groups = await getGroups();
  const idx = groups.findIndex((g) => g.id === id);
  if (idx < 0) return { error: '分组不存在' };

  const mode = opts.mode === 'group' ? 'group' : 'inbox';
  const targetId = opts.targetId || '';
  if (mode === 'group' && (!targetId || !groups.some((g) => g.id === targetId))) {
    return { error: '请选择要移入的分组' };
  }

  // 迁移成员：inbox 直接摘除该分组；group 则替换为目标分组（去重）
  const map = await readItemsMap();
  Object.values(map).forEach((it) => {
    if (!Array.isArray(it.groupIds) || !it.groupIds.includes(id)) return;
    const rest = it.groupIds.filter((x) => x !== id);
    it.groupIds = mode === 'group' ? Array.from(new Set(rest.concat(targetId))) : rest;
    it.updatedAt = Date.now();
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);

  groups.splice(idx, 1);
  await saveGroups(groups);
  return { ok: true, moved: mode };
}

/** 拖拽排序（GRP-03）：按传入 id 顺序重写 order 并立即持久化 */
export async function reorderGroups(orderedIds) {
  const groups = await getGroups();
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  groups.forEach((g) => { if (pos.has(g.id)) g.order = pos.get(g.id); });
  await saveGroups(groups);
  return groups;
}

// ============================ 4. 收藏项（ITM-01 ~ ITM-05） ============================

/** 收藏项映射（原始对象，调用方改动后需自行写回） */
async function readItemsMap() {
  return await readKey(FAV_STORAGE_KEYS.items, {});
}

/** 收藏项数组（按收藏时间倒序） */
export async function getItems() {
  const map = await readItemsMap();
  return Object.values(map).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function getItem(id) {
  const map = await readItemsMap();
  return map[id] || null;
}

/**
 * 新增或更新一条收藏项（ITM-01）。
 * 已存在时保留本地手动数据（备注 / 标签 / 归组 / 手动改过的字段），只更新站点侧元数据。
 */
export async function upsertItem(input) {
  if (!input || !input.id) return null;
  const map = await readItemsMap();
  const old = map[input.id];

  if (!old) {
    map[input.id] = {
      id: input.id,
      title: input.title || '',
      author: input.author || '',
      cover: input.cover || '',
      url: input.url || '',
      type: input.type || '',
      savedAt: input.savedAt || Date.now(),
      updatedAt: Date.now(),
      dead: ITEM_STATE.NORMAL,
      siteState: input.siteState || 'saved',
      note: input.note || '',
      tags: Array.isArray(input.tags) ? input.tags.slice() : [],
      groupIds: Array.isArray(input.groupIds) ? input.groupIds.slice() : [],
      manual: input.manual || {}
    };
    await writeKey(FAV_STORAGE_KEYS.items, map);
    return map[input.id];
  }

  // 已存在：站点元数据以新值覆盖，但用户手动改过的字段（manual 标记）优先保留
  const manual = old.manual || {};
  ['title', 'author', 'cover', 'type', 'url'].forEach((k) => {
    if (input[k] !== undefined && !manual[k]) old[k] = input[k];
  });
  if (input.savedAt && !old.savedAt) old.savedAt = input.savedAt;
  if (input.siteState) old.siteState = input.siteState;
  old.updatedAt = Date.now();
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return old;
}

/** 局部更新一条收藏项；patch.manual 中的字段同时打上「手动」标记（ITM-02） */
export async function patchItem(id, patch = {}) {
  const map = await readItemsMap();
  const it = map[id];
  if (!it) return null;
  it.manual = it.manual || {};
  Object.keys(patch).forEach((k) => {
    if (k === 'manual') return;
    it[k] = patch[k];
    if (['title', 'author', 'cover', 'type'].includes(k)) it.manual[k] = true;
  });
  it.updatedAt = Date.now();
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return it;
}

/** 写备注（ITM-03，单条上限 500 字） */
export async function setNote(id, note) {
  const text = String(note || '').slice(0, 500);
  return patchItem(id, { note: text });
}

/** 批量移除收藏项记录（ORG-04；默认只动插件本地记录，不触碰站点收藏） */
export async function removeItems(ids) {
  const map = await readItemsMap();
  let n = 0;
  (ids || []).forEach((id) => { if (map[id]) { delete map[id]; n++; } });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return n;
}

/** 清空全部本地数据（SYN-05；不影响站点收藏） */
export async function clearAllItems() {
  const map = await readItemsMap();
  const n = Object.keys(map).length;
  await writeKey(FAV_STORAGE_KEYS.items, {});
  return n;
}

/** 清空全部收藏夹 Plus 数据（分组 + 收藏项 + 草稿），保留设置 */
export async function resetFavorites() {
  const map = await readItemsMap();
  const n = Object.keys(map).length;
  await chrome.storage.local.set({
    [FAV_STORAGE_KEYS.items]: {},
    [FAV_STORAGE_KEYS.groups]: [],
    [FAV_STORAGE_KEYS.drafts]: {}
  });
  return n;
}

// ============================ 5. 归组关系（COL-03 / COL-05 / COL-07） ============================

/** 批量加入分组（并集语义，已在该分组则跳过） */
export async function addToGroup(ids, groupId) {
  if (!groupId) return 0;
  const map = await readItemsMap();
  let n = 0;
  (ids || []).forEach((id) => {
    const it = map[id];
    if (!it) return;
    it.groupIds = Array.isArray(it.groupIds) ? it.groupIds : [];
    if (!it.groupIds.includes(groupId)) { it.groupIds.push(groupId); it.updatedAt = Date.now(); n++; }
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return n;
}

/** 批量从指定分组移出（只影响该分组，不触碰其他归属） */
export async function removeFromGroup(ids, groupId) {
  if (!groupId) return 0;
  const map = await readItemsMap();
  let n = 0;
  (ids || []).forEach((id) => {
    const it = map[id];
    if (!it || !Array.isArray(it.groupIds)) return;
    if (it.groupIds.includes(groupId)) {
      it.groupIds = it.groupIds.filter((x) => x !== groupId);
      it.updatedAt = Date.now();
      n++;
    }
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return n;
}

/** 整体设定某条命中收藏项的分组集合（收藏当下写入用） */
export async function setGroupsFor(ids, groupIds) {
  const map = await readItemsMap();
  const clean = Array.from(new Set(groupIds || []));
  (ids || []).forEach((id) => {
    const it = map[id];
    if (!it) return;
    it.groupIds = clean.slice();
    it.updatedAt = Date.now();
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
}

/** 取消站点收藏联动（COL-07）：按设置移除归组 / 保留并标记 / 不改动 */
export async function onSiteUnfavorite(id, mode) {
  const map = await readItemsMap();
  const it = map[id];
  if (!it) return null;
  it.siteState = 'unsaved';
  if (mode === 'remove') it.groupIds = [];
  it.updatedAt = Date.now();
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return it;
}

// ============================ 6. 标签（ITM-04 / BRW-04） ============================

/** 标签名归一化：去首尾空格、转小写比较；保留原大小写存储 */
export function normalizeTag(tag) {
  return String(tag || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 批量打标签（单条上限 10 个，标签名 1–16 字） */
export async function addTags(ids, tags) {
  const cleaned = (tags || [])
    .map((t) => String(t).replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length <= 16);
  if (!cleaned.length) return 0;
  const map = await readItemsMap();
  let n = 0;
  (ids || []).forEach((id) => {
    const it = map[id];
    if (!it) return;
    it.tags = Array.isArray(it.tags) ? it.tags : [];
    const keys = new Set(it.tags.map(normalizeTag));
    cleaned.forEach((t) => {
      if (!keys.has(normalizeTag(t)) && it.tags.length < 10) {
        it.tags.push(t);
        keys.add(normalizeTag(t));
        n++;
      }
    });
    it.updatedAt = Date.now();
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return n;
}

/** 批量移除某标签 */
export async function removeTag(ids, tag) {
  const key = normalizeTag(tag);
  const map = await readItemsMap();
  let n = 0;
  (ids || []).forEach((id) => {
    const it = map[id];
    if (!it || !Array.isArray(it.tags)) return;
    const before = it.tags.length;
    it.tags = it.tags.filter((t) => normalizeTag(t) !== key);
    if (it.tags.length !== before) { it.updatedAt = Date.now(); n++; }
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return n;
}

/** 全局重命名标签（ITM-04），返回受影响条数供确认用 */
export async function renameTag(oldName, newName) {
  const oldKey = normalizeTag(oldName);
  const clean = String(newName || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 16) return { error: '标签名需为 1–16 个字符' };
  const map = await readItemsMap();
  let n = 0;
  Object.values(map).forEach((it) => {
    if (!Array.isArray(it.tags)) return;
    let hit = false;
    it.tags = it.tags.map((t) => {
      if (normalizeTag(t) === oldKey) { hit = true; return clean; }
      return t;
    });
    if (hit) {
      // 重命名后可能与已有标签重复，去重
      const seen = new Set();
      it.tags = it.tags.filter((t) => {
        const k = normalizeTag(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      it.updatedAt = Date.now();
      n++;
    }
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return { affected: n };
}

/** 统计标签使用次数（用于标签栏），返回 [{name, count}] */
export async function getAllTags() {
  const map = await readItemsMap();
  const counter = new Map();
  Object.values(map).forEach((it) => {
    (it.tags || []).forEach((t) => {
      const key = normalizeTag(t);
      if (!key) return;
      const rec = counter.get(key);
      if (rec) rec.count++;
      else counter.set(key, { name: t, count: 1 });
    });
  });
  return Array.from(counter.values()).sort((a, b) => b.count - a.count);
}

// ============================ 7. 设置与 UI 状态 ============================

export async function getSettings() {
  const raw = await readKey(FAV_STORAGE_KEYS.settings, {});
  return { ...DEFAULT_FAV_SETTINGS, ...raw };
}

export async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await writeKey(FAV_STORAGE_KEYS.settings, next);
  return next;
}

export function onSettingsChange(handler) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[FAV_STORAGE_KEYS.settings]) return;
    handler({ ...DEFAULT_FAV_SETTINGS, ...(changes[FAV_STORAGE_KEYS.settings].newValue || {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function getUiState() {
  const raw = await readKey(FAV_STORAGE_KEYS.ui, {});
  return { ...DEFAULT_FAV_UI, ...raw };
}

export async function patchUiState(patch) {
  const next = { ...(await getUiState()), ...patch };
  await writeKey(FAV_STORAGE_KEYS.ui, next);
  return next;
}

/** 草稿（弹窗会话约束：编辑中的内容不静默丢弃） */
export async function getDrafts() {
  return await readKey(FAV_STORAGE_KEYS.drafts, {});
}

export async function patchDrafts(patch) {
  const next = { ...(await getDrafts()), ...patch };
  await writeKey(FAV_STORAGE_KEYS.drafts, next);
  return next;
}

// ============================ 8. 统计（第 5 节计数规则） ============================

/**
 * 计数：分组计数含已失效与「站点已取消」项；
 * 全部收藏为去重条数（≠ 各分组之和）；未分组收集箱 = 全部 − 至少归属一个分组的条数。
 */
export async function getCounts() {
  const [groups, items] = await Promise.all([getGroups(), getItems()]);
  const validIds = new Set(groups.map((g) => g.id));
  const byGroup = {};
  groups.forEach((g) => { byGroup[g.id] = 0; });

  let inbox = 0;
  items.forEach((it) => {
    const gs = (it.groupIds || []).filter((id) => validIds.has(id));
    if (!gs.length) inbox++;
    gs.forEach((id) => { byGroup[id]++; });
  });

  return { all: items.length, inbox, byGroup };
}

// ============================ 9. 过滤与排序（BRW-01 ~ BRW-05，纯函数） ============================

/** 是否失效（失效项默认仍展示，但带标记） */
export function isDead(it) {
  return it.dead === ITEM_STATE.DEAD;
}

/** 关键词命中：标题 / 作者 / 备注 / 标签名，大小写不敏感 */
export function matchesQuery(it, q) {
  if (!q) return true;
  const hay = [it.title, it.author, it.note, (it.tags || []).join(' ')].join(' ').toLowerCase();
  return hay.includes(String(q).toLowerCase());
}

/**
 * 按「分组 × 搜索 × 标签 × 失效」取交集过滤，并排序。
 * @param {object[]} items  收藏项
 * @param {object} view     { group, query, tags, onlyDead, sort }
 * @param {string[]} validGroupIds 当前存在的分组 id（用于剔除已删除分组）
 */
export function filterItems(items, view, validGroupIds = []) {
  const valid = new Set(validGroupIds);
  const tags = (view.tags || []).map(normalizeTag);
  let res = items.filter((it) => {
    const gs = (it.groupIds || []).filter((id) => valid.has(id));
    if (view.group === 'inbox') { if (gs.length) return false; }
    else if (view.group && view.group !== 'all') { if (!gs.includes(view.group)) return false; }
    if (view.onlyDead && !isDead(it)) return false;
    if (tags.length) {
      const own = new Set((it.tags || []).map(normalizeTag));
      if (!tags.every((t) => own.has(t))) return false;
    }
    return matchesQuery(it, view.query);
  });
  res = res.slice().sort((a, b) => {
    switch (view.sort) {
      case 'time-asc': return (a.savedAt || 0) - (b.savedAt || 0);
      case 'title': return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
      case 'author': return String(a.author || '').localeCompare(String(b.author || ''), 'zh');
      default: return (b.savedAt || 0) - (a.savedAt || 0);
    }
  });
  return res;
}

/** 当前结果集中实际出现的标签（避免"选了标签结果为空"的无效组合） */
export function tagsInResult(items, view, validGroupIds = []) {
  const key = normalizeTag(view.query);
  const hasQuery = !!key;
  const base = items.filter((it) => {
    const valid = new Set(validGroupIds);
    const gs = (it.groupIds || []).filter((id) => valid.has(id));
    if (view.group === 'inbox') { if (gs.length) return false; }
    else if (view.group && view.group !== 'all') { if (!gs.includes(view.group)) return false; }
    if (view.onlyDead && !isDead(it)) return false;
    return matchesQuery(it, view.query);
  });
  const counter = new Map();
  base.forEach((it) => (it.tags || []).forEach((t) => {
    const k = normalizeTag(t);
    const rec = counter.get(k);
    if (rec) rec.count++;
    else counter.set(k, { name: t, count: 1 });
  }));
  return { tags: Array.from(counter.values()).sort((a, b) => b.count - a.count), hasQuery };
}

/** 时间格式化：今天 / 昨天 / MM-DD / YYYY-MM-DD */
export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const y = new Date(now.getTime() - 86400000);
  if (sameDay(d, y)) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// ============================ 10. 导入 / 导出（SYN-03 / SYN-04） ============================

/** 导出 JSON（完整备份：分组结构 + 收藏项元数据 + 归组 + 标签 + 备注 + 收藏时间） */
export async function exportJSON() {
  const [groups, items, settings] = await Promise.all([getGroups(), getItems(), getSettings()]);
  return { version: 1, kind: 'pickscribe-favorites', exportedAt: Date.now(), groups, items, settings };
}

/** 导出 CSV（分组列为多值字段，用 ; 分隔） */
export async function exportCSV() {
  const [groups, items] = await Promise.all([getGroups(), getItems()]);
  const nameOf = new Map(groups.map((g) => [g.id, g.name]));
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['帖子ID', '标题', '作者', '类型', '原帖链接', '收藏时间', '失效状态', '分组', '标签', '备注'];
  const rows = items.map((it) => [
    it.id, it.title, it.author, it.type, it.url,
    new Date(it.savedAt || 0).toISOString(),
    isDead(it) ? '已失效' : (it.siteState === 'unsaved' ? '站点已取消' : '正常'),
    (it.groupIds || []).map((id) => nameOf.get(id)).filter(Boolean).join(';'),
    (it.tags || []).join(';'),
    it.note
  ].map(esc).join(','));
  return '\uFEFF' + head.map(esc).join(',') + '\n' + rows.join('\n');
}

/** 导出 Markdown（用于人读浏览，按分组分节） */
export async function exportMarkdown() {
  const [groups, items] = await Promise.all([getGroups(), getItems()]);
  const lines = ['# 收藏夹 Plus 导出', '', '> 导出时间：' + new Date().toLocaleString('zh-CN'), '', '共 ' + items.length + ' 条收藏、' + groups.length + ' 个分组。', ''];
  const ungrouped = items.filter((it) => !(it.groupIds || []).length);

  const renderItem = (it) => {
    lines.push('- [' + (it.title || '未命名帖子') + '](' + (it.url || '') + ')');
    const meta = [];
    if (it.author) meta.push('作者：' + it.author);
    if (it.type) meta.push('类型：' + it.type);
    meta.push('收藏于：' + new Date(it.savedAt || 0).toLocaleDateString('zh-CN'));
    if (isDead(it)) meta.push('**已失效**');
    if ((it.tags || []).length) meta.push('标签：' + it.tags.join(' / '));
    lines.push('  - ' + meta.join(' ｜ '));
    if (it.note) lines.push('  - 备注：' + it.note.replace(/\n/g, ' '));
  };

  groups.forEach((g) => {
    const inGroup = items.filter((it) => (it.groupIds || []).includes(g.id));
    lines.push('## ' + (g.icon ? g.icon + ' ' : '') + g.name + '（' + inGroup.length + '）', '');
    if (!inGroup.length) lines.push('_（空分组）_');
    else inGroup.forEach(renderItem);
    lines.push('');
  });

  lines.push('## 未分组收集箱（' + ungrouped.length + '）', '');
  if (!ungrouped.length) lines.push('_（空）_');
  else ungrouped.forEach(renderItem);
  return lines.join('\n');
}

/**
 * 导入合并（SYN-04）：以帖子 ID 判重；分组按名称匹配、不存在则创建；
 * 冲突时保留较新的备注与并集归属，标签取并集。
 */
export async function importJSON(data) {
  if (!data || !Array.isArray(data.items)) return { error: '文件格式不正确：缺少 items 字段' };
  if (data.kind && data.kind !== 'pickscribe-favorites') return { error: '这不是收藏夹 Plus 的导出文件' };

  // 1) 分组：按名称匹配，缺失则新建（保留导出侧的顺序）
  const existing = await getGroups();
  const byName = new Map(existing.map((g) => [normalizeName(g.name), g]));
  const idMap = new Map();   // 导出分组 id → 本地分组 id
  (data.groups || []).forEach((g, i) => {
    const key = normalizeName(g.name);
    let local = byName.get(key);
    if (!local) {
      local = {
        id: uid('g'), name: g.name, icon: g.icon || '', color: g.color || groupColorByName(g.name),
        order: existing.length + i, pinned: !!g.pinned, collapsed: !!g.collapsed, createdAt: Date.now()
      };
      existing.push(local);
      byName.set(key, local);
    }
    idMap.set(g.id, local.id);
  });
  await saveGroups(existing);

  // 2) 收藏项：按 id 合并
  const map = await readItemsMap();
  let added = 0;
  let merged = 0;
  data.items.forEach((src) => {
    if (!src || !src.id) return;
    const gids = (src.groupIds || []).map((id) => idMap.get(id) || id).filter(Boolean);
    const cur = map[src.id];
    if (!cur) {
      map[src.id] = {
        id: src.id, title: src.title || '', author: src.author || '', cover: src.cover || '',
        url: src.url || '', type: src.type || '', savedAt: src.savedAt || Date.now(), updatedAt: Date.now(),
        dead: src.dead || ITEM_STATE.NORMAL, siteState: src.siteState || 'saved',
        note: src.note || '', tags: Array.isArray(src.tags) ? src.tags.slice() : [],
        groupIds: Array.from(new Set(gids)), manual: src.manual || {}
      };
      added++;
    } else {
      // 备注保留较新（updatedAt）的一条；归属与标签取并集
      if ((src.updatedAt || 0) > (cur.updatedAt || 0) && src.note) cur.note = src.note;
      cur.groupIds = Array.from(new Set((cur.groupIds || []).concat(gids)));
      const seen = new Set((cur.tags || []).map(normalizeTag));
      (src.tags || []).forEach((t) => { if (!seen.has(normalizeTag(t))) { cur.tags.push(t); seen.add(normalizeTag(t)); } });
      cur.updatedAt = Date.now();
      merged++;
    }
  });
  await writeKey(FAV_STORAGE_KEYS.items, map);
  return { added, merged, groups: existing.length };
}
