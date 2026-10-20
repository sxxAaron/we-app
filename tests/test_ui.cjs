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
  const text = { value: '', tagName: 'TEXTAREA', closest: s => s === '#comment-form' };
  const status = { textContent: '', classList: { toggle() {}, add() {}, remove() {} } };
  const nodes = new Map([['#app', root], ['#message-list', log], ['#comment-text', text], ['#chat-count', {}], ['#sync-status', status], ['#record-dialog', { open: false, close() {} }], ['#toast', status]]);
  const events = new Map();
  const context = vm.createContext({
    URLSearchParams, console, Map, JSON, Date, setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    document: { querySelector: s => nodes.get(s) || null, addEventListener: (name, callback) => events.set(name, callback), activeElement: { tagName: 'BODY' }, hidden: false },
    location: { search: '' }, window: { scrollTo() {} },
    FormData: class { constructor(form) { return new Map(Object.entries(form.values)); } },
    fetch: async () => { throw Error('Unexpected real network request'); }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run("state = demoState(); state.plan = extendedPlan(state.plan, state.today); resetDraft(); demo = true;");
  return { run, context, events, nodes, root, log, text };
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
  a.run("state.records[state.records.length - 1].weight = 166.6; state.plan.goal_weight = 150; resetDraft();");
  assert.match(a.run('overview()'), /166\.6/);
  assert.match(a.run('todayCard(recordFor(state.today))'), /value="166.6"/);
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
  assert.doesNotMatch(a.run('todayCard(recordFor(state.today))'), /today-form/);
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
  assert.equal((a.run('recordsPage()').match(/class="day-cell /g)||[]).length, 200);
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
