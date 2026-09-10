// rehearsal.js 的最小浏览器环境（Node vm）。
// 仅供 tests/js 下的无界面回归测试使用：Canvas/DOM 均为桩，逻辑函数通过 __T 暴露。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createPattern') return {};
      return (typeof t[k] !== 'undefined') ? t[k] : () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeEl() {
  const el = {
    tagName: 'DIV', value: '', textContent: '', innerHTML: '',
    dataset: {}, style: {}, disabled: false, checked: false, title: '',
    _classes: new Set(),
    get className() { return [...this._classes].join(' '); },
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); },
      toggle(c, f) { if (f === undefined) f = !el._classes.has(c); f ? el._classes.add(c) : el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
    },
    children: [],
    parentElement: { getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }, clientWidth: 800, clientHeight: 600 },
    clientWidth: 800, clientHeight: 600,
    _ev: {},
    addEventListener(ev, fn) { (this._ev[ev] ||= []).push(fn); },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    getContext() { return makeCtx(); },
    setPointerCapture() {}, focus() {},
  };
  return el;
}

const els = {};
function $(sel) { return els[sel] ||= makeEl(); }

const sandbox = {};
sandbox.window = {
  addEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1,
  location: { href: '' }, loadStageList: null, requestAnimationFrame: () => 0,
  get setTimeout() { return sandbox.__timers.setTimeout; },
  get clearTimeout() { return sandbox.__timers.clearTimeout; },
};
sandbox.document = {
  querySelector: $,
  querySelectorAll: (q) => els[q]?.children || [],
  createElement: () => makeEl(),
  activeElement: makeEl(),
};
sandbox.requestAnimationFrame = () => 0;
sandbox.cancelAnimationFrame = () => {};
sandbox.setInterval = () => 0;
sandbox.clearInterval = () => {};
sandbox.__timers = { setTimeout: () => 0, clearTimeout: () => {} };
sandbox.setTimeout = (...a) => sandbox.__timers.setTimeout(...a);
sandbox.clearTimeout = (...a) => sandbox.__timers.clearTimeout(...a);
sandbox.navigator = {};
sandbox.performance = { now: () => Date.now() };
sandbox.console = console;
sandbox.Date = Date; sandbox.Math = Math; sandbox.JSON = JSON;
sandbox.Object = Object; sandbox.Array = Array; sandbox.Set = Set; sandbox.Map = Map;
sandbox.Proxy = Proxy; sandbox.Promise = Promise; sandbox.Error = Error;
sandbox.isNaN = isNaN; sandbox.parseInt = parseInt; sandbox.parseFloat = parseFloat;
sandbox.alert = (m) => { throw new Error('ALERT: ' + m); };
sandbox.confirm = () => true;
sandbox.prompt = () => null;
sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// ---- app.js 提供的全局 ----
sandbox.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
sandbox.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
sandbox.polyLen = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += sandbox.dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return s;
};
sandbox.uid = (p) => p + Math.random().toString(36).slice(2, 8);
sandbox.escapeHtml = (s) => String(s ?? '');
sandbox.doc = null;
sandbox.appMode = 'plan';
sandbox.resizeCanvas = () => {};

const codePath = path.join(__dirname, '..', '..', 'stageplanner', 'static', 'rehearsal.js');
const CODE = fs.readFileSync(codePath, 'utf8');
vm.createContext(sandbox);
vm.runInContext(CODE + `
;globalThis.__T = {
  R: () => R, setR: (r) => { R = r; },
  recordCurrentBeat, tapActor, actorMark, saveRehearsal,
  V: () => V, setV: (v) => { V = v; }, rvTimeRange,
  fixtureSnap: null,
};`, sandbox);

function fixture() {
  const snap = {
    stage: { id: 'st1', name: '台', width: 12, height: 8 },
    regions: [],
    actors: [
      { id: 'a1', name: '甲', speed: 1.2, color: '#e8734a' },
      { id: 'a2', name: '乙', speed: 1.1, color: '#3f8fdd' },
    ],
    scenes: [{ id: 'sc1', name: '第一幕', position: 0 }],
    beats: [
      { id: 'b1', scene_id: 'sc1', name: '节点1', position: 1, time: 0 },
      { id: 'b2', scene_id: 'sc1', name: '节点2', position: 2, time: 5 },
    ],
    placements: [
      { id: 'p1', beat_id: 'b1', actor_id: 'a1', x: 1, y: 4, facing: 0 },
      { id: 'p2', beat_id: 'b1', actor_id: 'a2', x: 2, y: 4, facing: 0 },
      { id: 'p3', beat_id: 'b2', actor_id: 'a1', x: 10, y: 4, facing: 90 },
      { id: 'p4', beat_id: 'b2', actor_id: 'a2', x: 3, y: 4, facing: 90 },
    ],
    paths: [],
  };
  return {
    id: 'r1', stage_id: 'st1', scene_id: 'sc1', scene_name: '第一幕',
    name: '首排', snapshot: snap, notes: '', status: 'running',
    origin: 0, clock_elapsed: 0, clock_running: true,
    clock_at: new Date().toISOString(), beat_marks: [], actor_marks: [],
  };
}

// 复盘模式所需的最小 V（rvTimeRange 等只依赖 review 数据）
function reviewV(beats) {
  return {
    a: {
      rec: { id: 'r1', snapshot: fixture().snapshot },
      review: { beats },
      view: null,
    },
    b: null, curBeatId: beats[0] ? beats[0].beat_id : null,
    play: { active: false, playing: false, t: 0, raf: null, last: null },
  };
}

module.exports = {
  sandbox,
  T: sandbox.__T,
  fixture,
  reviewV,
  setTimers: (t) => {
    sandbox.__timers.setTimeout = t.setTimeout || sandbox.__timers.setTimeout;
    sandbox.__timers.clearTimeout = t.clearTimeout || sandbox.__timers.clearTimeout;
  },
};
