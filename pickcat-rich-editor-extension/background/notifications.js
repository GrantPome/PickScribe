/**
 * 站内通知 → Windows 系统通知（chrome.notifications）。
 * chrome.alarms 按配置间隔唤醒 Service Worker → 轮询各站点
 * /api/v1/notification-summary（Cookie 鉴权，host_permissions 已声明），
 * 未读数有变化时拉取 /api/v1/notifications 列表，
 * 把本轮没提醒过的未读条目弹出系统通知；点击通知直达对应帖子。
 * 工具栏图标显示红色未读角标。
 *
 * 去重策略：storage 里维护最近见过的通知 id（首启静默记账，只弹之后新增的），
 * 弹过的通知 id → 跳转链接映射一并持久化，供点击时跳转。
 */
import {
  NOTIFY_CONFIG_KEY, NOTIFY_STATE_KEY, NOTIFY_DEFAULTS,
  NOTIFY_HOSTS, NOTIFY_TYPE_LABELS
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

async function showItem(origin, item, pending) {
  const info = describe(item);
  const notifId = 'pco-' + item.id;
  const icon = (await avatarIcon(origin, item)) || chrome.runtime.getURL('icons/icon128.png');
  pending[notifId] = { url: buildUrl(origin, item), at: Date.now() };
  await notify(notifId, {
    type: 'basic',
    iconUrl: icon,
    title: info.verb,
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

async function applyBadge(n) {
  try {
    if (n > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
      await chrome.action.setBadgeText({ text: n > 99 ? '99+' : String(n) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) { /* 无 action 环境忽略 */ }
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
    let maxUnread = 0;

    for (const host of NOTIFY_HOSTS) {
      if (!cfg.hosts[host.id]) continue;
      try {
        const summary = await fetchJson(host.origin + '/api/v1/notification-summary');
        const unread = Number(summary && summary.unreadCount) || 0;
        if (unread > maxUnread) maxUnread = unread;
        if (!unread) continue;

        const list = await fetchJson(host.origin + '/api/v1/notifications?limit=' + LIST_LIMIT);
        for (const item of (list && list.items) || []) {
          freshSeen.add(item.id);
          if (item.readAt) continue;              // 已读
          if (firstRun || seenSnap.has(item.id)) continue; // 首轮记账 / 本轮已提醒
          fresh.push({ origin: host.origin, item });
        }
      } catch (_) { /* 未登录或网络失败：跳过该站点 */ }
    }

    await applyBadge(maxUnread);

    const shown = fresh.slice(0, MAX_POP);
    for (const { origin, item } of shown) await showItem(origin, item, pending);
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

// ============================ 调度与监听 ============================

async function schedule() {
  const cfg = await getCfg();
  await chrome.alarms.clear(ALARM_NAME);
  if (!cfg.enabled) {
    await applyBadge(0);
    return;
  }
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
  const state = await getState();
  const target = state.pending[notifId];
  if (target && target.url) {
    delete state.pending[notifId];
    await setState(state);
    try { await chrome.tabs.create({ url: target.url }); } catch (_) { /* 忽略 */ }
  }
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
