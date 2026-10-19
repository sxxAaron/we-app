'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const root = $('#app');
let state, screen = 'overview', range = 100, demo = new URLSearchParams(location.search).get('demo') === '1';
let includeEmpty = false, recordMonth = '', toastTimer, lastSync = '', refreshing = false;
const draft = { weight: '', note: '' };
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
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
function resetDraft() {
  const record = recordFor(state.today); draft.weight = record?.weight ?? ''; draft.note = record?.note ?? '';
}
async function load() {
  if (demo) { state = demoState(); lastSync = '刚刚'; resetDraft(); render(); return; }
  try {
    const status = await api('/api/status');
    if (status.setupRequired) return renderAuth(true);
    state = await api('/api/state'); lastSync = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); resetDraft(); render();
  } catch (error) {
    if (error.status === 401) renderAuth(false);
    else root.innerHTML = `<div class="loading">连接失败<span>${escape(error.message)}</span><p><button class="quiet" data-action="reload">重新连接</button></p></div>`;
  }
}
async function refresh(force = false) {
  if (demo || !state || refreshing) return;
  if (!force && (document.hidden || $('#record-dialog').open || /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))) return;
  refreshing = true;
  try {
    const next = await api('/api/state');
    const changed = JSON.stringify([state.records, state.comments, state.plan, state.today]) !== JSON.stringify([next.records, next.comments, next.plan, next.today]);
    state = next;
    lastSync = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (force || changed) { resetDraft(); render(); }
    else syncLabel();
  } catch (error) {
    if (error.status === 401) { state = null; $('#record-dialog').close(); renderAuth(false); }
    else { syncLabel(true); if (force) toast(error.message); }
  } finally { refreshing = false; }
}
function demoState() {
  const weights = [82.4, 82.2, 82.3, 81.9, 82.0, 81.7, 81.8, 81.6, 81.5, 81.7, 81.3, 81.2];
  const notes = ['早晨空腹测量', '', '散步 30 分钟', '', '', '', '', '', '', '晚餐火锅', '散步 40 分钟', '早晨空腹测量'];
  return { user: { id: 1, username: 'demo', name: '记录者', role: 'owner' }, today: '2026-10-30', plan: { start_date: '2026-10-19', days: 100, goal_weight: 76, version: 1 }, records: weights.map((weight, i) => ({ day: dayAdd('2026-10-19', i), weight, note: notes[i], version: 1 })), comments: [{ id: 1, user_id: 2, name: '查看者', role: 'viewer', text: '明天早上记得称一下。', created_at: '2026-10-29T20:36:00+08:00' }, { id: 2, user_id: 1, name: '记录者', role: 'owner', text: '好，明早记录。', created_at: '2026-10-29T21:04:00+08:00' }, { id: 3, user_id: 2, name: '查看者', role: 'viewer', text: '晚上去散步？', created_at: '2026-10-30T09:18:00+08:00' }] };
}
function nav(extra = '') {
  const tabs = [['overview', '概览'], ['records', '记录'], ['settings', '设置']];
  return `<nav class="${extra || 'nav'}" aria-label="主导航">${tabs.map(([key, label]) => `
    <button type="button" data-screen="${key}" class="${screen === key ? 'active' : ''}" ${screen === key ? 'aria-current="page"' : ''}>
      ${icon(key)}<span>${label}</span>
    </button>`).join('')}</nav>`;
}

function render() {
  const titles = { overview: '概览', records: '记录', settings: '设置' };
  const label = state.today < state.plan.start_date ? '计划未开始' : state.today > endDate() ? '计划已结束' : `第 ${elapsed()} / 100 天`;
  root.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        ${brand()}
        ${nav()}
        <div class="sidebar-bottom">
          <button class="export-shortcut" data-action="export">${icon('download')}<span>导出记录</span>${icon('arrow')}</button>
          <span class="sidebar-product">100 天体重记录</span>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div class="breadcrumb">we.app <span>/</span> 体重记录</div>
          ${brand('mobile-brand')}
          <div class="account"><span class="avatar ${state.user.role}">${escape(state.user.name.slice(0, 1))}</span><span>${escape(state.user.name)}</span><button class="text-link logout" data-action="logout">${demo ? '退出演示' : '退出'}</button></div>
        </div>
        ${demo ? '<div class="demo-banner"><span>演示模式 · 示例数据不会保存</span><a href="/">返回应用 →</a></div>' : ''}
        <header class="page-heading">
          <div><h1>${titles[screen]}</h1><p>${fullDate(state.today)}<span class="heading-separator">/</span>${new Date(state.today + 'T12:00:00').toLocaleDateString('zh-CN', { weekday: 'long' })}</p></div>
          <span class="plan-pill">${icon('calendar')}${label}</span>
        </header>
        ${screen === 'overview' ? overview() : screen === 'records' ? recordsPage() : settingsPage()}
        <footer class="page-footer"><span>we.app</span><span class="sync-state"><i class="status-dot"></i><span id="sync-status">${demo ? '演示数据' : `已同步 ${lastSync}`}</span><button class="icon-button" data-action="sync" aria-label="刷新同步">${icon('refresh')}</button></span></footer>
      </main>
      ${nav('bottom-nav')}
    </div>`;
}

function overview() {
  const list = state.records, first = list[0], latest = list.at(-1), current = recordFor(state.today);
  const change = latest && first ? latest.weight - first.weight : null;
  const goal = state.plan.goal_weight;
  const remaining = latest && goal != null ? Math.max(0, latest.weight - goal) : null;
  return `
    <section class="stats" aria-label="体重概况">
      ${stat('最新体重', number(latest?.weight), 'kg', latest ? fullDate(latest.day) : '暂无记录', 'weight', 'featured')}
      ${stat('累计变化', changeText(change), 'kg', first ? `首次 ${number(first.weight)} kg` : '相较首次记录', 'trend', change < 0 ? 'decrease' : '')}
      ${stat('目标体重', number(goal), 'kg', goal == null ? '未设置' : remaining == null ? '—' : remaining === 0 ? '已达目标' : `距目标 ${number(remaining)} kg`, 'flag')}
      ${stat('已记录', list.length, '/ 100 天', `完成 ${list.length}%`, 'records')}
    </section>
    <section class="plan-strip" aria-label="计划进度">
      <div class="plan-label"><span class="plan-mark">100</span><div><strong>100 天计划</strong><span>${fullDate(state.plan.start_date)} — ${fullDate(endDate())}</span></div></div>
      <div class="plan-progress"><div><span>时间进度</span><b>${elapsed()}<small> / 100 天</small></b></div><progress value="${elapsed()}" max="100" aria-label="计划已进行 ${elapsed()} 天"></progress></div>
    </section>
    <div class="content-grid">
      <section class="panel trend-panel">
        <div class="panel-head"><h2>体重趋势 <span class="unit-label">kg</span></h2><div class="range-switch" aria-label="曲线时间范围">${[7, 30, 100].map(n => `<button type="button" data-range="${n}" class="${range === n ? 'active' : ''}" aria-pressed="${range === n}">${n === 100 ? '全部' : n + '天'}</button>`).join('')}</div></div>
        <div class="chart">${chart()}</div>
        <div class="chart-caption"><i></i>体重<span>共 ${list.filter(r => range === 100 || r.day >= dayAdd(state.today > endDate() ? endDate() : state.today, 1 - range)).length} 条记录</span></div>
      </section>
      ${todayCard(current)}
    </div>
    <div class="content-grid lower">
      <section class="panel recent-panel"><div class="panel-head"><h2>最近记录</h2><button class="text-link" data-screen="records">全部记录 ${icon('arrow')}</button></div>${table([...list].reverse().slice(0, 5), false)}</section>
      ${messages()}
    </div>`;
}

function stat(label, value, unit, caption, symbol, modifier = '') {
  return `<article class="stat ${modifier}"><div class="stat-label">${label}${icon(symbol)}</div><div class="stat-value"><strong>${value}</strong><span>${unit}</span></div><p>${caption}</p></article>`;
}

function chart() {
  const until = state.today < state.plan.start_date ? state.plan.start_date : state.today > endDate() ? endDate() : state.today;
  const lower = dayAdd(until, 1 - range);
  const data = state.records.filter(r => range === 100 || r.day >= lower);
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
  const dots = data.map((r, i) => `<circle cx="${x(r)}" cy="${y(r.weight)}" r="${data.length > 40 ? 2 : i === data.length - 1 ? 4 : 3}" fill="${i === data.length - 1 ? '#3d63ed' : '#fff'}" stroke="#3d63ed" stroke-width="2"><title>${r.day} · ${number(r.weight)} kg</title></circle>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体重趋势，共 ${data.length} 条记录，从 ${number(data[0].weight)} 到 ${number(data.at(-1).weight)} 千克"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6386ff" stop-opacity=".16"/><stop offset="100%" stop-color="#6386ff" stop-opacity="0"/></linearGradient></defs>${axis}${data.length > 1 ? `<polygon points="${x(data[0])},${height - bottom} ${points} ${x(data.at(-1))},${height - bottom}" fill="url(#chart-fill)"/><polyline points="${points}" fill="none" stroke="#3d63ed" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>` : ''}${dots}${labels}</svg>`;
}

function todayCard(current) {
  const head = `<div class="panel-head"><h2>今日记录</h2><span class="date-line">${shortDate(state.today)}</span></div>`;
  if (!owner()) return `<section class="panel record-card">${head}<div class="viewer-status">${current ? `<strong>${number(current.weight)}</strong><span>kg</span>` : '<span class="muted">今日未记录</span>'}</div>${current?.note ? `<div class="viewer-note">${escape(current.note)}</div>` : ''}<div class="record-status ${current ? 'saved' : ''}">${icon(current ? 'check' : 'clock')}${current ? '已记录' : '待记录'}</div></section>`;
  const inPlan = state.today >= state.plan.start_date && state.today <= endDate();
  if (!inPlan) return `<section class="panel record-card">${head}<div class="empty">${state.today < state.plan.start_date ? '计划未开始' : '计划已结束'}</div><button class="quiet wide" data-screen="records">查看记录</button></section>`;
  return `<section class="panel record-card">${head}<form id="today-form" data-version="${current?.version ?? 0}">
    <label class="weight-input"><span class="sr-only">体重</span><input name="weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="—" value="${escape(draft.weight)}" required aria-label="今天的体重，千克"><span>kg</span></label>
    <label class="field">备注<textarea name="note" maxlength="500" placeholder="选填">${escape(draft.note)}</textarea></label>
    <div class="error-box" role="alert"></div><button class="primary wide" type="submit">${icon(current ? 'check' : 'plus')}${current ? '更新记录' : '保存记录'}</button>
    <div class="record-status ${current ? 'saved' : ''}">${icon(current ? 'check' : 'clock')}${current ? '今日已记录' : '今日未记录'}</div>
  </form></section>`;
}

function table(rows, showEmpty) {
  if (!rows.length) return '<div class="empty table-empty">暂无记录</div>';
  return `<div class="table-wrap"><table><thead><tr><th>日期</th><th class="numeric">体重 <span>/ kg</span></th><th>备注</th>${owner() ? '<th class="action-cell"></th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr><td><span class="table-date">${shortDate(r.day)}</span>${r.day === state.today ? '<span class="badge">今天</span>' : ''}${showEmpty ? `<div class="table-day">第 ${dayDiff(r.day, state.plan.start_date) + 1} 天</div>` : ''}</td><td class="numeric"><b>${number(r.weight)}</b></td><td class="note">${r.weight == null ? r.day > state.today ? '未开始' : '未记录' : escape(r.note || '—')}</td>${owner() ? `<td class="action-cell">${r.day <= state.today ? `<button class="text-link" data-edit="${r.day}">${r.weight == null ? '补记' : '修改'}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function messages() {
  return `<section class="panel messages-panel"><div class="panel-head"><h2>留言</h2><span class="count-badge">${state.comments.length}</span></div>
    <div class="message-list" id="message-list">${state.comments.length ? state.comments.map(c => `<article class="message ${c.user_id === state.user.id ? 'own-message' : ''}"><span class="avatar ${c.role}">${escape(c.name.slice(0, 1))}</span><div class="message-main"><div class="message-head"><span>${escape(c.name)}</span><time datetime="${escape(c.created_at)}">${shortDate(c.created_at.slice(0, 10))} ${c.created_at.slice(11, 16)}</time></div><p>${escape(c.text)}</p></div></article>`).join('') : '<div class="empty message-empty">暂无留言</div>'}</div>
    <form class="comment-form" id="comment-form"><label class="sr-only" for="comment-text">留言内容</label><textarea id="comment-text" name="text" rows="1" maxlength="500" placeholder="写留言…" required></textarea><button class="primary" type="submit" aria-label="发送留言">${icon('send')}</button></form>
  </section>`;
}

function recordsPage() {
  const days = Array.from({ length: 100 }, (_, i) => dayAdd(state.plan.start_date, i));
  return `<section class="panel calendar-panel"><div class="panel-head"><h2>记录日历</h2><span class="muted calendar-total">已记录 <b>${state.records.length}</b> / 100 天</span></div>
    <div class="calendar-legend"><span><i class="done-key"></i>已记录</span><span><i class="today-key"></i>今天</span></div>
    <div class="calendar">${days.map((d, i) => `<${owner() && d <= state.today ? 'button' : 'span'} class="day-cell ${recordFor(d) ? 'done' : ''} ${d === state.today ? 'current' : ''} ${d > state.today ? 'future' : ''}" ${owner() && d <= state.today ? `data-edit="${d}"` : ''} title="${d}${recordFor(d) ? ' · ' + number(recordFor(d).weight) + ' kg' : ''}" aria-label="第 ${i + 1} 天，${d}，${recordFor(d) ? '已记录' : '未记录'}">${i + 1}</${owner() && d <= state.today ? 'button' : 'span'}>`).join('')}</div>
    <div class="calendar-label"><span>${fullDate(state.plan.start_date)}</span><span>${fullDate(endDate())}</span></div></section>
    <section class="panel section-space"><div class="panel-head"><h2>全部记录</h2><button class="quiet" data-action="export">${icon('download')}导出 CSV</button></div>
      <div class="record-toolbar"><label class="sr-only" for="record-month">按月份筛选记录</label><input id="record-month" class="input" type="month" value="${recordMonth}" aria-label="按月份筛选记录"><button class="text-link" data-action="clear-month">全部月份</button><label class="checkbox-label"><input id="include-empty" type="checkbox" ${includeEmpty ? 'checked' : ''}>显示未记录日期</label>${owner() ? `<button class="primary" data-action="new-record">${icon('plus')}记录体重</button>` : ''}</div>
      <div id="records-table">${recordRows()}</div>
    </section>`;
}

function recordRows() {
  let rows = includeEmpty ? Array.from({ length: 100 }, (_, i) => { const day = dayAdd(state.plan.start_date, i); return recordFor(day) || { day, weight: null, note: '' }; }) : state.records;
  if (recordMonth) rows = rows.filter(r => r.day.startsWith(recordMonth));
  return table([...rows].reverse(), true);
}

function settingsPage() {
  return `<div class="settings-grid">
    <section class="panel"><div class="panel-head"><h2>计划</h2>${icon('calendar')}</div><form id="plan-form"><label class="field">开始日期<input name="start_date" type="date" value="${state.plan.start_date}" required ${owner() ? '' : 'disabled'}></label><label class="field">结束日期<input value="${endDate()} · 100 天" disabled></label><label class="field">目标体重 <span class="optional">选填 · kg</span><input name="goal_weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="未设置" value="${state.plan.goal_weight ?? ''}" ${owner() ? '' : 'disabled'}></label><div class="error-box" role="alert"></div>${owner() ? '<button class="primary" type="submit">保存设置</button>' : ''}</form></section>
    <section class="panel"><div class="panel-head"><h2>账号</h2><span class="role-badge">${owner() ? '记录者' : '查看与留言'}</span></div><div class="account-summary"><span class="avatar ${state.user.role}">${escape(state.user.name.slice(0, 1))}</span><strong>${escape(state.user.username)}</strong></div><form id="password-form"><label class="field">当前密码<input name="current" type="password" autocomplete="current-password" maxlength="128" required></label><label class="field">新密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" placeholder="至少 10 个字符" required></label><div class="error-box" role="alert"></div><button class="quiet" type="submit">修改密码</button></form></section>
    <section class="panel data-panel"><div class="panel-head"><h2>数据</h2>${icon('download')}</div><div class="data-export-row"><div><strong>体重记录</strong><span>日期、体重、备注</span></div><button class="quiet" data-action="export">导出 CSV ${icon('arrow')}</button></div>${owner() ? '<div class="data-export-row"><div><strong>完整数据</strong><span>计划、记录、留言</span></div><button class="quiet" data-action="backup">下载备份 ' + icon('arrow') + '</button></div>' : ''}</section>
  </div>`;
}

function renderAuth(setup) {
  root.innerHTML = `<main class="auth-page ${setup ? 'setup' : ''}"><div class="auth-container">${brand()}<section class="auth-card"><header><h1>${setup ? '初始化账号' : '登录'}</h1><span>100 天体重记录</span></header>
    <form id="${setup ? 'setup-form' : 'login-form'}">${setup ? `
      <label class="field">初始化密钥<input name="token" type="password" autocomplete="off" required></label>
      <div class="form-section">记录者</div><div class="form-grid"><label class="field">账号<input name="owner_username" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">昵称<input name="owner_name" value="记录者" maxlength="24" required></label></div><label class="field">密码<input name="owner_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="至少 10 个字符" required></label>
      <div class="form-section">查看与留言</div><div class="form-grid"><label class="field">账号<input name="viewer_username" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">昵称<input name="viewer_name" value="查看者" maxlength="24" required></label></div><label class="field">密码<input name="viewer_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="至少 10 个字符" required></label><label class="field">开始日期<input name="start_date" type="date" value="2026-10-19" required></label>` : `
      <label class="field">账号<input name="username" autocomplete="username" maxlength="32" placeholder="输入账号" required></label>
      <label class="field">密码<input name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="输入密码" required></label>`}
      <div class="error-box" role="alert"></div><button class="primary wide" type="submit">${setup ? '创建账号' : '登录'}${icon('arrow')}</button>
    </form></section><a class="auth-demo" href="/?demo=1">查看演示 ${icon('arrow')}</a></div></main>`;
}

function editRecord(day) {
  if (!owner()) return;
  const r = recordFor(day), dialog = $('#record-dialog');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="record-title">${r ? '修改记录' : '记录体重'}</h2><button type="button" class="close" data-action="close-dialog" aria-label="关闭">×</button></div><form id="edit-form" data-original-day="${day}" data-version="${r?.version ?? 0}"><label class="field">日期<input name="day" type="date" value="${day}" min="${state.plan.start_date}" max="${state.today < endDate() ? state.today : endDate()}" ${r ? 'readonly' : ''} required></label><label class="field">体重 <span class="optional">kg</span><input name="weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" value="${r?.weight ?? ''}" required autofocus></label><label class="field">备注<textarea name="note" maxlength="500" rows="3" placeholder="选填">${escape(r?.note || '')}</textarea></label><div class="error-box" role="alert"></div><div class="button-row">${r ? '<button type="button" class="text-link danger" data-action="delete-record">删除记录</button>' : '<span></span>'}<button class="primary" type="submit">保存</button></div></form>`;
  dialog.showModal();
}

async function saveRecord(day, weight, note, version) {
  if (demo) {
    const record = { day, weight, note, version: version + 1 };
    state.records = [...state.records.filter(r => r.day !== day), record].sort((a, b) => a.day.localeCompare(b.day)); resetDraft(); render(); return;
  }
  await api('/api/records/' + day, 'PUT', { weight, note, version }); await refresh(true);
}
function downloadDemo(kind) {
  let text, mime, filename;
  if (kind === 'export') {
    text = '\ufeff日期,体重(kg),备注\r\n' + state.records.map(r => [r.day, r.weight, '"' + r.note.replaceAll('"', '""') + '"'].join(',')).join('\r\n'); mime = 'text/csv;charset=utf-8'; filename = 'demo-records.csv';
  } else { text = JSON.stringify({ demo: true, ...state }, null, 2); mime = 'application/json'; filename = 'demo-backup.json'; }
  const url = URL.createObjectURL(new Blob([text], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const action = button.dataset.action;
  if (button.dataset.screen) { screen = button.dataset.screen; render(); window.scrollTo({ top: 0 }); }
  else if (button.dataset.range) { range = Number(button.dataset.range); render(); }
  else if (button.dataset.edit) editRecord(button.dataset.edit);
  else if (action === 'close-dialog') $('#record-dialog').close();
  else if (action === 'reload') load();
  else if (action === 'new-record') {
    if (state.today < state.plan.start_date) toast('计划未开始');
    else editRecord(state.today < endDate() ? state.today : endDate());
  }
  else if (action === 'clear-month') { recordMonth = ''; $('#record-month').value = ''; $('#records-table').innerHTML = recordRows(); }
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
      if (demo) { state.records = state.records.filter(r => r.day !== day); resetDraft(); render(); }
      else { await api('/api/records/' + day, 'DELETE', { version: Number(form.dataset.version) }); await refresh(true); }
      $('#record-dialog').close(); toast(demo ? '演示记录已删除，刷新页面会恢复' : '记录已删除');
    } catch (error) { $('.error-box', form).textContent = error.message; } finally { button.disabled = false; }
  }
});
document.addEventListener('input', event => {
  if (event.target.closest('#today-form')) draft[event.target.name] = event.target.value;
});
document.addEventListener('change', event => {
  if (event.target.id === 'record-month') { recordMonth = event.target.value; $('#records-table').innerHTML = recordRows(); }
  if (event.target.id === 'include-empty') { includeEmpty = event.target.checked; $('#records-table').innerHTML = recordRows(); }
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
      case 'today-form': await saveRecord(state.today, Number(values.weight), values.note, Number(form.dataset.version)); toast(demo ? '演示记录已更新，不会保存到服务器' : '已保存'); break;
      case 'edit-form': await saveRecord(values.day, Number(values.weight), values.note, Number(form.dataset.version)); $('#record-dialog').close(); toast(demo ? '演示记录已更新，不会保存到服务器' : '记录已保存'); break;
      case 'comment-form':
        if (!values.text.trim()) throw new Error('请输入留言');
        if (demo) { state.comments.push({ id: Date.now(), user_id: 1, name: state.user.name, role: state.user.role, text: values.text.trim(), created_at: state.today + 'T12:00:00+08:00' }); render(); }
        else { await api('/api/comments', 'POST', values); await refresh(true); }
        if ($('#message-list')) $('#message-list').scrollTop = $('#message-list').scrollHeight;
        toast(demo ? '演示留言已添加，刷新页面会恢复' : '已发送'); break;
      case 'plan-form':
        const plan = { start_date: values.start_date, goal_weight: values.goal_weight === '' ? null : Number(values.goal_weight), version: state.plan.version };
        if (demo) { state.plan = { ...state.plan, ...plan }; render(); }
        else { await api('/api/plan', 'PUT', plan); await refresh(true); }
        toast(demo ? '演示计划已更新，不会保存' : '计划已保存'); break;
      case 'password-form':
        if (demo) throw new Error('演示模式无法修改密码');
        await api('/api/password', 'POST', values); form.reset(); toast('密码已更新，其他设备需要重新登录'); break;
    }
  } catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message); }
  finally { if (submit) submit.disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => refresh(), 15000);
load();
