// 换景调度回归：①同组重叠操作按 demand 累计并避让锁定区间/win_start；
// ②出入口工具在空白处点击能创建 gate（不再抛
// TypeError: Cannot read properties of undefined (reading 'toFixed')）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ---------------------------------------------------------------- 最小环境
function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      return (typeof t[k] !== 'undefined') ? t[k] : () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const ctxProxy = makeCtx();
function makeEl() {
  const el = {
    tagName: 'DIV', value: '', textContent: '', innerHTML: '',
    dataset: {}, style: {}, disabled: false, checked: false, title: '',
    children: [], _ev: {}, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(ev, fn) { (el._ev[ev] ||= []).push(fn); },
    removeEventListener() {}, appendChild(c) { el.children.push(c); return c; },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    setPointerCapture() {}, getContext() { return ctxProxy; }, focus() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
  return el;
}
const els = {};
const documentStub = {
  querySelector: (s) => els[s] || (els[s] = makeEl()),
  querySelectorAll: () => [],
  createElement: () => makeEl(),
  addEventListener() {}, activeElement: { tagName: 'BODY' }, dispatchEvent() {},
};
const sandbox = {
  document: documentStub,
  window: { addEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1 },
  console, Math, JSON, Date, Set, Map, Array, Object, Proxy, isNaN, parseInt, parseFloat,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  uid: (p) => p + Math.random().toString(36).slice(2, 9),
  appMode: 'changeover',
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, '..', '..', 'stageplanner', 'static', 'changeover.js'), 'utf8');
vm.runInContext(code, sandbox);
const CE = sandbox.window.CO.CE;
const CO = sandbox.window.CO.CO;

// ---------------------------------------------------------------- 场景夹具
function fixture() {
  return {
    stage: { id: 's1', name: '台', width: 12, height: 8 },
    regions: [], actors: [],
    scenes: [{ id: 'sc1', name: '一幕', position: 0 }, { id: 'sc2', name: '二幕', position: 1 }],
    beats: [], placements: [], paths: [],
    crews: [{ id: 'c1', name: '搬运组', members: 3, win_start: 0, win_end: 600, color: '#3f8fdd', position: 0 }],
    gates: [{ id: 'g1', name: '左台口', x: 0, y: 4, position: 0 }],
    props: [
      { id: 'p1', name: '重台', w: 2, h: 1, weight: 120, min_crew: 3, speed: 1.0, storage: 'SL', gates: ['g1'], color: '#c98a3a', position: 0 },
      { id: 'p2', name: '小凳', w: 0.6, h: 0.6, weight: 5, min_crew: 1, speed: 1.0, storage: 'SL', gates: ['g1'], color: '#9b6dd3', position: 1 },
    ],
    set_positions: [
      { id: 'q1', prop_id: 'p1', scene_id: 'sc1', kind: 'close', x: 4, y: 4 },
      { id: 'q2', prop_id: 'p1', scene_id: 'sc2', kind: 'open', x: null, y: null },
      { id: 'q3', prop_id: 'p2', scene_id: 'sc1', kind: 'close', x: 8, y: 2 },
      { id: 'q4', prop_id: 'p2', scene_id: 'sc2', kind: 'open', x: null, y: null },
    ],
    shifts: [{ id: 'sh1', from_scene_id: 'sc1', to_scene_id: 'sc2', name: '换景', deadline: 120, position: 0 }],
    shift_ops: [
      { id: 'o1', shift_id: 'sh1', prop_id: 'p1', kind: 'strike', crew_id: 'c1', handover_crew: null, demands: null, locked_start: null, order_hint: 0, route: [], position: 0 },
      { id: 'o2', shift_id: 'sh1', prop_id: 'p2', kind: 'strike', crew_id: 'c1', handover_crew: null, demands: null, locked_start: null, order_hint: 1, route: [], position: 1 },
    ],
    shift_deps: [],
  };
}
const opOf = (sh, name) => sh.ops.find((o) => o.prop_name === name);
const problemsOfType = (sh, type) => sh.problems.filter((p) => p.type === type);

// ------------------------------------------------- ① demand 累计 + 可执行时间线
let doc = fixture();
let res = CE.analyze(doc);
let sh = res.shifts[0];
let table = opOf(sh, '重台'), stool = opOf(sh, '小凳');
assert.strictEqual(table.demand, 3, '重台需 3 人');
assert.strictEqual(stool.demand, 1, '小凳需 1 人');
assert.ok(Math.abs(table.start - 0) < 1e-6 && Math.abs(table.finish - 5.5) < 0.05,
  `重台应排在 0–5.5s，实际 ${table.start}–${table.finish}`);
assert.ok(stool.start >= table.finish - 0.02,
  `小凳不得与重台同时排在 0.0–10.0s：小凳开始 ${stool.start}，重台结束 ${table.finish}`);
assert.strictEqual(problemsOfType(sh, 'overlap').length, 0, '不应再有同组重叠');
assert.strictEqual(problemsOfType(sh, 'manpower').length, 0, '不应有人手不足');
assert.ok(stool.finish > table.finish, '小凳应在重台之后完成，时间线串行可执行');

// demand 不超容量时允许并行（2+1=3 不报警）
doc = fixture();
doc.props[0].min_crew = 2;   // 重台降为 2 人
res = CE.analyze(doc); sh = res.shifts[0];
table = opOf(sh, '重台'); stool = opOf(sh, '小凳');
assert.ok(Math.abs(stool.start) < 1e-6, '2+1=3 不超容量时小凳可与重台并行');
assert.strictEqual(problemsOfType(sh, 'overlap').length, 0, '容量内并行不算重叠');

// win_start 下限 + 未来锁定区间避让
doc = fixture();
doc.crews[0].win_start = 10;
doc.shift_ops[0].locked_start = 20;   // 重台锁定 20–25.5
res = CE.analyze(doc); sh = res.shifts[0];
table = opOf(sh, '重台'); stool = opOf(sh, '小凳');
assert.strictEqual(table.start, 20, '重台按锁定 20s 开始');
assert.ok(stool.start >= 10 - 1e-9, `小凳不早于可用时段起点 10s，实际 ${stool.start}`);
assert.ok(stool.finish <= 20 + 0.02, `小凳应在锁定重台开始前结束，实际 ${stool.start}–${stool.finish}`);
assert.strictEqual(problemsOfType(sh, 'overlap').length, 0, '避让锁定区间后无重叠');
assert.strictEqual(problemsOfType(sh, 'window').length, 0, '均在可用时段内');

// ------------------------------------------------- ② 出入口工具空白点击
doc = fixture();
doc.gates = [];
sandbox.doc = doc;
CO.tool = 'gate';
CO.phase = 'close';
CO.view = { scale: 40, ox: 80, oy: 60 };
CO.currentShiftId = doc.shifts[0].id;
CO.sel = null;
const canvas = documentStub.querySelector('#coCanvas');
const fire = (ev, fn) => canvas._ev[ev].forEach((f) => f(fn));
// 点击 (200,200) -> 舞台坐标 (3, 3.5)，最近台边为左边 (0, 3.5)
fire('pointerdown', { pointerId: 1, clientX: 200, clientY: 200 });
assert.strictEqual(doc.gates.length, 1, '空白点击应创建一个出入口');
const g0 = doc.gates[0];
assert.ok(Math.abs(g0.x - 0) < 1e-9 && Math.abs(g0.y - 3.5) < 1e-9,
  `新出入口应吸附左边 (0,3.5)，实际 (${g0.x},${g0.y})`);
assert.strictEqual(typeof g0.x, 'number');
assert.strictEqual(typeof g0.y, 'number');

// 拖动该出入口到 (400,100) -> 舞台 (8,1)，最近台边为上边 (8,0)，不应再抛 toFixed 错
fire('pointermove', { pointerId: 1, clientX: 400, clientY: 100 });
assert.ok(Math.abs(g0.x - 8) < 1e-9 && Math.abs(g0.y - 0) < 1e-9,
  `拖动后应吸附上边 (8,0)，实际 (${g0.x},${g0.y})`);
fire('pointerup', {});

console.log('PASS changeover_crew_gate.js');
