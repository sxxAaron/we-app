'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const root = $('#app');
let state, screen = 'overview', range = 0, demo = new URLSearchParams(location.search).get('demo') === '1';
let calendarMonth = '', selectedRecordDay = '', toastTimer, lastSync = '', refreshing = false;
let settingsSection = '';
let messageDraft = '', chatHasMore = false, chatLoading = false;
let markingRead = false;
let chatViewportWidth = 0, chatRestingHeight = 0, chatKeyboardOpen = false;
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  messages: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 1 1 19 0Z"/><path d="M7 11h10m-10 4h6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  records: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 4h2m3 0h2m-7 3h2"/>',
  settings: '<path d="M9 4h6m-3 0v16M4 9h16M4 16h16"/><circle cx="8" cy="9" r="2" fill="currentColor"/><circle cx="16" cy="16" r="2" fill="currentColor"/>',
  weight: '<path d="M5 8h14l2 12H3L5 8Z"/><path d="M8 8a4 4 0 1 1 8 0m-4-3v3"/>',
  trend: '<path d="m3 6 6 7 5-4 7 9m-6 0h6v-6"/>',
  flag: '<path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="m21 3-7 18-4-7-7-4L21 3ZM10 14 21 3"/>' 
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.check}</svg>`;
const escape = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayAdd = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const shortDate = day => `${Number(day.slice(5, 7))}.${day.slice(8)}`;
const fullDate = day => day.replaceAll('-', '.');
const number = n => n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2, useGrouping: false });
const changeText = n => n == null ? '—' : (n > 0 ? '+' : '') + number(Math.round(n * 100) / 100);
const owner = () => state.user.role === 'owner';
const endDate = () => dayAdd(state.plan.start_date, state.plan.days - 1);
const elapsed = () => Math.max(0, Math.min(state.plan.days, dayDiff(state.today, state.plan.start_date) + 1));
const recordFor = day => state.records.find(r => r.day === day);
function extendedPlan(plan, asOf) {
  const next = { ...plan, auto_extend: plan.auto_extend ?? true };
  const elapsedDays = dayDiff(asOf, next.start_date) + 1;
  if (next.auto_extend && elapsedDays > next.days) next.days += Math.ceil((elapsedDays - next.days) / 100) * 100;
  next.end_date = dayAdd(next.start_date, next.days - 1);
  return next;
}

const brand = (extra = '') => `<div class="brand ${extra}"><img src="/icon.svg" alt=""><strong>we<span>.</span>app</strong></div>`;

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state?.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '操作失败，请稍后重试'); error.status = response.status; throw error; }
  return data;
}
function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 4000);
}
function syncLabel(error = false) {
  const element = $('#sync-status');
  if (element) { element.classList.toggle('sync-error', error); element.textContent = demo ? '演示数据' : error ? '连接中断，正在重试' : `已同步 ${lastSync}`; }
}
async function load() {
  if (demo) { state = demoState(); lastSync = '刚刚'; render(); return; }
  try {
    const status = await api('/api/status');
    if (status.setupRequired) return renderAuth(true);
    state = await api('/api/state'); chatHasMore = !!state.comments_has_more; lastSync = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); render();
  } catch (error) {
    if (error.status === 401) renderAuth(false);
    else root.innerHTML = `<div class="loading">连接失败<span>${escape(error.message)}</span><p><button class="quiet" data-action="reload">重新连接</button></p></div>`;
  }
}
async function refresh(force = false) {
  if (demo || !state || refreshing || markingRead) return false;
  const editing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!force && (document.hidden || $('#record-dialog').open || (editing && !document.activeElement.closest('#comment-form')))) return;
  refreshing = true;
  try {
    const next = await api('/api/state');
    const changed = JSON.stringify([state.records, state.plan, state.today]) !== JSON.stringify([next.records, next.plan, next.today]);
    const messagesChanged = JSON.stringify([state.comments.slice(-100), state.chat]) !== JSON.stringify([next.comments, next.chat]);
    const hadOlder = state.comments.length > next.comments.length;
    next.comments = [...new Map([...state.comments, ...next.comments].map(c => [c.id, c])).values()].sort((a, b) => a.id - b.id);
    if (!hadOlder) chatHasMore = !!next.comments_has_more;
    state = next;
    lastSync = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (screen === 'messages') { if (messagesChanged || force) updateChat(); }
    else if (force || (changed && screen !== 'settings')) render();
    updateUnreadBadge();
    await markMessagesRead();
    syncLabel();
    return true;
  } catch (error) {
    if (error.status === 401) { state = null; $('#record-dialog').close(); renderAuth(false); }
    else { syncLabel(true); if (force) toast(error.message); }
    return false;
  } finally { refreshing = false; }
}

function demoState() {
  const weights = [164.8, 164.4, 164.6, 163.8, 164.0, 163.4, 163.6, 163.2, 163.0, 163.4, 162.6, 162.4];
  const notes = ['早晨空腹测量', '', '散步 30 分钟', '', '', '', '', '', '', '晚餐火锅', '散步 40 分钟', '早晨空腹测量'];
  return { chat: { unread_count: 2, last_read_id: 0, partner_last_read_id: 1 }, user: { id: 1, username: 'demo', name: '记录者', role: 'owner' }, today: '2026-10-30', plan: { start_date: '2026-10-19', days: 100, goal_weight: 152, weight_unit: 'jin', version: 1 }, records: weights.map((weight, i) => ({ day: dayAdd('2026-10-19', i), weight, note: notes[i], version: 1 })), comments: [{ id: 1, user_id: 2, name: '查看者', role: 'viewer', text: '明天早上记得称一下。', created_at: '2026-10-29T20:36:00+08:00' }, { id: 2, user_id: 1, name: '记录者', role: 'owner', text: '好，明早记录。', created_at: '2026-10-29T21:04:00+08:00' }, { id: 3, user_id: 2, name: '查看者', role: 'viewer', text: '晚上去散步？', created_at: '2026-10-30T09:18:00+08:00' }] };
}
function nav(extra = '') {
  const tabs = [['overview', '首页'], ['messages', '留言'], ['settings', '设置']];
  const selected = screen === 'records' ? 'overview' : screen;
  return `<nav class="${extra || 'nav'}" aria-label="主导航">${tabs.map(([key, label]) => `
    <button type="button" data-screen="${key}" class="${selected === key ? 'active' : ''}" ${selected === key ? 'aria-current="page"' : ''}>
      <span class="nav-icon">${icon(key)}${key === 'messages' ? `<span class="unread-badge" data-unread-badge aria-hidden="true" ${unreadCount() ? '' : 'hidden'}>${badgeText()}</span>` : ''}</span><span>${label}</span>
    </button>`).join('')}</nav>`;
}

function unreadCount() { return state?.chat?.unread_count || 0; }
function badgeText() { return unreadCount() > 99 ? '99+' : String(unreadCount()); }
function updateUnreadBadge() {
  for (const badge of document.querySelectorAll('[data-unread-badge]')) {
    badge.textContent = badgeText(); badge.hidden = unreadCount() === 0;
  }
  for (const button of document.querySelectorAll('[data-screen="messages"]')) {
    button.setAttribute('aria-label', unreadCount() ? `留言，${unreadCount()} 条未读` : '留言');
  }
  document.title = `${unreadCount() ? '(' + unreadCount() + ') ' : ''}we.app · 体重记录`;
}

async function markMessagesRead() {
  const list = $('#message-list');
  if (!state || markingRead || screen !== 'messages' || document.hidden || $('#record-dialog').open ||
      !list || list.clientHeight <= 0 || list.scrollHeight - list.scrollTop - list.clientHeight > 16) return;
  const lastId = state.comments.at(-1)?.id || 0;
  if (lastId <= (state.chat?.last_read_id || 0)) return;
  const userId = state.user.id;
  markingRead = true;
  try {
    const result = demo ? { chat: { ...state.chat, last_read_id: lastId, unread_count: 0 } } :
      await api('/api/comments/read', 'POST', { last_read_id: lastId });
    if (state?.user.id !== userId) return;
    const receiptsChanged = state.chat?.partner_last_read_id !== result.chat.partner_last_read_id;
    state.chat = result.chat;
    updateUnreadBadge();
    if (receiptsChanged && screen === 'messages') updateChat();
  } catch (error) { syncLabel(true); }
  finally { markingRead = false; }
}

function syncChatViewport() {
  const html = document.documentElement;
  const active = !!state && screen === 'messages';
  html.classList.toggle('chat-open', active);
  if (!active) {
    html.classList.remove('chat-keyboard-open');
    html.style.removeProperty('--chat-height');
    html.style.removeProperty('--chat-top');
    chatViewportWidth = chatRestingHeight = 0; chatKeyboardOpen = false;
    return;
  }
  const viewport = window.visualViewport;
  // Pinch zoom is independent of the keyboard; retain the layout while zooming.
  if (viewport && Math.abs(viewport.scale - 1) > .05) return;
  const width = window.innerWidth || html.clientWidth;
  const height = Math.round(viewport?.height || window.innerHeight || html.clientHeight);
  const layoutHeight = Math.max(window.innerHeight || 0, html.clientHeight || 0, height);
  const focused = document.activeElement?.id === 'comment-text';
  if (width !== chatViewportWidth || (!focused && !chatKeyboardOpen)) {
    chatViewportWidth = width; chatRestingHeight = layoutHeight;
  } else chatRestingHeight = Math.max(chatRestingHeight, layoutHeight);
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  chatKeyboardOpen = mobile && (((focused || chatKeyboardOpen) && chatRestingHeight - height > 120) || (!viewport && focused));
  const list = $('#message-list');
  const atBottom = list && list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  html.classList.toggle('chat-keyboard-open', chatKeyboardOpen);
  html.style.setProperty('--chat-height', height + 'px');
  html.style.setProperty('--chat-top', Math.max(0, viewport?.offsetTop || 0) + 'px');
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function render() {
  if (demo) state.plan = extendedPlan(state.plan, state.today);
  const previousChat = $('#message-list');
  const previousScroll = previousChat?.scrollTop ?? null;
  root.innerHTML = `
    <div class="shell ${screen === 'messages' ? 'chat-shell' : ''}">
      <aside class="sidebar">
        ${brand()}
        ${nav()}
        <div class="sidebar-bottom">
          <button class="export-shortcut" data-action="export">${icon('download')}<span>导出记录</span>${icon('arrow')}</button>
          <span class="sidebar-product">体重记录</span>
        </div>
      </aside>
      <main class="main ${screen === 'messages' ? 'chat-main' : ''}">
        <div class="topbar">
          <div class="breadcrumb">we.app <span>/</span> 体重记录</div>
          ${brand('mobile-brand')}
          <div class="account"><span class="avatar ${state.user.role}">${escape(state.user.name.slice(0, 1))}</span><span>${escape(state.user.name)}</span><button class="text-link logout" data-action="logout">${demo ? '退出演示' : '退出'}</button></div>
        </div>
        ${demo ? '<div class="demo-banner"><span>演示模式 · 示例数据不会保存</span><a href="/">返回应用 →</a></div>' : ''}
        ${screen === 'records' ? '<header class="detail-heading history-heading"><button class="quiet return-button" data-screen="overview">' + icon('arrow') + '返回</button><h1>历史记录</h1></header>' : ''}
        ${screen === 'overview' ? overview() : screen === 'messages' ? messages() : screen === 'records' ? recordsPage() : settingsPage()}
        <footer class="page-footer"><span>we.app</span><span class="sync-state"><i class="status-dot"></i><span id="sync-status">${demo ? '演示数据' : `已同步 ${lastSync}`}</span><button class="icon-button" data-action="sync" aria-label="刷新同步">${icon('refresh')}</button></span></footer>
      </main>
      ${nav('bottom-nav')}
    </div>`;
  syncChatViewport();
  if (screen === 'messages') {
    const list = $('#message-list');
    list.scrollTop = previousScroll == null ? list.scrollHeight : previousScroll;
  }
  updateUnreadBadge();
}

function overview() {
  const list = state.records, first = list[0], latest = list.at(-1);
  const change = latest && first ? latest.weight - first.weight : null;
  const goal = state.plan.goal_weight;
  const remaining = latest && goal != null ? Math.max(0, latest.weight - goal) : null;
  return `
    <section class="stats" aria-label="体重概况">
      ${latestWeightCard(latest)}
      ${stat('累计变化', changeText(change), '斤', first ? `首次 ${number(first.weight)} 斤` : '相较首次记录', 'trend', change < 0 ? 'decrease' : '')}
      ${stat('目标体重', number(goal), '斤', goal == null ? '未设置' : remaining == null ? '—' : remaining === 0 ? '已达目标' : `距目标 ${number(remaining)} 斤`, 'flag')}
      ${stat('已记录', list.length, `/ ${state.plan.days} 天`, `完成 ${Math.round(list.length / state.plan.days * 100)}%`, 'records')}
    </section>
    <div class="overview-main">
      <section class="panel trend-panel">
        <div class="panel-head"><h2>体重趋势 <span class="unit-label">斤</span></h2><div class="range-switch" aria-label="曲线时间范围">${[7, 30, 0].map(n => `<button type="button" data-range="${n}" class="${range === n ? 'active' : ''}" aria-pressed="${range === n}">${n === 0 ? '全部' : n + '天'}</button>`).join('')}</div></div>
        <div class="chart">${chart()}</div>
        <div class="chart-caption"><i></i>体重<span>共 ${list.filter(r => range === 0 || r.day >= dayAdd(state.today > endDate() ? endDate() : state.today, 1 - range)).length} 条记录</span></div>
      </section>
    </div>
    <div class="recent-records section-space">
      <section class="panel recent-panel"><div class="panel-head"><h2>最近记录</h2><button class="text-link" data-screen="records">全部记录 ${icon('arrow')}</button></div>${table([...list].reverse().slice(0, 5), false)}</section>
    </div>`;
}

function stat(label, value, unit, caption, symbol, modifier = '') {
  return `<article class="stat ${modifier}"><div class="stat-label">${label}${icon(symbol)}</div><div class="stat-value"><strong>${value}</strong><span>${unit}</span></div><p>${caption}</p></article>`;
}

function chart() {
  const until = state.today < state.plan.start_date ? state.plan.start_date : state.today > endDate() ? endDate() : state.today;
  const lower = dayAdd(until, 1 - range);
  const data = state.records.filter(r => range === 0 || r.day >= lower);
  if (!data.length) return `<div class="chart-empty"><svg viewBox="0 0 480 160" aria-hidden="true"><path d="M0 30H480M0 80H480M0 130H480" stroke="#e9ecf3" stroke-dasharray="4 6"/><path d="m40 115 72-23 68 12 74-54 75 19 106-36" stroke="#d5defb" stroke-width="2.5" stroke-dasharray="6 7" fill="none"/></svg><span>暂无体重记录</span></div>`;
  const width = 640, height = 280, left = 43, right = 18, top = 22, bottom = 37;
  const values = data.map(r => r.weight), minimum = Math.min(...values), maximum = Math.max(...values);
  const padding = Math.max(.5, (maximum - minimum) * .25), low = minimum - padding, high = maximum + padding;
  const span = Math.max(1, dayDiff(data.at(-1).day, data[0].day));
  const x = r => data.length === 1 ? (left + width - right) / 2 : left + dayDiff(r.day, data[0].day) / span * (width - left - right);
  const y = w => top + (high - w) / (high - low) * (height - top - bottom);
  const points = data.map(r => `${x(r).toFixed(2)},${y(r.weight).toFixed(2)}`).join(' ');
  const axis = [0, 1, 2, 3].map(i => {
    const yy = top + (height - top - bottom) * i / 3;
    const value = (high - (high - low) * i / 3).toFixed(1);
    return `<path d="M${left} ${yy}H${width - right}" stroke="#edf0f5" stroke-dasharray="4 5"/><text x="0" y="${yy + 4}" font-size="11" fill="#9299ab">${value}</text>`;
  }).join('');
  const indices = [...new Set([0, Math.floor((data.length - 1) / 3), Math.floor((data.length - 1) * 2 / 3), data.length - 1])];
  const labels = indices.map(i => `<text x="${x(data[i])}" y="${height - 8}" text-anchor="middle" font-size="11" fill="#9299ab">${shortDate(data[i].day)}</text>`).join('');
  const dots = data.map((r, i) => `<circle cx="${x(r)}" cy="${y(r.weight)}" r="${data.length > 40 ? 2 : i === data.length - 1 ? 4 : 3}" fill="${i === data.length - 1 ? '#3d63ed' : '#fff'}" stroke="#3d63ed" stroke-width="2"><title>${r.day} · ${number(r.weight)} 斤</title></circle>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体重趋势，共 ${data.length} 条记录，从 ${number(data[0].weight)} 到 ${number(data.at(-1).weight)} 斤"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6386ff" stop-opacity=".16"/><stop offset="100%" stop-color="#6386ff" stop-opacity="0"/></linearGradient></defs>${axis}${data.length > 1 ? `<polygon points="${x(data[0])},${height - bottom} ${points} ${x(data.at(-1))},${height - bottom}" fill="url(#chart-fill)"/><polyline points="${points}" fill="none" stroke="#3d63ed" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>` : ''}${dots}${labels}</svg>`;
}

function latestWeightCard(latest) {
  const note = latest?.note || '';
  return `<button type="button" class="stat featured latest-stat" data-action="latest-weight" aria-label="${latest ? '最新体重 ' + number(latest.weight) + ' 斤，' : ''}${owner() ? '编辑今日体重与备注' : '查看完整体重与备注'}"><div class="stat-label">最新体重${icon('weight')}</div><div class="stat-value"><strong>${number(latest?.weight)}</strong><span>斤</span></div><p class="latest-date">${latest ? fullDate(latest.day) : '暂无记录'}</p><div class="latest-note ${note ? '' : 'no-note'}" title="${escape(note)}">${escape(note.replace(/\s+/g, ' ') || (owner() ? '点击记录体重与备注' : '暂无备注'))}</div></button>`;
}

function table(rows, showEmpty) {
  if (!rows.length) return '<div class="empty table-empty">暂无记录</div>';
  return `<div class="table-wrap"><table><thead><tr><th>日期</th><th class="numeric">体重 <span>/ 斤</span></th><th>备注</th>${owner() ? '<th class="action-cell"></th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr><td><span class="table-date">${shortDate(r.day)}</span>${r.day === state.today ? '<span class="badge">今天</span>' : ''}${showEmpty ? `<div class="table-day">第 ${dayDiff(r.day, state.plan.start_date) + 1} 天</div>` : ''}</td><td class="numeric"><b>${number(r.weight)}</b></td><td class="note">${r.weight == null ? r.day > state.today ? '未开始' : '未记录' : escape(r.note || '—')}</td>${owner() ? `<td class="action-cell">${r.day <= state.today ? `<button class="text-link" data-edit="${r.day}">${r.weight == null ? '补记' : '修改'}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function chatHistory() {
  let lastDay = '';
  return `${chatHasMore ? `<div class="older-messages"><button class="text-link" data-action="older-messages" ${chatLoading ? 'disabled' : ''}>${chatLoading ? '加载中…' : '查看更早的留言'}</button></div>` : ''}${state.comments.length ? state.comments.map(c => {
    const day = c.created_at.slice(0, 10);
    const divider = day !== lastDay ? `<div class="chat-date"><span>${day === state.today ? '今天' : fullDate(day)}</span></div>` : '';
    lastDay = day;
    const own = c.user_id === state.user.id;
    const read = c.id <= (state.chat?.partner_last_read_id || 0);
    return `${divider}<article class="chat-message ${own ? 'own-message' : ''}"><span class="avatar ${c.role}">${escape(c.name.slice(0, 1))}</span><div class="chat-message-body"><div class="chat-author">${escape(c.name)}</div><p class="chat-bubble">${escape(c.text)}</p><div class="message-meta"><time datetime="${escape(c.created_at)}">${c.created_at.slice(11, 16)}</time>${own ? `<span class="read-receipt ${read ? 'is-read' : ''}">${read ? '已读' : '未读'}</span>` : ''}</div></div></article>`;
  }).join('') : '<div class="chat-empty">' + icon('messages') + '<span>暂无留言</span></div>'}`;
}

function messages() {
  return `<section class="conversation" aria-label="两人留言">
    <div class="chat-history" id="message-list" role="log" aria-label="聊天记录" aria-live="polite" aria-relevant="additions">${chatHistory()}</div>
    <form class="chat-composer" id="comment-form"><div class="error-box" role="alert"></div><div class="chat-composer-row"><label class="sr-only" for="comment-text">留言内容</label><textarea id="comment-text" name="text" rows="2" maxlength="500" placeholder="发消息…" required>${escape(messageDraft)}</textarea><button class="primary" type="submit" aria-label="发送留言">${icon('send')}<span>发送</span></button></div><div class="composer-hint">Enter 发送 · Shift + Enter 换行</div></form>
  </section>`;
}

function updateChat(forceBottom = false) {
  const list = $('#message-list');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  const top = list.scrollTop;
  list.innerHTML = chatHistory();
  list.scrollTop = forceBottom || nearBottom ? list.scrollHeight : top;
  if ($('#chat-count')) $('#chat-count').textContent = `${state.comments.length} 条留言`;
}

async function olderMessages() {
  if (chatLoading || !chatHasMore || !state.comments.length) return;
  chatLoading = true;
  const list = $('#message-list'), beforeHeight = list.scrollHeight, beforeTop = list.scrollTop;
  const button = $('[data-action="older-messages"]');
  if (button) { button.disabled = true; button.textContent = '加载中…'; }
  try {
    const history = await api('/api/comments?before=' + state.comments[0].id);
    const merged = new Map([...history.comments, ...state.comments].map(c => [c.id, c]));
    state.comments = [...merged.values()].sort((a, b) => a.id - b.id);
    chatHasMore = history.has_more;
    chatLoading = false;
    list.innerHTML = chatHistory();
    list.scrollTop = beforeTop + list.scrollHeight - beforeHeight;
    if ($('#chat-count')) $('#chat-count').textContent = `${state.comments.length} 条留言`;
  } catch (error) { toast(error.message); }
  finally {
    chatLoading = false;
    const control = $('[data-action="older-messages"]');
    if (control) { control.disabled = false; control.textContent = '查看更早的留言'; }
  }
}

function shiftMonth(month, amount) {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}

function calendarSelection() {
  const start = state.plan.start_date, end = endDate();
  if (!selectedRecordDay || selectedRecordDay < start || selectedRecordDay > end) selectedRecordDay = state.today < start ? start : state.today > end ? end : state.today;
  if (!calendarMonth) calendarMonth = selectedRecordDay.slice(0, 7);
  calendarMonth = calendarMonth < start.slice(0, 7) ? start.slice(0, 7) : calendarMonth > end.slice(0, 7) ? end.slice(0, 7) : calendarMonth;
}

function recordsPage() {
  calendarSelection();
  const first = calendarMonth + '-01';
  const gridStart = dayAdd(first, -new Date(first + 'T00:00:00Z').getUTCDay());
  const records = new Map(state.records.map(r => [r.day, r]));
  const monthRecords = state.records.filter(r => r.day.startsWith(calendarMonth));
  return `<section class="month-calendar" aria-label="体重月历">
    <div class="month-navigation"><button class="month-arrow previous" data-action="previous-month" aria-label="上个月" ${calendarMonth <= state.plan.start_date.slice(0, 7) ? 'disabled' : ''}>${icon('chevron')}</button><h2>${calendarMonth.replace('-', ' / ')}</h2><button class="month-arrow" data-action="next-month" aria-label="下个月" ${calendarMonth >= endDate().slice(0, 7) ? 'disabled' : ''}>${icon('chevron')}</button></div>
    <div class="month-meta"><span>本月已记录 ${monthRecords.length} 天<span class="month-unit">体重 / 斤</span></span>${state.today >= state.plan.start_date && state.today <= endDate() ? '<button class="text-link" data-action="calendar-today">今天</button>' : ''}</div>
    <div class="month-weekdays" aria-hidden="true">${['日', '一', '二', '三', '四', '五', '六'].map(d => `<span>${d}</span>`).join('')}</div>
    <div class="month-grid">${Array.from({length:42}, (_, i) => {
      const day = dayAdd(gridStart, i), record = records.get(day);
      const inPlan = day >= state.plan.start_date && day <= endDate();
      const status = record ? `${number(record.weight)} 斤，已记录` : day > state.today ? '未到记录日期' : inPlan ? '未记录' : '计划范围外';
      return `<button type="button" class="month-day ${record ? 'has-record' : 'missing'} ${day.startsWith(calendarMonth) ? '' : 'outside-month'} ${inPlan ? '' : 'outside-plan'} ${day > state.today ? 'future' : ''} ${day === state.today ? 'is-today' : ''} ${day === selectedRecordDay ? 'is-selected' : ''}" data-day="${day}" aria-label="${day}，${status}" aria-pressed="${day === selectedRecordDay}" ${day === state.today ? 'aria-current="date"' : ''} ${inPlan ? '' : 'disabled'}><span class="month-day-date">${Number(day.slice(8))}</span><span class="month-day-weight">${record ? number(record.weight) : '—'}</span></button>`;
    }).join('')}</div>
    <div class="month-legend"><span><i class="recorded-key"></i>已记录</span><span><i class="missing-key"></i>未记录</span><span><i class="current-key"></i>今天</span></div>
  </section><section class="selected-record panel" aria-label="所选日期记录">${selectedRecord()}</section>`;
}

function selectedRecord() {
  const day = selectedRecordDay, record = recordFor(day);
  const canEdit = owner() && day <= state.today && day >= state.plan.start_date && day <= endDate();
  return `<div class="selected-record-head"><h2>${fullDate(day)}</h2>${canEdit ? `<button class="quiet" data-edit="${day}">${icon(record ? 'weight' : 'plus')}${record ? '编辑记录' : '记录体重'}</button>` : ''}</div>
    ${record ? `<div class="selected-weight">${number(record.weight)}<span>斤</span></div><div class="selected-note">${escape(record.note || '暂无备注')}</div>` : `<div class="selected-empty">${day > state.today ? '未到记录日期' : '当天未记录'}</div>`}`;
}

function viewRecord(day) {
  const record = recordFor(day), dialog = $('#record-dialog');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="record-title">记录详情</h2><button type="button" class="close" data-action="close-dialog" aria-label="关闭">×</button></div><div class="record-detail-date">${fullDate(day)}</div>${record ? `<div class="selected-weight">${number(record.weight)}<span>斤</span></div><div class="note-heading">备注</div><div class="full-note">${escape(record.note || '暂无备注')}</div>` : '<div class="empty">暂无记录</div>'}<button class="quiet wide detail-close" type="button" data-action="close-dialog">关闭</button>`;
  dialog.showModal();
}

async function openLatestWeight() {
  if (!demo) {
    if (refreshing) { toast('正在同步，请稍后再试'); return; }
    if (!(await refresh(true))) return;
  }
  if (!owner()) {
    const latest = state.records.at(-1);
    if (latest) viewRecord(latest.day);
    else toast('暂无体重记录');
    return;
  }
  if (state.today < state.plan.start_date || state.today > endDate()) { toast('今日不在计划范围内，请在计划设置中调整日期'); return; }
  editRecord(state.today, true);
}

function settingsPage() {
  if (settingsSection) return settingsDetail();
  const entries = [
    ['plan', 'calendar', 'blue', '计划设置', `${fullDate(state.plan.start_date)} — ${fullDate(endDate())}`],
    ['goal', 'flag', 'purple', '目标体重', state.plan.goal_weight == null ? '未设置' : `${number(state.plan.goal_weight)} 斤`],
    ['account', 'lock', 'peach', '账号设置', state.user.username],
    ['export', 'download', 'mint', '数据导出', owner() ? 'CSV / JSON' : 'CSV']
  ];
  return `<div class="settings-menu" aria-label="设置选项">${entries.map(([key, symbol, color, title, value]) => `<button class="settings-entry" data-setting="${key}"><span class="setting-icon ${color}">${icon(symbol)}</span><span class="settings-entry-text"><strong>${title}</strong><small>${escape(value)}</small></span>${icon('chevron')}</button>`).join('')}</div>`;
}

function settingsDetail() {
  const titles = { plan: '计划设置', goal: '目标体重', account: '账号设置', export: '数据导出' };
  let content = '';
  if (settingsSection === 'plan') content = `
    <div class="plan-dates"><div><span>开始</span><strong>${fullDate(state.plan.start_date)}</strong></div>${icon('arrow')}<div><span>结束</span><strong>${fullDate(endDate())}</strong></div></div>
    <div class="plan-total">累计计划 <strong>${state.plan.days}</strong> 天</div>
    <form id="plan-form" data-version="${state.plan.version}">
      <label class="field">开始日期<input name="start_date" type="date" value="${state.plan.start_date}" required ${owner() ? '' : 'disabled'}></label>
      <label class="field">结束日期<input name="end_date" type="date" min="${state.plan.start_date}" value="${endDate()}" required ${owner() ? '' : 'disabled'}></label>
      <label class="renew-option"><input name="auto_extend" type="checkbox" ${state.plan.auto_extend !== false ? 'checked' : ''} ${owner() ? '' : 'disabled'}><span>到期后自动延续 100 天</span></label>
      <p class="renew-hint" id="plan-mode-hint">${state.plan.auto_extend !== false ? '累计天数随每次延续增加，原记录保留' : '已指定结束日期，不自动延续'}</p>
      <div class="error-box" role="alert"></div>${owner() ? '<button class="primary wide" type="submit">保存计划</button>' : ''}
    </form>`;

  if (settingsSection === 'goal') content = `
    <div class="goal-current"><span>最新体重</span><strong>${number(state.records.at(-1)?.weight)}<small>斤</small></strong></div>
    <form id="goal-form" data-version="${state.plan.version}"><label class="field">目标体重 <span class="optional">选填 · 斤</span><div class="goal-input-wrap"><input name="goal_weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="未设置" value="${state.plan.goal_weight ?? ''}" ${owner() ? '' : 'disabled'}><span>斤</span></div></label><div class="error-box" role="alert"></div>${owner() ? '<button class="primary wide" type="submit">保存目标</button>' : ''}</form>`;
  if (settingsSection === 'account') content = `
    <div class="setting-account"><span class="avatar ${state.user.role}">${escape(state.user.name.slice(0, 1))}</span><div><strong>${escape(state.user.username)}</strong><span>${owner() ? '记录体重与留言' : '查看记录与留言'}</span></div><span class="role-badge">${owner() ? '记录者' : '查看者'}</span></div>
    <form id="password-form"><label class="field">当前密码<input name="current" type="password" autocomplete="current-password" maxlength="128" required></label><label class="field">新密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" placeholder="至少 10 个字符" required></label><div class="error-box" role="alert"></div><button class="primary wide" type="submit">修改密码</button></form>`;
  if (settingsSection === 'export') content = `
    <button class="export-option" data-action="export"><span class="file-icon">CSV</span><span><strong>体重记录</strong><small>日期、体重、备注</small></span>${icon('chevron')}</button>
    ${owner() ? `<button class="export-option" data-action="backup"><span class="file-icon json">JSON</span><span><strong>完整数据</strong><small>计划、记录、全部留言</small></span>${icon('chevron')}</button>` : ''}
    <div class="data-retention"><span class="retention-mark">${icon('check')}</span><div><strong>记录与留言不会自动过期</strong><span>登录状态过期后，重新登录即可</span></div></div>`;
  return `<section class="settings-detail"><header class="detail-heading"><button type="button" class="quiet return-button" data-action="back-settings">${icon('arrow')}返回</button><h1>${titles[settingsSection]}</h1></header><div class="settings-editor ${settingsSection}-editor">${content}</div></section>`;
}

function renderAuth(setup) {
  state = null; syncChatViewport();
  document.title = 'we.app · 体重记录';
  root.innerHTML = `<main class="auth-page ${setup ? 'setup' : ''}"><div class="auth-container">${brand()}<section class="auth-card"><header><h1>${setup ? '初始化账号' : '登录'}</h1><span>体重记录</span></header>
    <form id="${setup ? 'setup-form' : 'login-form'}">${setup ? `
      <label class="field">初始化密钥<input name="token" type="password" autocomplete="off" required></label>
      <div class="form-section">记录者</div><div class="form-grid"><label class="field">账号<input name="owner_username" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">昵称<input name="owner_name" value="记录者" maxlength="24" required></label></div><label class="field">密码<input name="owner_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="至少 10 个字符" required></label>
      <div class="form-section">查看与留言</div><div class="form-grid"><label class="field">账号<input name="viewer_username" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">昵称<input name="viewer_name" value="查看者" maxlength="24" required></label></div><label class="field">密码<input name="viewer_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="至少 10 个字符" required></label><label class="field">开始日期<input name="start_date" type="date" value="2026-10-19" required></label>` : `
      <label class="field">账号<input name="username" autocomplete="username" maxlength="32" placeholder="输入账号" required></label>
      <label class="field">密码<input name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="输入密码" required></label>`}
      <div class="error-box" role="alert"></div><button class="primary wide" type="submit">${setup ? '创建账号' : '登录'}${icon('arrow')}</button>
    </form></section><a class="auth-demo" href="/?demo=1">查看演示 ${icon('arrow')}</a></div></main>`;
}

function editRecord(day, fixedDay = false) {
  if (!owner()) return;
  const r = recordFor(day), dialog = $('#record-dialog');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="record-title">${fixedDay ? '今日记录' : r ? '修改记录' : '记录体重'}</h2><button type="button" class="close" data-action="close-dialog" aria-label="关闭">×</button></div><form id="edit-form" data-original-day="${day}" data-version="${r?.version ?? 0}"><label class="field">日期<input name="day" type="date" value="${day}" min="${state.plan.start_date}" max="${state.today < endDate() ? state.today : endDate()}" ${r || fixedDay ? 'readonly' : ''} required></label><label class="field">体重 <span class="optional">斤</span><input name="weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" value="${r?.weight ?? ''}" required autofocus></label><label class="field">备注<textarea name="note" maxlength="500" rows="3" placeholder="选填">${escape(r?.note || '')}</textarea></label><div class="error-box" role="alert"></div><div class="button-row">${r ? '<button type="button" class="text-link danger" data-action="delete-record">删除记录</button>' : '<span></span>'}<button class="primary" type="submit">保存</button></div></form>`;
  dialog.showModal();
}

async function saveRecord(day, weight, note, version) {
  if (demo) {
    const record = { day, weight, note, version: version + 1 };
    state.records = [...state.records.filter(r => r.day !== day), record].sort((a, b) => a.day.localeCompare(b.day)); render(); return;
  }
  await api('/api/records/' + day, 'PUT', { weight, note, version }); await refresh(true);
}
function downloadDemo(kind) {
  let text, mime, filename;
  if (kind === 'export') {
    text = '\ufeff日期,体重(斤),备注\r\n' + state.records.map(r => [r.day, r.weight, '"' + r.note.replaceAll('"', '""') + '"'].join(',')).join('\r\n'); mime = 'text/csv;charset=utf-8'; filename = 'demo-records.csv';
  } else { text = JSON.stringify({ demo: true, weight_unit: 'jin', ...state }, null, 2); mime = 'application/json'; filename = 'demo-backup.json'; }
  const url = URL.createObjectURL(new Blob([text], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const action = button.dataset.action;
  if (button.dataset.screen) {
    screen = button.dataset.screen; settingsSection = ''; render(); window.scrollTo({ top: 0 });
    if (screen === 'messages') {
      if (demo) await markMessagesRead();
      else await refresh(true);
    }
  }
  else if (button.dataset.setting) { settingsSection = button.dataset.setting; screen = 'settings'; render(); window.scrollTo({ top: 0 }); }
  else if (action === 'back-settings') { settingsSection = ''; render(); window.scrollTo({ top: 0 }); }
  else if (button.dataset.range) { range = Number(button.dataset.range); render(); }
  else if (button.dataset.edit) editRecord(button.dataset.edit);
  else if (button.dataset.day) { selectedRecordDay = button.dataset.day; calendarMonth = selectedRecordDay.slice(0, 7); render(); }
  else if (action === 'latest-weight') await openLatestWeight();
  else if (action === 'previous-month' || action === 'next-month') {
    calendarSelection();
    const month = shiftMonth(calendarMonth, action === 'previous-month' ? -1 : 1);
    if (month >= state.plan.start_date.slice(0, 7) && month <= endDate().slice(0, 7)) {
      calendarMonth = month;
      const inMonth = state.records.filter(r => r.day.startsWith(month));
      selectedRecordDay = inMonth.at(-1)?.day || (month + '-01' < state.plan.start_date ? state.plan.start_date : month + '-01');
      render();
    }
  }
  else if (action === 'calendar-today') { selectedRecordDay = state.today; calendarMonth = state.today.slice(0, 7); render(); }
  else if (action === 'close-dialog') $('#record-dialog').close();
  else if (action === 'reload') load();
  else if (action === 'older-messages') await olderMessages();
  else if (action === 'sync') { if (demo) toast('当前是演示数据'); else await refresh(true); }
  else if (action === 'export' || action === 'backup') { if (demo) downloadDemo(action); else location.href = action === 'export' ? '/api/export.csv' : '/api/backup.json'; }
  else if (action === 'logout') {
    if (demo) { location.href = '/'; return; }
    button.disabled = true;
    try { await api('/api/logout', 'POST', {}); state = null; renderAuth(false); } catch (error) { toast(error.message); button.disabled = false; }
  } else if (action === 'delete-record') {
    const form = $('#edit-form'), day = form.dataset.originalDay;
    if (!confirm(`确定删除 ${day} 的记录吗？删除后需要重新填写。`)) return;
    button.disabled = true;
    try {
      if (demo) { state.records = state.records.filter(r => r.day !== day); render(); }
      else { await api('/api/records/' + day, 'DELETE', { version: Number(form.dataset.version) }); await refresh(true); }
      $('#record-dialog').close(); toast(demo ? '演示记录已删除，刷新页面会恢复' : '记录已删除');
    } catch (error) { $('.error-box', form).textContent = error.message; } finally { button.disabled = false; }
  }
});
document.addEventListener('input', event => {
  if (event.target.id === 'comment-text') messageDraft = event.target.value;
});
function updatePlanPreview(input) {
  const form = input.form;
  if (input.name === 'end_date') form.elements.auto_extend.checked = false;
  const auto = form.elements.auto_extend.checked;
  if (input.name === 'start_date') form.elements.end_date.min = form.elements.start_date.value;
  if (auto && form.elements.start_date.value) {
    const preview = extendedPlan({ ...state.plan, start_date: form.elements.start_date.value, auto_extend: true }, state.today);
    form.elements.end_date.value = preview.end_date;
  }
  $('#plan-mode-hint').textContent = auto ? '累计天数随每次延续增加，原记录保留' : '已指定结束日期，不自动延续';
}
document.addEventListener('change', event => {
  if (event.target.closest('#plan-form')) updatePlanPreview(event.target);
  if (event.target.name === 'day' && event.target.closest('#edit-form')) {
    const form = event.target.form, r = recordFor(event.target.value); form.dataset.version = r?.version ?? 0;
    form.elements.weight.value = r?.weight ?? ''; form.elements.note.value = r?.note ?? '';
  }
});
document.addEventListener('submit', async event => {
  const form = event.target; if (!form.id.endsWith('-form')) return; event.preventDefault();
  const values = Object.fromEntries(new FormData(form)); const submit = $('button[type="submit"]', form), errorBox = $('.error-box', form);
  if (submit) submit.disabled = true; if (errorBox) errorBox.textContent = '';
  try {
    switch (form.id) {
      case 'login-form': await api('/api/login', 'POST', values); await load(); break;
      case 'setup-form': await api('/api/setup', 'POST', values); await load(); break;
      case 'edit-form': await saveRecord(values.day, Number(values.weight), values.note, Number(form.dataset.version)); $('#record-dialog').close(); toast(demo ? '演示记录已更新，不会保存到服务器' : '记录已保存'); break;
      case 'comment-form':
        if (!values.text.trim()) throw new Error('请输入留言');
        if (demo) {
          state.comments.push({ id: Date.now(), user_id: state.user.id, name: state.user.name, role: state.user.role, text: values.text.trim(), created_at: state.today + 'T12:00:00+08:00' });
        } else { await api('/api/comments', 'POST', values); }
        messageDraft = '';
        $('#comment-text').value = '';
        if (!demo) await refresh(true);
        updateChat(true);
        await markMessagesRead();
        break;
      case 'plan-form':
      case 'goal-form':
        const plan = { start_date: values.start_date ?? state.plan.start_date, goal_weight: form.id === 'goal-form' ? (values.goal_weight === '' ? null : Number(values.goal_weight)) : state.plan.goal_weight, version: Number(form.dataset.version) };
        if (form.id === 'plan-form') {
          plan.auto_extend = values.auto_extend === 'on';
          if (!plan.auto_extend) plan.end_date = values.end_date;
        }
        if (demo) {
          let next = { ...state.plan, ...plan };
          if (form.id === 'plan-form' && !plan.auto_extend) {
            const days = dayDiff(values.end_date, values.start_date) + 1;
            if (!Number.isFinite(days) || days < 1 || days > 36525) throw new Error('结束日期不得早于开始日期，计划范围最多为 100 年');
            next.days = days;
          }
          next = extendedPlan(next, state.today);
          if (state.records.some(r => r.day < next.start_date || r.day > next.end_date)) throw new Error('修改后的计划会排除已有记录，请保留这些日期');
          next.version = state.plan.version + 1;
          state.plan = next; render();
        }
        else { await api('/api/plan', 'PUT', plan); await refresh(true); }
        toast(demo ? '演示设置已更新，不会保存' : '已保存'); break;
      case 'password-form':
        if (demo) throw new Error('演示模式无法修改密码');
        await api('/api/password', 'POST', values); form.reset(); toast('密码已更新，其他设备需要重新登录'); break;
    }
  } catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message); }
  finally { if (submit) submit.disabled = false; }
});
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden) { syncChatViewport(); await refresh(true); if (demo) await markMessagesRead(); }
});
document.addEventListener('scroll', event => {
  if (event.target.id === 'message-list') void markMessagesRead();
}, true);
document.addEventListener('focusin', syncChatViewport);
document.addEventListener('focusout', () => { setTimeout(syncChatViewport, 0); });
window.addEventListener('resize', syncChatViewport, { passive: true });
window.visualViewport?.addEventListener('resize', syncChatViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncChatViewport, { passive: true });
document.addEventListener('keydown', event => {
  if (event.target.id === 'comment-text' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    const form = event.target.form;
    if (!form.querySelector('button[type="submit"]').disabled) form.requestSubmit();
  }
});
setInterval(() => refresh(), 4000);
load();
