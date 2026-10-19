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
  plus: '<path d="M12 5v14M5 12h14"/>'
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
const brand = (extra = '') => `<div class="brand ${extra}"><img src="/icon.svg" alt=""><div><strong>一起，轻一点</strong><small>OUR LITTLE JOURNEY</small></div></div>`;
const plant = () => `<svg class="plant" viewBox="0 0 180 170" fill="none" aria-hidden="true"><ellipse cx="91" cy="155" rx="56" ry="6" fill="#183e32" opacity=".4"/><path d="M65 111h55l-8 39H73l-8-39Z" fill="#c3ac8a"/><path d="M65 111h55l-2 9H67l-2-9Z" fill="#d9c5a7"/><path d="M94 114c-3-36 2-61 13-86M92 89 63 63m31 3 31-21M92 106 58 88m38-9 30-8" stroke="#c5d6a4" stroke-width="2.5" stroke-linecap="round"/><path d="M105 47c-15-11-11-29 7-37 10 15 10 31-7 37Z" fill="#d6e6ad"/><path d="M88 84c-21 2-36-10-34-31 21 1 38 10 34 31Z" fill="#a0bb85"/><path d="M98 72c0-22 14-36 34-33 0 20-12 36-34 33Z" fill="#c4d5a3"/><path d="M88 107c-25 5-42-5-44-25 24-3 42 5 44 25Z" fill="#b6cb94"/><path d="M100 100c1-23 16-35 38-30-4 21-17 35-38 30Z" fill="#89aa73"/><path d="m64 64 20 16m28-51-6 14m21 3-24 22M57 88l26 15m44-26-23 18" stroke="#e3ecc9" stroke-width="1" opacity=".5"/></svg>`;

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
  if (element) { element.classList.toggle('sync-error', error); element.textContent = demo ? '演示数据 · 不会保存' : error ? '连接中断，正在重试' : `已同步 ${lastSync}`; }
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
    else root.innerHTML = `<div class="loading">暂时没有连接上<span>${escape(error.message)}</span><p><button class="quiet" data-action="reload">重新连接</button></p></div>`;
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
  const notes = ['今天开始，一起慢慢来', '', '晚饭后散步了半小时', '', '早睡了一点', '', '周末也记得记录', '', '', '吃了喜欢的火锅', '散步的天气刚刚好', '精神不错，继续坚持'];
  return { user: { id: 1, username: 'demo', name: '记录者', role: 'owner' }, today: '2026-10-30', plan: { start_date: '2026-10-19', days: 100, goal_weight: 76, version: 1 }, records: weights.map((weight, i) => ({ day: dayAdd('2026-10-19', i), weight, note: notes[i], version: 1 })), comments: [{ id: 1, user_id: 2, name: '陪伴者', role: 'viewer', text: '不用着急，每天记录一点点就很好啦。', created_at: '2026-10-29T20:36:00+08:00' }, { id: 2, user_id: 1, name: '记录者', role: 'owner', text: '有你陪着，感觉坚持也没那么难。', created_at: '2026-10-29T21:04:00+08:00' }, { id: 3, user_id: 2, name: '陪伴者', role: 'viewer', text: '今天也一起散步吧 🌿', created_at: '2026-10-30T09:18:00+08:00' }] };
}
function nav(extra = '') {
  return `<nav class="${extra || 'nav'}" aria-label="主导航">${[['overview', '旅程概览'], ['records', '每日记录'], ['settings', '计划设置']].map(([key, name]) => `<button type="button" data-screen="${key}" class="${screen === key ? 'active' : ''}" ${screen === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${name}</span></button>`).join('')}</nav>`;
}
function render() {
  const title = screen === 'overview' ? '每一天，都算数。' : screen === 'records' ? '变化，藏在每天里。' : '按自己的节奏来。';
  const subtitle = screen === 'overview' ? '记录一点变化，和在意的人一起慢慢来。' : screen === 'records' ? '回头看看，每一次认真记录的小小日常。' : '属于你们的计划，舒服地坚持就很好。';
  root.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}${nav()}<div class="sidebar-note"><div class="little-leaf">❧</div><b>有人陪伴的坚持，<br>会轻松一点。</b>不用每天都有变化，<br>记得照顾好自己就好。</div><div class="sidebar-foot">100 DAYS · TOGETHER</div></aside><main class="main"><div class="topbar"><div class="breadcrumb">我们的100天<span>/</span>${screen === 'overview' ? '旅程概览' : screen === 'records' ? '每日记录' : '计划设置'}</div>${brand('mobile-brand')}<div class="account"><span class="avatar ${state.user.role}">${escape(state.user.name.slice(0, 1))}</span><span>${escape(state.user.name)}</span><button class="text-link" data-action="logout">${demo ? '退出演示' : '退出'}</button></div></div>${demo ? '<div class="demo-banner"><span>演示模式 · 以下体重和留言均为示例，不会保存。</span><a href="/">进入正式版 →</a></div>' : ''}<header class="page-heading"><div><div class="eyebrow">OUR 100-DAY JOURNEY</div><h1>${title}</h1><p>${subtitle}</p></div><div class="pill"><i class="dot"></i>只属于你们的记录</div></header>${screen === 'overview' ? overview() : screen === 'records' ? recordsPage() : settingsPage()}<footer class="page-footer"><span>${fullDate(state.plan.start_date)} — ${fullDate(endDate())} · 一起，轻一点</span><span class="sync-state"><span class="dot"></span><span id="sync-status">${demo ? '演示数据 · 不会保存' : `已同步 ${lastSync}`}</span><button class="text-link" data-action="sync" aria-label="刷新同步">↻</button></span><span class="footer-mark">SLOWLY, TOGETHER.</span></footer></main>${nav('bottom-nav')}</div>`;
}
function overview() {
  const list = state.records, first = list[0], latest = list.at(-1), current = recordFor(state.today);
  const change = latest && first ? latest.weight - first.weight : null;
  const goal = state.plan.goal_weight, remaining = latest && goal != null ? Math.max(0, latest.weight - goal) : null;
  return `<section class="hero"><div class="hero-copy"><div class="eyebrow">A LITTLE LIGHTER, A LITTLE CLOSER</div><h2><span>慢慢来，</span><span>一起变好。</span></h2><p>体重只是一个数字，<br>认真生活的每一天，都值得被记下。</p><div class="hero-progress"><label><span>已记录 ${list.length} 天</span><span>共 ${state.plan.days} 天</span></label><progress class="track" value="${list.length}" max="100" aria-label="已记录 ${list.length} 天"></progress></div></div>${plant()}<div class="hero-day"><small>${state.today < state.plan.start_date ? '等待出发' : state.today > endDate() ? '计划已结束' : '旅程进行中'}</small><strong>${String(elapsed()).padStart(2, '0')}<span>/ ${state.plan.days}</span></strong><em>${state.today < state.plan.start_date ? '从 ' + shortDate(state.plan.start_date) + ' 开始' : '今天是 ' + shortDate(state.today)}</em></div></section><div class="stats">${stat('最近体重', number(latest?.weight), 'kg', latest ? `${fullDate(latest.day)} 的记录` : '等待你的第一条记录', 'weight')}${stat('累计变化', changeText(change), 'kg', first ? `相较首次记录 ${number(first.weight)} kg` : '从第一次记录开始计算', 'trend', true)}${stat('目标体重', number(goal), 'kg', goal == null ? '可以在计划设置中填写' : remaining == null ? '按自己的节奏慢慢来' : remaining === 0 ? '最近体重已达到设定目标' : `距目标还有 ${number(remaining)} kg`, 'flag')}${stat('已记录', list.length, '天', `100 天计划 · 完成 ${list.length}%`, 'records')}</div><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2>体重的变化轨迹</h2><p class="panel-sub">看长一点的变化，也给自己一点时间。</p></div><div class="range-switch" aria-label="曲线时间范围">${[7, 30, 100].map(n => `<button data-range="${n}" class="${range === n ? 'active' : ''}" aria-pressed="${range === n}">${n === 100 ? '全部' : n + '天'}</button>`).join('')}</div></div><div class="chart">${chart()}</div><p class="chart-caption"><i></i>记录体重（kg） · 仅展示实际填写的数据</p></section>${todayCard(current)}</div><div class="content-grid lower"><section class="panel"><div class="panel-head"><div><h2>最近的记录</h2><p class="panel-sub">那些平常的小日子，都有迹可循。</p></div><button class="text-link" data-screen="records">查看全部 →</button></div>${table([...list].reverse().slice(0, 4), false)}</section>${messages()}</div>`;
}
function stat(label, value, unit, caption, symbol, green = false) {
  return `<div class="stat"><div class="stat-label">${label}${icon(symbol)}</div><strong class="${green ? 'positive' : ''}">${value}<small>${unit}</small></strong><p>${caption}</p></div>`;
}
function chart() {
  const lower = dayAdd(state.today < state.plan.start_date ? state.plan.start_date : state.today > endDate() ? endDate() : state.today, 1 - range);
  const data = state.records.filter(r => range === 100 || r.day >= lower);
  if (!data.length) return '<div class="empty"><div class="empty-icon">⌁</div>这段时间还没有记录<br>填下第一次体重，旅程就开始了。</div>';
  const width = 600, height = 235, left = 36, right = 17, top = 18, bottom = 35;
  const values = data.map(r => r.weight), minimum = Math.min(...values), maximum = Math.max(...values);
  const padding = Math.max(.5, (maximum - minimum) * .22), low = minimum - padding, high = maximum + padding;
  const span = Math.max(1, dayDiff(data.at(-1).day, data[0].day));
  const x = r => data.length === 1 ? (left + width - right) / 2 : left + dayDiff(r.day, data[0].day) / span * (width - left - right);
  const y = w => top + (high - w) / (high - low) * (height - top - bottom);
  const points = data.map(r => `${x(r).toFixed(2)},${y(r.weight).toFixed(2)}`).join(' ');
  const axis = [0, 1, 2, 3].map(i => { const yy = top + (height - top - bottom) * i / 3; return `<path d="M${left} ${yy}H${width - right}" stroke="#e9eee3" stroke-dasharray="3 5"/><text x="0" y="${yy + 3}" font-size="9" fill="#9aa48e">${number(high - (high - low) * i / 3)}</text>`; }).join('');
  const indices = [...new Set([0, Math.floor((data.length - 1) / 3), Math.floor((data.length - 1) * 2 / 3), data.length - 1])];
  const labels = indices.map(i => `<text x="${x(data[i])}" y="${height - 9}" text-anchor="middle" font-size="9" fill="#9aa48e">${shortDate(data[i].day)}</text>`).join('');
  const dots = data.map(r => `<circle cx="${x(r)}" cy="${y(r.weight)}" r="${data.length > 40 ? 2 : 3}" fill="#fff" stroke="#769561" stroke-width="1.6"><title>${r.day} · ${number(r.weight)} kg</title></circle>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体重趋势，共 ${data.length} 条记录，从 ${number(data[0].weight)} 到 ${number(data.at(-1).weight)} 千克"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#afc88c" stop-opacity=".35"/><stop offset="100%" stop-color="#afc88c" stop-opacity=".02"/></linearGradient></defs>${axis}${data.length > 1 ? `<polygon points="${x(data[0])},${height - bottom} ${points} ${x(data.at(-1))},${height - bottom}" fill="url(#chart-fill)"/><polyline points="${points}" fill="none" stroke="#769561" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}${dots}${labels}</svg>`;
}
function todayCard(current) {
  const inPlan = state.today >= state.plan.start_date && state.today <= endDate();
  if (!owner()) return `<section class="panel record-card"><div class="panel-head"><h2>今天的小记录</h2><span class="date-line">${shortDate(state.today)}</span></div><div class="viewer-status">${current ? `<strong>${number(current.weight)}</strong><small> kg</small>` : '<div class="empty">今天还没有记录<br>也许正在好好生活呢。</div>'}</div>${current?.note ? `<div class="viewer-note">${escape(current.note)}</div>` : ''}<p class="hint">你可以在下面留一句鼓励的话。</p></section>`;
  if (!inPlan) return `<section class="panel record-card"><div class="panel-head"><h2>今日记录</h2><span class="date-line">${shortDate(state.today)}</span></div><div class="empty">${state.today < state.plan.start_date ? '计划还没开始<br>期待一起出发的那一天。' : '这次 100 天旅程已结束。<br>仍然可以查看、补记和导出。'}</div><button class="quiet wide" data-screen="records">查看每日记录</button></section>`;
  return `<section class="panel record-card"><div class="panel-head"><div><h2>${current ? '今天，已经记下了' : '记下今天的自己'}</h2><p class="panel-sub">${current ? '需要调整？修改后再保存就好。' : '不论数字多少，都值得认真对待。'}</p></div><span class="date-line">${shortDate(state.today)}</span></div><form id="today-form" data-version="${current?.version ?? 0}"><label class="weight-input"><span class="sr-only">今天的体重</span><input name="weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="00.0" value="${escape(draft.weight)}" required aria-label="今天的体重，千克"><span>kg</span></label><label class="field">给今天留个备注<textarea name="note" maxlength="500" placeholder="吃了什么、散了会儿步，或者今天的心情…">${escape(draft.note)}</textarea></label><div class="error-box" role="alert"></div><button class="primary wide" type="submit">${icon(current ? 'check' : 'plus')}${current ? '更新今日记录' : '保存今日记录'}</button><p class="hint">保存后，对方打开或刷新就能看见。</p></form></section>`;
}
function table(rows, showEmpty) {
  if (!rows.length) return '<div class="empty">这里还没有记录。<br>第一笔，随时可以开始。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>日期</th><th>体重 / kg</th><th>备注</th>${owner() ? '<th>操作</th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr><td>${shortDate(r.day)}${r.day === state.today ? '<span class="badge">今天</span>' : ''}${showEmpty ? `<div class="muted">第 ${dayDiff(r.day, state.plan.start_date) + 1} 天</div>` : ''}</td><td><b>${number(r.weight)}</b></td><td class="note">${r.weight == null ? r.day > state.today ? '尚未到来' : '未记录' : escape(r.note || '—')}</td>${owner() ? `<td>${r.day <= state.today ? `<button class="text-link" data-edit="${r.day}">${r.weight == null ? '补记' : '修改'}</button>` : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function messages() {
  return `<section class="panel"><div class="panel-head"><div><h2>陪你说说话</h2><p class="panel-sub">变化有人看见，心情也有人惦记。</p></div><span class="muted">♡</span></div><div class="message-list" id="message-list">${state.comments.length ? state.comments.map(c => `<article class="message"><span class="avatar ${c.role}">${escape(c.name.slice(0, 1))}</span><div class="message-main"><div class="message-head"><span>${escape(c.name)}</span><time datetime="${escape(c.created_at)}">${shortDate(c.created_at.slice(0, 10))} ${c.created_at.slice(11, 16)}</time></div><p>${escape(c.text)}</p></div></article>`).join('') : '<div class="empty">留句话吧，<br>让这段旅程多一点陪伴。</div>'}</div><form class="comment-form" id="comment-form"><label class="sr-only" for="comment-text">留言内容</label><textarea id="comment-text" name="text" rows="1" maxlength="500" placeholder="留一句鼓励，或者分享今天的心情…" required></textarea><button class="primary" type="submit">发送 ↗</button></form></section>`;
}
function recordsPage() {
  const days = Array.from({ length: 100 }, (_, i) => dayAdd(state.plan.start_date, i));
  return `<section class="panel"><div class="panel-head"><div><h2>100 天，慢慢积累</h2><p class="panel-sub">绿色表示已记录，描边表示今天。${owner() ? '点击已经到来的日期可以补记。' : ''}</p></div><span class="pill">${state.records.length} / 100 天</span></div><div class="calendar">${days.map((d, i) => `<${owner() && d <= state.today ? 'button' : 'span'} class="day-cell ${recordFor(d) ? 'done' : ''} ${d === state.today ? 'current' : ''} ${d > state.today ? 'future' : ''}" ${owner() && d <= state.today ? `data-edit="${d}"` : ''} title="${d}${recordFor(d) ? ' · ' + number(recordFor(d).weight) + ' kg' : ''}" aria-label="第 ${i + 1} 天，${d}，${recordFor(d) ? '已记录' : '未记录'}">${i + 1}</${owner() && d <= state.today ? 'button' : 'span'}>`).join('')}</div><div class="calendar-label"><span>${fullDate(state.plan.start_date)}</span><span>${fullDate(endDate())}</span></div></section><section class="panel section-space"><div class="panel-head"><h2>每日记录</h2><button class="quiet" data-action="export">导出 CSV</button></div><div class="record-toolbar"><label class="sr-only" for="record-month">按月份筛选记录</label><input id="record-month" class="input" type="month" value="${recordMonth}" aria-label="按月份筛选记录"><button class="text-link" data-action="clear-month">全部月份</button><label class="muted"><input id="include-empty" type="checkbox" ${includeEmpty ? 'checked' : ''}> 显示未记录日期</label>${owner() ? `<button class="primary" data-action="new-record">${icon('plus')}补记体重</button>` : ''}</div><div id="records-table">${recordRows()}</div></section>`;
}
function recordRows() {
  let rows = includeEmpty ? Array.from({ length: 100 }, (_, i) => { const day = dayAdd(state.plan.start_date, i); return recordFor(day) || { day, weight: null, note: '' }; }) : state.records;
  if (recordMonth) rows = rows.filter(r => r.day.startsWith(recordMonth));
  return table([...rows].reverse(), true);
}
function settingsPage() {
  return `<div class="settings-grid"><section class="panel"><h2>我们的 100 天</h2><p>沿用原表的起始日期和 100 天安排。${owner() ? '目标体重可以留空，按自己的节奏记录。' : '计划由记录者设置，你可以查看并留言。'}</p><form id="plan-form"><label class="field">开始日期<input name="start_date" type="date" value="${state.plan.start_date}" required ${owner() ? '' : 'disabled'}></label><label class="field">结束日期<input value="${endDate()}（共 100 天）" disabled></label><label class="field">目标体重（选填，kg）<input name="goal_weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" placeholder="不设目标也可以" value="${state.plan.goal_weight ?? ''}" ${owner() ? '' : 'disabled'}></label><div class="error-box" role="alert"></div>${owner() ? '<button class="primary" type="submit">保存计划</button>' : ''}</form></section><section class="panel"><h2>记录留在自己手里</h2><p>CSV 保留“日期、体重、备注”三列，用 Excel 或 WPS 就能打开。完整备份还包括计划和留言。</p><div class="button-row"><button class="quiet" data-action="export">导出 CSV</button>${owner() ? '<button class="quiet" data-action="backup">下载完整数据备份</button>' : ''}</div><p class="panel-sub">正式部署后，数据库保存在你的服务器上；服务每小时更新当天备份，保留最近 14 个备份日。建议另存一份到其他设备。</p></section><section class="panel"><h2>账号与密码</h2><p>当前账号：${escape(state.user.username)} · ${owner() ? '记录者，可填写和修改体重' : '陪伴者，可查看和留言'}</p><form id="password-form"><label class="field">当前密码<input name="current" type="password" autocomplete="current-password" maxlength="128" required></label><label class="field">新密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required><small>至少 10 个字符，修改后其他设备需要重新登录。</small></label><div class="error-box" role="alert"></div><button class="primary" type="submit">修改密码</button></form></section><section class="panel"><h2>放到手机桌面</h2><p>iPhone：使用 Safari 打开，点“分享”，选择“添加到主屏幕”。</p><p>安卓：使用支持此功能的浏览器打开，在菜单中找到“添加到主屏幕”或“安装应用”。</p><p class="panel-sub">第一次登录后可保持登录 7 天。需要联网才能保存和同步，保存成功会明确提示。</p></section></div>`;
}
function renderAuth(setup) {
  root.innerHTML = `<main class="auth-page ${setup ? 'setup' : ''}"><section class="auth-visual">${brand()}<div><div class="eyebrow">OUR 100-DAY JOURNEY</div><h1>慢慢来，<br>一起变好。</h1><p>记录一点变化，<br>和在意的人一起，走过平常的每一天。</p>${plant()}</div></section><section class="auth-form"><div class="auth-inner"><div class="eyebrow">${setup ? 'THE FIRST LITTLE STEP' : 'WELCOME BACK'}</div><h2>${setup ? '开启你们的 100 天' : '欢迎回到你们的小天地'}</h2><p>${setup ? '只需初始化一次。设置两个专属账号：一人记录，一人陪伴，双方都能留言。' : '登录后，看看今天的小小变化。'}</p><form id="${setup ? 'setup-form' : 'login-form'}">${setup ? `<label class="field">初始化密钥<input name="token" type="password" autocomplete="off" required><small>在服务器项目目录执行 python3 manage.py setup-token 查看。</small></label><div class="form-section">记录者 · 填写体重和备注</div><div class="form-grid"><label class="field">登录账号<input name="owner_username" placeholder="例如 xiaoxiong" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">显示昵称<input name="owner_name" value="记录者" maxlength="24" required></label></div><label class="field">记录者密码<input name="owner_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><div class="form-section">陪伴者 · 查看记录和留言</div><div class="form-grid"><label class="field">登录账号<input name="viewer_username" placeholder="例如 together" pattern="[A-Za-z0-9_.\-]{3,32}" minlength="3" maxlength="32" autocomplete="off" required></label><label class="field">显示昵称<input name="viewer_name" value="陪伴者" maxlength="24" required></label></div><label class="field">陪伴者密码<input name="viewer_password" type="password" minlength="10" maxlength="128" autocomplete="new-password" required></label><label class="field">计划开始日期<input name="start_date" type="date" value="2026-10-19" required></label><p class="hint">账号用 3～32 位字母、数字等；密码至少 10 个字符。初始化后可各自修改密码。</p>` : '<label class="field">账号<input name="username" autocomplete="username" maxlength="32" placeholder="输入你的专属账号" required></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" maxlength="128" placeholder="输入密码" required></label>'}<div class="error-box" role="alert"></div><button class="primary wide" type="submit">${setup ? '创建属于你们的记录' : '进入我们的记录'} →</button></form><div class="auth-footer">${setup ? '先看看效果？' : '想先看看界面？'} <a href="/?demo=1">打开演示</a></div></div></section></main>`;
}
function editRecord(day) {
  if (!owner()) return;
  const r = recordFor(day), dialog = $('#record-dialog');
  dialog.innerHTML = `<div class="dialog-head"><h2 id="record-title">${r ? '修改' : '补记'}体重</h2><button type="button" class="close" data-action="close-dialog" aria-label="关闭">×</button></div><p class="panel-sub">日期内的同一天只保留一条记录。</p><form id="edit-form" data-original-day="${day}" data-version="${r?.version ?? 0}"><label class="field">日期<input name="day" type="date" value="${day}" min="${state.plan.start_date}" max="${state.today < endDate() ? state.today : endDate()}" ${r ? 'readonly' : ''} required></label><label class="field">体重（kg）<input name="weight" type="number" min="1" max="500" step="0.01" inputmode="decimal" value="${r?.weight ?? ''}" required autofocus></label><label class="field">备注<textarea name="note" maxlength="500" rows="3">${escape(r?.note || '')}</textarea></label><div class="error-box" role="alert"></div><div class="button-row">${r ? '<button type="button" class="text-link danger" data-action="delete-record">删除这条记录</button>' : '<span></span>'}<button class="primary" type="submit">保存记录</button></div></form>`;
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
    if (state.today < state.plan.start_date) toast('计划还没开始，开始后再记录就好');
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
      case 'today-form': await saveRecord(state.today, Number(values.weight), values.note, Number(form.dataset.version)); toast(demo ? '演示记录已更新，不会保存到服务器' : '今天的记录，已保存好'); break;
      case 'edit-form': await saveRecord(values.day, Number(values.weight), values.note, Number(form.dataset.version)); $('#record-dialog').close(); toast(demo ? '演示记录已更新，不会保存到服务器' : '记录已保存'); break;
      case 'comment-form':
        if (!values.text.trim()) throw new Error('先写一点想说的话吧');
        if (demo) { state.comments.push({ id: Date.now(), user_id: 1, name: state.user.name, role: state.user.role, text: values.text.trim(), created_at: state.today + 'T12:00:00+08:00' }); render(); }
        else { await api('/api/comments', 'POST', values); await refresh(true); }
        if ($('#message-list')) $('#message-list').scrollTop = $('#message-list').scrollHeight;
        toast(demo ? '演示留言已添加，刷新页面会恢复' : '留言已送达'); break;
      case 'plan-form':
        const plan = { start_date: values.start_date, goal_weight: values.goal_weight === '' ? null : Number(values.goal_weight), version: state.plan.version };
        if (demo) { state.plan = { ...state.plan, ...plan }; render(); }
        else { await api('/api/plan', 'PUT', plan); await refresh(true); }
        toast(demo ? '演示计划已更新，不会保存' : '计划已保存'); break;
      case 'password-form':
        if (demo) throw new Error('演示模式不修改密码，请进入正式版设置');
        await api('/api/password', 'POST', values); form.reset(); toast('密码已更新，其他设备需要重新登录'); break;
    }
  } catch (error) { if (errorBox) errorBox.textContent = error.message; else toast(error.message); }
  finally { if (submit) submit.disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => refresh(), 15000);
load();
