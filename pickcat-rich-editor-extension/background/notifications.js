/**
 * 站内通知 → Windows 系统通知（chrome.notifications）。
 * chrome.alarms 按配置间隔唤醒 Service Worker → 轮询各站点
 * /api/v1/notification-summary（Cookie 鉴权，host_permissions 已声明），
 * 未读数有变化时拉取 /api/v1/notifications 列表，
 * 把本轮没提醒过的未读条目弹出系统通知；点击通知直达对应帖子。
 *
 * 去重策略：storage 里维护最近见过的通知 id（首启静默记账，只弹之后新增的），
 * 弹过的通知 id → 跳转链接映射一并持久化，供点击时跳转。
 * 类型筛选：设置页关掉的类型只记账不弹窗；命中关注关键词的条目无视类型筛选。
 */
import {
  NOTIFY_CONFIG_KEY, NOTIFY_STATE_KEY, NOTIFY_DEFAULTS,
  NOTIFY_HOSTS, NOTIFY_TYPE_LABELS, NOTIFY_TYPE_GROUPS
} from '../shared/constants.js';

const ALARM_NAME = 'pco-notify-poll';
const SEEN_LIMIT = 300;      // 已提醒/已见通知 id 环形上限
const PENDING_LIMIT = 60;    // 点击跳转映射上限
const MAX_POP = 4;           // 单轮最多逐条弹出，超出并入汇总
const LIST_LIMIT = 15;       // 每次拉取的通知条数

let polling = false;

// ============================ 配置与状态 ============================

async function getCfg() {
  const raw = await chrome.storage.local.get(NOTIFY_CONFIG_KEY);
  const c = raw[NOTIFY_CONFIG_KEY] || {};
  const cfg = { ...NOTIFY_DEFAULTS, ...c };
  cfg.hosts = { ...NOTIFY_DEFAULTS.hosts, ...(c.hosts || {}) };
  cfg.types = { ...NOTIFY_DEFAULTS.types, ...(c.types || {}) };
  cfg.keywords = Array.isArray(c.keywords) ? c.keywords.map(String).filter(Boolean) : [];
  return cfg;
}

async function getState() {
  const raw = await chrome.storage.local.get(NOTIFY_STATE_KEY);
  const s = raw[NOTIFY_STATE_KEY] || {};
  return { seeded: !!s.seeded, seen: Array.isArray(s.seen) ? s.seen : [], pending: s.pending || {} };
}

async function setState(state) {
  await chrome.storage.local.set({ [NOTIFY_STATE_KEY]: state });
}

// ============================ 小工具 ============================

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function buildUrl(origin, item) {
  const d = item.details || {};
  const topicId = d.topic && d.topic.id;
  const postNo = d.post && d.post.postNumber;
  if (topicId && postNo != null) return origin + '/forum/post/' + topicId + '#post-' + postNo;
  if (topicId) return origin + '/forum/post/' + topicId;
  return origin + '/';
}

/** 单条通知 → { verb（通知标题）, body（正文） } */
function describe(item) {
  const d = item.details || {};
  const actor = (d.actor && d.actor.username) || '';
  const title = (d.topic && d.topic.title) || (d.work && d.work.title) || '';
  const who = (verb, fallback) => (actor ? actor + ' ' + verb : fallback);
  const cut = (s) => (s && s.length > 80 ? s.slice(0, 79) + '…' : s || '');

  switch (item.type) {
    case 'REPLY_CREATED':                return { verb: who('回复了你', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'WORK_COMMENT_CREATED':         return { verb: who('评论了你的作品', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'WORK_COMMENT_REPLY_CREATED':   return { verb: who('回复了你的评论', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'USER_MENTIONED':               return { verb: who('提到了你', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'WORK_COMMENT_MENTIONED':       return { verb: who('在评论中提到了你', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'POST_LIKED':                   return { verb: who('赞了你的帖子', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'WORK_LIKED':                   return { verb: who('赞了你的作品', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'WORK_COMMENT_LIKED':           return { verb: who('赞了你的评论', NOTIFY_TYPE_LABELS[item.type]), body: cut(title) };
    case 'USER_FOLLOWED':                return { verb: who('关注了你', NOTIFY_TYPE_LABELS[item.type]), body: '' };
    case 'LEVEL_CERTIFICATION':
    case 'MANAGEMENT_ACTION':
    case 'TOPIC_EVENT':
    default:                             return { verb: NOTIFY_TYPE_LABELS[item.type] || '新通知', body: cut(title) };
  }
}

/** 标题 / 作品标题 / 作者名里命中任一关注关键词即视为关键通知 */
function matchWatchKeyword(item, keywords) {
  if (!keywords || !keywords.length) return false;
  const d = item.details || {};
  const hay = [
    (d.topic && d.topic.title) || '',
    (d.work && d.work.title) || '',
    (d.actor && d.actor.username) || ''
  ].join(' ').toLowerCase();
  for (let i = 0; i < keywords.length; i += 1) {
    const kw = String(keywords[i] || '').trim().toLowerCase();
    if (kw && hay.indexOf(kw) !== -1) return true;
  }
  return false;
}

/** 类型是否启用；未知类型默认放行，避免站点新增事件被静默吞掉 */
function typeAllowed(type, types) {
  const group = NOTIFY_TYPE_GROUPS.find((g) => g.types.indexOf(type) !== -1);
  if (!group) return true;
  return types[group.id] !== false;
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 拉活动头像转 dataURL 当通知图标，失败回落扩展图标 */
async function avatarIcon(origin, item) {
  const av = item.details && item.details.actor && item.details.actor.avatar;
  const url = av && (av.url || av.thumb_url);
  if (!url) return null;
  try {
    const res = await fetch(url.startsWith('http') ? url : origin + url, { credentials: 'include' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 200 * 1024) return null;
    return 'data:' + (res.headers.get('content-type') || 'image/png') + ';base64,' + bufToB64(buf);
  } catch (_) {
    return null;
  }
}

function prunePending(pending) {
  const keys = Object.keys(pending);
  if (keys.length <= PENDING_LIMIT) return pending;
  return keys
    .sort((a, b) => (pending[a].at || 0) - (pending[b].at || 0))
    .slice(-PENDING_LIMIT)
    .reduce((acc, k) => { acc[k] = pending[k]; return acc; }, {});
}

// ============================ 系统通知 ============================

async function notify(notifId, options) {
  try { await chrome.notifications.create(notifId, options); } catch (_) { /* 通知被系统禁用等 */ }
}

async function showItem(origin, item, pending, watch) {
  const info = describe(item);
  const notifId = 'pco-' + item.id;
  const icon = (await avatarIcon(origin, item)) || chrome.runtime.getURL('icons/icon128.png');
  pending[notifId] = { url: buildUrl(origin, item), at: Date.now() };
  await notify(notifId, {
    type: 'basic',
    iconUrl: icon,
    title: watch ? '关注提醒 · ' + info.verb : info.verb,
    message: info.body || '点击查看详情'
  });
}

async function showSummary(count, origin, pending) {
  const notifId = 'pco-summary-' + Date.now();
  pending[notifId] = { url: origin + '/', at: Date.now() };
  await notify(notifId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '还有 ' + count + ' 条新通知',
    message: '点击打开社区查看'
  });
}

/** 清空工具栏角标：通知只走系统通知，图标不再显示未读数 */
async function clearBadge() {
  try { await chrome.action.setBadgeText({ text: '' }); } catch (_) { /* 无 action 环境忽略 */ }
}

// ============================ 轮询 ============================

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const cfg = await getCfg();
    if (!cfg.enabled) return;

    const state = await getState();
    const seenSnap = new Set(state.seen);
    const freshSeen = new Set(state.seen);
    const pending = state.pending;
    const firstRun = !state.seeded;
    const fresh = [];

    for (const host of NOTIFY_HOSTS) {
      if (!cfg.hosts[host.id]) continue;
      try {
        const summary = await fetchJson(host.origin + '/api/v1/notification-summary');
        if (!(Number(summary && summary.unreadCount) || 0)) continue;

        const list = await fetchJson(host.origin + '/api/v1/notifications?limit=' + LIST_LIMIT);
        for (const item of (list && list.items) || []) {
          freshSeen.add(item.id);
          if (item.readAt) continue;              // 已读
          if (firstRun || seenSnap.has(item.id)) continue; // 首轮记账 / 本轮已提醒
          // 关掉的类型只记账不弹窗；命中关注关键词则无视类型筛选
          const watch = matchWatchKeyword(item, cfg.keywords);
          if (!watch && !typeAllowed(item.type, cfg.types)) continue;
          fresh.push({ origin: host.origin, item, watch });
        }
      } catch (_) { /* 未登录或网络失败：跳过该站点 */ }
    }

    const shown = fresh.slice(0, MAX_POP);
    for (const { origin, item, watch } of shown) await showItem(origin, item, pending, watch);
    if (fresh.length > shown.length) {
      await showSummary(fresh.length - shown.length, shown.length ? shown[0].origin : NOTIFY_HOSTS[0].origin, pending);
    }

    await setState({
      seeded: true,
      seen: Array.from(freshSeen).slice(-SEEN_LIMIT),
      pending: prunePending(pending)
    });
  } finally {
    polling = false;
  }
}

/**
 * Popup 通知中心：读取最近通知。
 * 只读接口，不写去重状态、不弹系统通知；按创建时间倒序合并两个站点。
 */
export async function listRecentNotifications(limit) {
  const cfg = await getCfg();
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  let unreadCount = 0;
  let reachable = false;
  const all = [];

  await Promise.all(NOTIFY_HOSTS.map(async (host) => {
    if (!cfg.hosts[host.id]) return;
    try {
      const summary = await fetchJson(host.origin + '/api/v1/notification-summary');
      reachable = true;
      unreadCount += Number(summary && summary.unreadCount) || 0;

      const list = await fetchJson(host.origin + '/api/v1/notifications?limit=' + max);
      const hostName = String(host.label || '').split('（')[0];
      for (const item of (list && list.items) || []) {
        const info = describe(item);
        const raw = item.createdAt || item.created_at || item.updatedAt || 0;
        let time = typeof raw === 'number' ? raw : (Date.parse(raw) || 0);
        if (time > 0 && time < 1e12) time *= 1000;   // 兼容秒级时间戳
        all.push({
          id: item.id,
          host: hostName,
          verb: info.verb,
          body: info.body,
          url: buildUrl(host.origin, item),
          unread: !item.readAt,
          watch: matchWatchKeyword(item, cfg.keywords),
          time
        });
      }
    } catch (_) { /* 未登录或网络失败：跳过该站点 */ }
  }));

  all.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { ok: true, enabled: cfg.enabled, reachable, unreadCount, items: all.slice(0, max) };
}

// ============================ 调度与监听 ============================

async function schedule() {
  const cfg = await getCfg();
  await chrome.alarms.clear(ALARM_NAME);
  await clearBadge();
  if (!cfg.enabled) return;
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(1, Number(cfg.intervalMinutes) || 2),
    delayInMinutes: 0.2
  });
  pollOnce();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_NAME) pollOnce();
});

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

// 设置改动即时生效：重排闹钟并立刻轮询一次
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[NOTIFY_CONFIG_KEY]) schedule();
});

// 点击通知：跳到对应帖子，清掉映射
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId || notifId.indexOf('pco-') !== 0) return;
  try { await chrome.notifications.clear(notifId); } catch (_) { /* 已自动关闭 */ }
  // 版本更新提示：点击通知正文等同于「查看更新内容」
  if (notifId.indexOf(UPDATE_NOTIF_PREFIX) === 0) {
    openReleaseNotes(notifId.slice(UPDATE_NOTIF_PREFIX.length));
    return;
  }
  const state = await getState();
  const target = state.pending[notifId];
  if (target && target.url) {
    delete state.pending[notifId];
    await setState(state);
    try { await chrome.tabs.create({ url: target.url }); } catch (_) { /* 忽略 */ }
  }
});

// ============================ 版本更新提示 ============================
// 每次扩展升级到新版本时弹一条系统通知，询问是否查看本次更新内容。
// 版本号写入 storage 去重，同一版本只提示一次，避免 onInstalled 重放时重复弹。

const UPDATE_NOTICE_KEY = 'pco_update_notice';
const UPDATE_NOTIF_PREFIX = 'pco-update-';
const RELEASE_TAG_URL = 'https://github.com/GrantPome/PickScribe/releases/tag/v';

/** 打开该版本的发行版页面（更新日志随 Release 一同发布） */
function openReleaseNotes(version) {
  if (!version) return;
  try {
    chrome.tabs.create({ url: RELEASE_TAG_URL + encodeURIComponent(version) });
  } catch (_) { /* 无 tabs 权限等异常忽略 */ }
}

/** 升级后询问是否查看更新内容；同一版本只弹一次 */
export async function showUpdateNotice(version) {
  const ver = String(version || '').trim();
  if (!ver) return;

  try {
    const raw = await chrome.storage.local.get(UPDATE_NOTICE_KEY);
    const saved = raw[UPDATE_NOTICE_KEY];
    if (saved && saved.version === ver) return;   // 该版本已提示过
    await chrome.storage.local.set({ [UPDATE_NOTICE_KEY]: { version: ver, at: Date.now() } });
  } catch (_) { /* 存储异常不拦截提示 */ }

  await notify(UPDATE_NOTIF_PREFIX + ver, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'PickScribe 已更新到 v' + ver,
    message: '要看看这个版本更新了什么吗？',
    buttons: [{ title: '查看更新内容' }, { title: '以后再说' }],
    priority: 1
  });
}

// 更新通知的按钮：0 = 查看更新内容，1 = 以后再说（仅关闭）
chrome.notifications.onButtonClicked.addListener(async (notifId, index) => {
  if (!notifId || notifId.indexOf(UPDATE_NOTIF_PREFIX) !== 0) return;
  const version = notifId.slice(UPDATE_NOTIF_PREFIX.length);
  try { await chrome.notifications.clear(notifId); } catch (_) { /* 已自动关闭 */ }
  if (index === 0) openReleaseNotes(version);
});

/** 设置页「发送测试通知」 */
export function sendTestNotification() {
  return notify('pco-test-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'PickScribe 通知测试',
    message: '收到这条说明系统通知工作正常。'
  });
}
