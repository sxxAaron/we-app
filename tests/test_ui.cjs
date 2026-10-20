// Run with node --test tests/test_ui.cjs. DOM stubs verify data flow; no browser rendering is simulated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8').replace(/\nload\(\);\s*$/, '\n');
function app() {
  const root = { innerHTML: '' };
  const log = { innerHTML: '', scrollTop: 100, scrollHeight: 900, clientHeight: 400 };
  const text = { id: 'comment-text', value: '', tagName: 'TEXTAREA', closest: s => s === '#comment-form' };
  const status = { textContent: '', classList: { toggle() {}, add() {}, remove() {} } };
  const nodes = new Map([['#app', root], ['#message-list', log], ['#comment-text', text], ['#chat-count', {}], ['#sync-status', status], ['#record-dialog', { open: false, showModal() { this.open=true; }, close() { this.open=false; } }], ['#toast', status]]);
  const events = new Map();
  const classes = new Set(), styles = new Map();
  const html = {
    clientWidth: 1200, clientHeight: 900,
    classList: { toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }, remove(name) { classes.delete(name); } },
    style: { setProperty(name, value) { styles.set(name, value); }, removeProperty(name) { styles.delete(name); } }
  };
  const context = vm.createContext({
    URLSearchParams, console, Map, JSON, Date, setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    document: { documentElement: html, querySelector: s => nodes.get(s) || null, querySelectorAll: () => [], addEventListener: (name, callback) => events.set(name, callback), activeElement: { tagName: 'BODY' }, hidden: false },
    location: { search: '' }, window: { innerWidth: 1200, innerHeight: 900, matchMedia() { return { matches: this.innerWidth <= 900 }; }, addEventListener: (name, callback) => events.set('window:' + name, callback), scrollTo() {} },
    FormData: class { constructor(form) { return new Map(Object.entries(form.values)); } },
    fetch: async () => { throw Error('Unexpected real network request'); }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run("state = demoState(); state.plan = extendedPlan(state.plan, state.today); demo = true;");
  return { run, context, events, nodes, root, log, text, classes, styles };
}
test('three primary tabs, history stays under home, and no home progress or chat', () => {
  const a = app();
  assert.deepEqual(Array.from(a.run("[...nav().matchAll(/data-screen=\"([^\"]+)/g)].map(m=>m[1])")), ['overview', 'messages', 'settings']);
  const home = a.run('overview()');
  assert.doesNotMatch(home, /<progress|plan-strip|comment-form|\bkg\b|千克/);
  assert.match(home, /data-screen="records"/);
  a.run("screen = 'records'");
  assert.match(a.run('nav()'), /data-screen="overview" class="active"/);
});
test('jin values stay unchanged across editing, stats, goal and chart', async () => {
  const a = app();
  a.run("state.records[state.records.length - 1].weight = 166.6; state.plan.goal_weight = 150;");
  assert.match(a.run('overview()'), /166\.6/);
  a.run('openLatestWeight()');
  assert.match(a.nodes.get('#record-dialog').innerHTML, /value="166.6"/);
  assert.match(a.run('chart()'), /166\.6 斤/);
  a.run("settingsSection='goal'");
  assert.match(a.run('settingsPage()'), /value="150"/);
  assert.doesNotMatch(a.run('settingsPage()'), /\bkg\b|千克/);
  await a.run("saveRecord(state.today, 167.2, 'note', 1)");
  assert.equal(a.run('recordFor(state.today).weight'), 167.2);
});
test('chat escapes messages, distinguishes own bubbles and preserves unsent text', () => {
  const a = app();
  a.run("messageDraft = 'draft <keep>'; state.comments[0].text = '<img src=x onerror=alert(1)>'; screen='messages';");
  const html = a.run('messages()');
  assert.match(html, /draft &lt;keep&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /chat-message own-message/);
  assert.match(html, /role="log"/);
});
test('chat polling keeps composer focus and text, preserves scroll while reading older messages', async () => {
  const a = app();
  a.run("screen='messages'; demo=false; messageDraft='unsent'; state.comments.push({id:4,user_id:2,name:'viewer',role:'viewer',text:'previous',created_at:'2026-10-30T09:20:00+08:00'});");
  a.context.document.activeElement = a.text;
  a.text.value = 'unsent';
  a.root.innerHTML = 'existing page';
  a.run("api = async () => ({...state, comments: [...state.comments, {id:5,user_id:2,name:'viewer',role:'viewer',text:'new message',created_at:'2026-10-30T09:21:00+08:00'}],comments_has_more:false});");
  await a.run('refresh()');
  assert.equal(a.text.value, 'unsent');
  assert.equal(a.run('messageDraft'), 'unsent');
  assert.equal(a.root.innerHTML, 'existing page');
  assert.equal(a.log.scrollTop, 100);
  assert.match(a.log.innerHTML, /new message/);
});
test('separate plan and goal forms preserve the other setting and send raw jin', async () => {
  const a = app();
  a.run("demo=false; state.plan.goal_weight=150; api = async (...args) => { captured = args; return {ok:true}; }; refresh = async () => {};");
  function form(id, values) { return { id, values, dataset:{version:'1'}, querySelector: s => s.includes('button') ? {disabled:false} : {textContent:''} }; }
  await a.events.get('submit')({ target: form('goal-form',{goal_weight:'148.5'}), preventDefault() {} });
  assert.equal(a.run('captured[2].goal_weight'), 148.5);
  assert.equal(a.run('captured[2].version'), 1);
  assert.equal(a.run('captured[2].start_date'), '2026-10-19');
  await a.events.get('submit')({ target: form('plan-form',{start_date:'2026-10-18',auto_extend:'on',end_date:'2027-01-25'}), preventDefault() {} });
  assert.equal(a.run('captured[2].goal_weight'), 150);
  assert.equal(a.run('captured[2].start_date'), '2026-10-18');
  assert.equal(a.run('captured[2].auto_extend'), true);
  await a.events.get('submit')({ target: form('plan-form',{start_date:'2026-10-19',end_date:'2026-12-31'}), preventDefault() {} });
  assert.equal(a.run('captured[2].auto_extend'), false);
  assert.equal(a.run('captured[2].end_date'), '2026-12-31');
});
test('settings entries open a separate editor with a return action, preserving viewer permissions', async () => {
  const a = app();
  a.run("screen='settings'; render();");
  assert.doesNotMatch(a.root.innerHTML, /page-heading|plan-pill|heading-separator|<form/);
  assert.equal((a.root.innerHTML.match(/data-setting=/g)||[]).length, 4);
  function click(dataset) { return { target: { closest: () => ({ dataset }) } }; }
  await a.events.get('click')(click({setting:'goal'}));
  assert.match(a.root.innerHTML, /id="goal-form"/);
  assert.match(a.root.innerHTML, /data-action="back-settings"/);
  assert.equal(a.run('screen'), 'settings');
  await a.events.get('click')(click({action:'back-settings'}));
  assert.doesNotMatch(a.root.innerHTML, /<form/);
  a.run("state.user.role='viewer'; state.user.id=2;");
  a.run('openLatestWeight()');
  assert.doesNotMatch(a.nodes.get('#record-dialog').innerHTML, /edit-form|<input|删除记录/);
  assert.match(a.run('messages()'), /comment-form/);
  a.run("settingsSection='goal'");
  assert.doesNotMatch(a.run('settingsPage()'), /保存目标/);
  assert.match(a.run('settingsPage()'), /name="goal_weight"[^>]*disabled/);
  a.run("settingsSection='export'");
  assert.doesNotMatch(a.run('settingsPage()'), /data-action="backup"/);
});

test('primary tabs have no page headings and conversation has no card or dialogue header', () => {
  const a = app();
  for (const tab of ['overview', 'messages', 'settings']) {
    a.run(`screen='${tab}'; render();`);
    assert.doesNotMatch(a.root.innerHTML, /page-heading|plan-pill|heading-separator|第 12 \/ 100 天/);
  }
  const chat = a.run('messages()');
  assert.match(chat, /class="conversation"/);
  assert.doesNotMatch(chat, /class="panel|chat-panel|<h[12]|chat-count/);
});

test('renewed plans include every day in totals, calendar and the full curve', () => {
  const a = app();
  a.run("state.today=dayAdd(state.plan.start_date,100); render();");
  assert.equal(a.run('state.plan.days'), 200);
  assert.match(a.run('overview()'), /\/ 200 天/);
  assert.equal((a.run('recordsPage()').match(/class="month-day /g)||[]).length, 42);
  assert.equal(a.run('selectedRecordDay'), a.run('state.today'));
  a.run("state.records.push({day:state.today,weight:160,note:'',version:1}); range=0;");
  assert.match(a.run('chart()'), /共 13 条记录/);
  a.run("state.plan.auto_extend=false; state.today=dayAdd(state.plan.start_date,350); render();");
  assert.equal(a.run('state.plan.days'), 200);
});
test('manual end selection disables renewal and returning keeps the plan intact', async () => {
  const a = app();
  const hint = {textContent:''};
  a.nodes.set('#plan-mode-hint',hint);
  const form = {elements:{auto_extend:{checked:true},start_date:{value:'2026-10-19'},end_date:{value:'2026-12-31'}}};
  a.context.manualInput = {form,name:'end_date'};
  a.run('updatePlanPreview(manualInput)');
  assert.equal(form.elements.auto_extend.checked,false);
  assert.match(hint.textContent,/不自动延续/);
  a.run("settingsSection='plan'");
  const html = a.run('settingsPage()');
  assert.match(html, /name="end_date"/);
  assert.ok(html.indexOf('data-action="back-settings"') < html.indexOf('<h1>计划设置</h1>'));
  const before = a.run('JSON.stringify(state.plan)');
  await a.events.get('click')({target:{closest:()=>({dataset:{action:'back-settings'}})}});
  assert.equal(a.run('JSON.stringify(state.plan)'),before);
});

test('calendar aligns actual dates, covers leap day and labels recorded versus missing days', () => {
  const a=app();
  a.run("state.plan={start_date:'2024-01-01',days:100,goal_weight:null,version:1}; state.today='2024-02-15'; state.records=[{day:'2024-02-12',weight:166.6,note:'walk',version:1}]; calendarMonth='2024-02'; selectedRecordDay='2024-02-12';");
  const calendar=a.run('recordsPage()');
  assert.equal((calendar.match(/class="month-day /g)||[]).length,42);
  assert.match(calendar,/data-day="2024-01-28"/);
  assert.match(calendar,/data-day="2024-02-29"/);
  assert.match(calendar,/data-day="2024-02-12"[^>]*aria-label="2024-02-12，166.6 斤，已记录"/);
  assert.match(calendar,/data-day="2024-02-11"[^>]*aria-label="2024-02-11，未记录"/);
  assert.doesNotMatch(calendar,/<table|records-table/);
  assert.equal(a.run("shiftMonth('2024-12',1)"),'2025-01');
  assert.equal(a.run("shiftMonth('2024-01',-1)"),'2023-12');
});
test('month controls stay inside the extended plan and selecting a date updates details', async () => {
  const a=app();
  a.run("screen='records'; calendarMonth='2026-10'; recordsPage();");
  const click=dataset=>({target:{closest:()=>({dataset})}});
  await a.events.get('click')(click({action:'previous-month'}));
  assert.equal(a.run('calendarMonth'),'2026-10');
  await a.events.get('click')(click({action:'next-month'}));
  assert.equal(a.run('calendarMonth'),'2026-11');
  await a.events.get('click')(click({day:'2026-10-29'}));
  assert.equal(a.run('selectedRecordDay'),'2026-10-29');
  assert.match(a.run('selectedRecord()'),/散步 40 分钟/);
  await a.events.get('click')(click({action:'calendar-today'}));
  assert.equal(a.run('selectedRecordDay'),a.run('state.today'));
});
test('latest weight opens today with its date fixed and never overwrites the previous record', async () => {
  const a=app();
  const yesterday=a.run('state.records.at(-1).day');
  a.run('state.today=dayAdd(state.today,1);');
  a.run('openLatestWeight()');
  const dialog=a.nodes.get('#record-dialog');
  assert.match(dialog.innerHTML,/今日记录/);
  assert.match(dialog.innerHTML,/name="day"[^>]*value="2026-10-31"[^>]*readonly/);
  assert.match(dialog.innerHTML,/name="weight"[^>]*value=""/);
  const form={id:'edit-form',values:{day:'2026-10-31',weight:'161.5',note:'new note'},dataset:{version:'0'},querySelector:s=>s.includes('button')?{disabled:false}:{textContent:''}};
  await a.events.get('submit')({target:form,preventDefault(){}});
  assert.equal(a.run(`recordFor('${yesterday}').weight`),162.4);
  assert.equal(a.run("recordFor('2026-10-31').weight"),161.5);
  assert.equal(a.run("recordFor('2026-10-31').note"),'new note');
  assert.equal(dialog.open,false);
  assert.doesNotMatch(a.run('overview()'),/today-form|record-card/);
});
test('viewer opens the complete escaped note with no write controls; card preview is single-line', () => {
  const a=app();
  a.context.longNote='<script>test</script>\n'+'很长的备注'.repeat(60);
  a.run("state.user.role='viewer'; state.records.at(-1).note=longNote; openLatestWeight();");
  const dialog=a.nodes.get('#record-dialog').innerHTML;
  assert.match(dialog,/full-note/);
  assert.match(dialog,/&lt;script&gt;test&lt;\/script&gt;/);
  assert.doesNotMatch(dialog,/<script>|<input|edit-form|删除记录/);
  assert.equal(a.run('state.records.at(-1).note'),a.context.longNote);
  const card=a.run('latestWeightCard(state.records.at(-1))');
  assert.match(card,/class="latest-note /);
  assert.match(card,/data-action="latest-weight"/);
  assert.doesNotMatch(card,/<script>/);
});
test('latest editor refreshes the server date first and stays closed when sync fails', async () => {
  const a=app();
  a.run("demo=false; api=async()=>({...state,today:'2026-10-31'});");
  await a.run('openLatestWeight()');
  const dialog=a.nodes.get('#record-dialog');
  assert.match(dialog.innerHTML,/name="day"[^>]*value="2026-10-31"/);
  dialog.close();
  a.run("api=async()=>{throw new Error('offline')};");
  await a.run('openLatestWeight()');
  assert.equal(dialog.open,false);
});

test('unread badges appear on both navigations, cap at 99+, hide zero and label full counts', () => {
  const a = app();
  const badge = {}, button = { setAttribute(name, value) { this[name] = value; } };
  a.context.document.querySelectorAll = selector => selector === '[data-unread-badge]' ? [badge] : [button];
  for (const nav of ['nav()', "nav('bottom-nav')"]) assert.match(a.run(nav), /data-unread-badge[^>]*>2<\/span>/);
  a.run('state.chat.unread_count=123; updateUnreadBadge()');
  assert.equal(badge.textContent, '99+'); assert.equal(badge.hidden, false);
  assert.equal(button['aria-label'], '留言，123 条未读');
  assert.equal(a.context.document.title, '(123) we.app · 体重记录');
  a.run('state.chat.unread_count=0; updateUnreadBadge()');
  assert.equal(badge.hidden, true);
  assert.equal(a.context.document.title, 'we.app · 体重记录');
});
test('only own messages show receipts, including older loaded messages', () => {
  const a = app();
  assert.equal((a.run('chatHistory()').match(/read-receipt/g)||[]).length, 1);
  assert.match(a.run('chatHistory()'), /read-receipt ">未读/);
  a.run('state.chat.partner_last_read_id=2');
  assert.match(a.run('chatHistory()'), /read-receipt is-read">已读/);
});
test('home, hidden chat, a dialog and scrolled history do not acknowledge unread messages', async () => {
  const a = app();
  a.log.scrollTop = 500;
  for (const prepare of ["screen='overview'", "screen='messages'; document.hidden=true", "document.hidden=false; $('#record-dialog').open=true", "$('#record-dialog').open=false; $('#message-list').scrollTop=100"]) {
    a.run(prepare);
    await a.run('markMessagesRead()');
    assert.equal(a.run('state.chat.unread_count'), 2);
    assert.equal(a.run('state.chat.last_read_id'), 0);
  }
});
test('viewing the latest chat acknowledges once, preserves draft and uses displayed cursor', async () => {
  const a = app();
  a.log.scrollTop = 500;
  a.text.value = 'keep unsent';
  a.run("screen='messages'; demo=false; calls=[]; api=async (...args)=>{calls.push(args);return {chat:{...state.chat,last_read_id:3,unread_count:0}}};");
  await a.run('markMessagesRead()');
  await a.run('markMessagesRead()');
  assert.equal(a.run('calls.length'), 1);
  assert.equal(a.run('calls[0][0]'), '/api/comments/read');
  assert.equal(a.run('calls[0][2].last_read_id'), 3);
  assert.equal(a.run('state.chat.unread_count'), 0);
  assert.equal(a.text.value, 'keep unsent');
});
test('failed acknowledgements retain unread count and are retryable', async () => {
  const a = app();
  a.log.scrollTop = 500;
  a.run("screen='messages'; demo=false; api=async()=>{throw Error('offline')}");
  await a.run('markMessagesRead()');
  assert.equal(a.run('state.chat.unread_count'), 2);
  assert.equal(a.run('markingRead'), false);
  a.run("api=async()=>({chat:{...state.chat,last_read_id:3,unread_count:0}})");
  await a.run('markMessagesRead()');
  assert.equal(a.run('state.chat.unread_count'), 0);
});
test('polling updates badges on home without replacing the page or marking read', async () => {
  const a = app();
  const badge = {};
  a.context.document.querySelectorAll = selector => selector === '[data-unread-badge]' ? [badge] : [];
  a.root.innerHTML = 'keep home';
  a.run("demo=false; calls=[]; api=async (...args)=>{calls.push(args);return {...state,chat:{...state.chat,unread_count:4}}};");
  await a.run('refresh()');
  assert.equal(a.root.innerHTML, 'keep home');
  assert.equal(badge.textContent, '4');
  assert.equal(a.run('calls.length'), 1);
  assert.equal(a.run('state.chat.last_read_id'), 0);
});
test('partner read receipts refresh on chat without new messages or losing input', async () => {
  const a = app();
  a.text.value = 'still typing';
  a.run("screen='messages';demo=false;api=async()=>({...state,chat:{...state.chat,partner_last_read_id:2}})");
  await a.run('refresh(true)');
  assert.match(a.log.innerHTML, /read-receipt is-read">已读/);
  assert.equal(a.text.value, 'still typing');
});
test('entering chat and scrolling to the latest message clears the demo badge', async () => {
  const a = app();
  a.context.document.querySelector = selector => selector === '#message-list' && !a.root.innerHTML.includes('id="message-list"') ? null : (a.nodes.get(selector) || null);
  await a.events.get('click')({target:{closest:()=>({dataset:{screen:'messages'}})}});
  assert.equal(a.run('state.chat.unread_count'), 0);
  assert.equal(a.run('state.chat.last_read_id'), 3);
});
test('overlapping read acknowledgements use a single request', async () => {
  const a = app();
  a.log.scrollTop = 500;
  a.run("screen='messages';demo=false;calls=0;api=()=>{calls++;return new Promise(resolve=>{finishRead=resolve})}");
  const pending = a.run('markMessagesRead()');
  await a.run('markMessagesRead()');
  assert.equal(a.run('calls'), 1);
  a.run('finishRead({chat:{...state.chat,last_read_id:3,unread_count:0}})');
  await pending;
  assert.equal(a.run('markingRead'), false);
  assert.equal(a.run('state.chat.unread_count'), 0);
});

function phoneChat(a) {
  const viewport = {height: 844, offsetTop: 0, scale: 1};
  Object.assign(a.context.window, {innerWidth: 390, innerHeight: 844, visualViewport: viewport});
  Object.assign(a.context.document.documentElement, {clientWidth: 390, clientHeight: 844});
  a.run("screen='messages'; syncChatViewport()");
  return viewport;
}
test('chat locks the document and tracks the visual viewport when the keyboard opens and closes', () => {
  const a = app(), viewport = phoneChat(a);
  assert.equal(a.classes.has('chat-open'), true);
  assert.equal(a.styles.get('--chat-height'), '844px');
  a.context.document.activeElement = a.text;
  viewport.height = 460; viewport.offsetTop = 44;
  a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), true);
  assert.equal(a.styles.get('--chat-height'), '460px');
  assert.equal(a.styles.get('--chat-top'), '44px');
  // iOS can dismiss the keyboard while leaving the textarea focused.
  viewport.height = 844; viewport.offsetTop = 0;
  a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
  assert.equal(a.styles.get('--chat-height'), '844px');
});
test('hiding the keyboard while a send button takes focus keeps the tab hidden until it closes', () => {
  const a = app(), viewport = phoneChat(a);
  a.context.document.activeElement = a.text;
  viewport.height = 460; a.run('syncChatViewport()');
  a.context.document.activeElement = {tagName:'BUTTON'};
  a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), true);
  viewport.height = 844; a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
});
test('viewport resizing follows the latest message and preserves scroll when reading older history', () => {
  const a = app(), viewport = phoneChat(a);
  a.log.scrollTop = 500;
  a.context.document.activeElement = a.text;
  viewport.height = 460;
  a.run('syncChatViewport()');
  assert.equal(a.log.scrollTop, a.log.scrollHeight);
  a.log.scrollTop = 100;
  viewport.height = 420; viewport.offsetTop = 20;
  a.run('syncChatViewport()');
  assert.equal(a.log.scrollTop, 100);
});
test('browser controls and pinch zoom do not count as an on-screen keyboard', () => {
  const a = app(), viewport = phoneChat(a);
  a.context.document.activeElement = a.text;
  viewport.height = 790; a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
  viewport.scale = 2; viewport.height = 390; a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
  assert.equal(a.styles.get('--chat-height'), '790px');
});
test('leaving chat and logout restore normal page scrolling and clear keyboard geometry', () => {
  const a = app(), viewport = phoneChat(a);
  a.context.document.activeElement = a.text;
  viewport.height = 460; a.run('syncChatViewport()');
  a.run("screen='overview'; render()");
  assert.equal(a.classes.has('chat-open'), false);
  assert.equal(a.classes.has('chat-keyboard-open'), false);
  assert.equal(a.styles.size, 0);
  a.run("screen='messages'; render(); renderAuth(false)");
  assert.equal(a.classes.has('chat-open'), false);
  assert.equal(a.styles.size, 0);
});
test('older browsers without VisualViewport hide mobile tabs on focus and restore on blur', () => {
  const a = app();
  a.context.window.innerWidth = 390;
  a.run("screen='messages'; syncChatViewport()");
  a.context.document.activeElement = a.text;
  a.events.get('focusin')();
  assert.equal(a.classes.has('chat-keyboard-open'), true);
  a.context.document.activeElement = {tagName:'BODY'};
  a.run('syncChatViewport()');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
});
test('desktop focus retains navigation and portrait-to-landscape updates the available height', () => {
  const a = app();
  a.context.document.activeElement = a.text;
  a.run("screen='messages'; syncChatViewport()");
  assert.equal(a.classes.has('chat-keyboard-open'), false);
  const viewport = phoneChat(a);
  viewport.height = 390;
  Object.assign(a.context.window, {innerWidth:844, innerHeight:390});
  Object.assign(a.context.document.documentElement, {clientWidth:844,clientHeight:390});
  a.events.get('window:resize')();
  assert.equal(a.styles.get('--chat-height'), '390px');
  assert.equal(a.classes.has('chat-keyboard-open'), false);
});
