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
  run("state = demoState(); resetDraft(); demo = true;");
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
  await a.events.get('submit')({ target: form('plan-form',{start_date:'2026-10-18'}), preventDefault() {} });
  assert.equal(a.run('captured[2].goal_weight'), 150);
  assert.equal(a.run('captured[2].start_date'), '2026-10-18');
});
test('viewer can chat, sees four setting cards and has no weight or plan write forms', () => {
  const a = app();
  a.run("state.user.role='viewer'; state.user.id=2;");
  assert.doesNotMatch(a.run('todayCard(recordFor(state.today))'), /today-form/);
  assert.match(a.run('messages()'), /comment-form/);
  const settings = a.run('settingsPage()');
  assert.equal((settings.match(/<section class="setting-card/g)||[]).length, 4);
  assert.doesNotMatch(settings, /保存计划|保存目标|data-action="backup"/);
  assert.match(settings, /name="goal_weight"[^>]*disabled/);
});
