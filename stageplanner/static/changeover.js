/* ============================================================
 * 换景调度模块（changeover.js）
 * 依赖 app.js 的全局：doc, uid, saveDoc, api
 * 引擎逻辑与 stageplanner/changeover.py 保持一致（前端实时排程/检测）。
 * ============================================================ */
(function () {
'use strict';

const CO = {};                         // 模块内部状态
const $c = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PROP_COLORS = ['#c98a3a', '#9b6dd3', '#3f9d8b', '#d05b93', '#5e8fd6', '#c45a4a', '#7a9e42'];
const CREW_COLORS = ['#3f8fdd', '#46a063', '#9b6dd3', '#d4a23a', '#d05b93', '#2fafb0'];
const KIND_LABEL = { strike: '撤场', move: '搬运', preset: '预置', handover: '交接' };
const KIND_COLOR = { strike: '#e07b39', move: '#8a5cc4', preset: '#3f9d6b', handover: '#5e8fd6' };
const TIMESTEP = 0.5, PROP_GAP = 0.15, HANDOVER_PAUSE = 5.0, STORAGE_INSET = 1.5, TOL = 0.02;

// ================================================================ 引擎（移植自 changeover.py）
const CE = {};

CE.index = function (doc) {
  const stage = doc.stage;
  return {
    W: +stage.width, H: +stage.height,
    obstacles: (doc.regions || []).filter((r) => r.kind === 'obstacle'),
    crews: Object.fromEntries((doc.crews || []).map((c) => [c.id, c])),
    props: Object.fromEntries((doc.props || []).map((p) => [p.id, p])),
    gates: Object.fromEntries((doc.gates || []).map((g) => [g.id, g])),
    scenes: Object.fromEntries((doc.scenes || []).map((s) => [s.id, s])),
    pos: Object.fromEntries((doc.set_positions || []).map((q) => [`${q.prop_id}|${q.scene_id}|${q.kind}`, q])),
  };
};
CE.storagePoint = function (idx, prop) {
  const side = prop.storage || 'SL';
  const y = idx.H / 2;
  return side === 'SR' ? [idx.W + STORAGE_INSET, y] : [-STORAGE_INSET, y];
};
CE.gatePoint = function (idx, prop, preferTo) {
  const gates = (prop.gates || []).map((g) => idx.gates[g]).filter(Boolean);
  if (!gates.length) return { gate: null, pt: null };
  const target = preferTo || CE.storagePoint(idx, prop);
  const g = gates.reduce((a, b) =>
    (Math.hypot(a.x - target[0], a.y - target[1]) <= Math.hypot(b.x - target[0], b.y - target[1]) ? a : b));
  return { gate: g, pt: [g.x, g.y] };
};
CE.positionPoint = function (idx, pid, sid, kind) {
  const q = idx.pos[`${pid}|${sid}|${kind}`];
  if (!q || q.x === null || q.x === undefined || q.y === null || q.y === undefined) return null;
  return [+q.x, +q.y];
};
CE.propRect = function (idx, pid, pt) {
  const p = idx.props[pid];
  const hw = (+p.w) / 2, hh = (+p.h) / 2;
  return [pt[0] - hw, pt[1] - hh, pt[0] + hw, pt[1] + hh, pt[0] + hw, pt[1] + hh];
};
CE.rectOverlap = function (r1, r2, gap) {
  gap = gap === undefined ? PROP_GAP : gap;
  return !(r1[2] + gap <= r2[0] || r2[2] + gap <= r1[0] ||
           r1[3] + gap <= r2[1] || r2[3] + gap <= r1[1]);
};
CE.onStage = function (idx, pt) {
  return pt && pt[0] >= -1e-9 && pt[0] <= idx.W + 1e-9 && pt[1] >= -1e-9 && pt[1] <= idx.H + 1e-9;
};
CE.polyLen = function (pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
};
CE.segIntersectsPolygon = function (a, b, poly) {
  // 与 geometry.py 等价：规范相交或跨边重合（顶点停靠合法）
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const segInt = (p1, p2, p3, p4) => {
    const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const on = (p, a, q) => Math.min(p[0], q[0]) - 1e-9 <= a[0] && a[0] <= Math.max(p[0], q[0]) + 1e-9 &&
                          Math.min(p[1], q[1]) - 1e-9 <= a[1] && a[1] <= Math.max(p[1], q[1]) + 1e-9;
  const polyPts = new Set(poly.map((p) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`));
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (segInt(a, b, c, d)) return true;
    if (cross(a, b, c) === 0 && cross(a, b, d) === 0) {
      // 共线：两端都是多边形顶点才合法
      const ea = polyPts.has(`${Math.round(a[0] * 1e6)},${Math.round(a[1] * 1e6)}`);
      const eb = polyPts.has(`${Math.round(b[0] * 1e6)},${Math.round(b[1] * 1e6)}`);
      if (!(ea && eb) && ((on(a, b, c) && on(a, b, d)) || (on(c, d, a) && on(c, d, b)))) return true;
    }
  }
  return false;
};

CE.endpoints = function (idx, shift, op) {
  const prop = idx.props[op.prop_id];
  const missing = [];
  if (!prop) return { start: null, end: null, pts: [], gate: null, missing: [['物件已删除', '']] };
  const anchors = (op.route || []).map((a) => [+a[0], +a[1]]);
  const store = CE.storagePoint(idx, prop);
  let start = null, end = null, gate = null, pts = [];
  const sname = (sid) => (idx.scenes[sid] || {}).name || '（已删场景）';
  if (op.kind === 'strike') {
    start = CE.positionPoint(idx, prop.id, shift.from_scene_id, 'close');
    if (!start) missing.push(['收场位', sname(shift.from_scene_id)]);
    const g = CE.gatePoint(idx, prop, start);
    gate = g.gate;
    if (!g.pt) {
      missing.push(['允许出入口', '']);
      pts = [...(start ? [start] : []), ...anchors, store];
    } else {
      end = store;
      pts = [...(start ? [start] : []), ...anchors, g.pt, store];
    }
    end = store;
  } else if (op.kind === 'preset') {
    end = CE.positionPoint(idx, prop.id, shift.to_scene_id, 'open');
    if (!end) missing.push(['开场位', sname(shift.to_scene_id)]);
    const g = CE.gatePoint(idx, prop, end);
    gate = g.gate;
    if (!g.pt) {
      missing.push(['允许出入口', '']);
      start = store; pts = [store, ...anchors, ...(end ? [end] : [])];
    } else {
      start = store; pts = [store, g.pt, ...anchors, ...(end ? [end] : [])];
    }
  } else {
    start = CE.positionPoint(idx, prop.id, shift.from_scene_id, 'close');
    end = CE.positionPoint(idx, prop.id, shift.to_scene_id, 'open');
    if (!start) missing.push(['收场位', sname(shift.from_scene_id)]);
    if (!end) missing.push(['开场位', sname(shift.to_scene_id)]);
    pts = [...(start ? [start] : []), ...anchors, ...(end ? [end] : [])];
  }
  return { start, end, pts, gate, missing };
};
CE.duration = function (idx, op, eps) {
  const prop = idx.props[op.prop_id];
  if (!prop || eps.pts.length < 2) return 0;
  let d = CE.polyLen(eps.pts) / Math.max(0.01, +prop.speed);
  if (op.kind === 'handover') d += HANDOVER_PAUSE;
  return d;
};
CE.demand = function (idx, op) {
  if (op.demands) return Math.max(1, +op.demands);
  const p = idx.props[op.prop_id];
  return p ? Math.max(1, +p.min_crew) : 1;
};
CE.positionAt = function (eps, frac) {
  const pts = eps.pts;
  if (!pts.length) return null;
  if (pts.length < 2) return pts[pts.length - 1];
  const f = Math.max(0, Math.min(1, frac));
  const total = CE.polyLen(pts);
  if (total < 1e-9) return pts[pts.length - 1];
  let target = total * f, acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (acc + seg >= target) {
      const r = seg === 0 ? 0 : (target - acc) / seg;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
              pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
};

CE.initialOccupancy = function (idx, shift) {
  const occ = {};
  for (const [pid] of Object.entries(idx.props)) {
    const pt = CE.positionPoint(idx, pid, shift.from_scene_id, 'close');
    if (pt) occ[pid] = pt;
  }
  return occ;
};
CE.propChainEdges = function (ops) {
  const edges = new Set();
  const byProp = {};
  for (const op of ops) (byProp[op.prop_id] = byProp[op.prop_id] || []).push(op);
  for (const group of Object.values(byProp)) {
    group.sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0) ||
                         (a.position || 0) - (b.position || 0) || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < group.length - 1; i++) edges.add(`${group[i + 1].id}>${group[i].id}`);
  }
  return edges;
};
CE.vacancyEdges = function (idx, shift, ops, epsCache) {
  const edges = new Set();
  const initial = CE.initialOccupancy(idx, shift);
  const lastOp = {};
  for (const op of ops) {
    const prev = lastOp[op.prop_id];
    if (!prev || (op.order_hint || 0) >= (prev.order_hint || 0)) lastOp[op.prop_id] = op;
  }
  for (const op of ops) {
    const eps = epsCache[op.id];
    if (!eps.end || !CE.onStage(idx, eps.end)) continue;
    const rend = CE.propRect(idx, op.prop_id, eps.end);
    for (const [pid, pt] of Object.entries(initial)) {
      if (pid === op.prop_id) continue;
      if (!CE.rectOverlap(rend, CE.propRect(idx, pid, pt))) continue;
      const remover = lastOp[pid];
      if (remover && remover.id !== op.id) edges.add(`${op.id}>${remover.id}`);
    }
  }
  return edges;
};
CE.toposort = function (ops, edges) {
  const ids = ops.map((o) => o.id);
  const rank = {};
  [...ops].sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0) ||
                          (a.position || 0) - (b.position || 0) || (a.id < b.id ? -1 : 1))
    .forEach((o, k) => { rank[o.id] = k; });
  const preds = Object.fromEntries(ids.map((i) => [i, new Set()]));
  const succ = Object.fromEntries(ids.map((i) => [i, new Set()]));
  for (const e of edges) {
    const [a, b] = e.split('>');
    if (preds[a] && preds[b]) { preds[a].add(b); succ[b].add(a); }
  }
  let indeg = Object.fromEntries(ids.map((i) => [i, preds[i].size]));
  const ready = ids.filter((i) => indeg[i] === 0).sort((x, y) => rank[x] - rank[y]);
  const order = [];
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const m of [...succ[n]].sort((x, y) => rank[x] - rank[y])) {
      if (--indeg[m] === 0) ready.push(m);
    }
    ready.sort((x, y) => rank[x] - rank[y]);
  }
  const done = new Set(order);
  return { order, cycle: ids.filter((i) => !done.has(i)) };
};
CE.crewIntervals = function (idx, shiftId, rows) {
  const out = {};
  for (const cid of Object.keys(idx.crews)) out[cid] = [];
  for (const r of rows) {
    if (r.shift_id !== shiftId) continue;
    const op = r.op;
    if (op.kind !== 'handover' && out[r.crew_id]) out[r.crew_id].push([r.start, r.finish]);
    if (op.kind === 'handover') {
      const mid = r.start + r.move_time / 2;
      if (out[r.crew_id]) out[r.crew_id].push([r.start, mid]);
      if (out[op.handover_crew]) out[op.handover_crew].push([mid, r.finish]);
    }
  }
  return out;
};
CE.crewFreeAfter = function (intervals, cid, demand, earliest, members) {
  let t = earliest;
  const ivs = (intervals[cid] || []).slice().sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < 64; k++) {
    const used = ivs.filter(([a, b]) => a <= t + 1e-9 && t < b).length;
    if (members - used >= demand) return t;
    const ends = ivs.filter(([a, b]) => a <= t + 1e-9 && t < b).map(([, b]) => b);
    const nxt = ends.length ? Math.min(...ends) : null;
    if (nxt === null || nxt <= t + 1e-9) return t;
    t = nxt;
  }
  return t;
};

CE.scheduleShift = function (idx, shift, opsIn, depSet) {
  const ops = [...opsIn].sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0) ||
                                        (a.position || 0) - (b.position || 0) || (a.id < b.id ? -1 : 1));
  const eps = {}, durations = {}, demands = {};
  for (const op of ops) {
    eps[op.id] = CE.endpoints(idx, shift, op);
    durations[op.id] = CE.duration(idx, op, eps[op.id]);
    demands[op.id] = CE.demand(idx, op);
  }
  const edges = new Set(depSet);
  CE.propChainEdges(ops).forEach((e) => edges.add(e));
  CE.vacancyEdges(idx, shift, ops, eps).forEach((e) => edges.add(e));
  const { order, cycle } = CE.toposort(ops, edges);
  const cycleSet = new Set(cycle);
  const preds = Object.fromEntries(ops.map((o) => [o.id, new Set()]));
  for (const e of edges) {
    const [a, b] = e.split('>');
    if (preds[a]) preds[a].add(b);
  }
  const byId = Object.fromEntries(ops.map((o) => [o.id, o]));
  const schedules = {};
  const unscheduled = new Set(cycle);
  const makeRow = (op, s, locked) => {
    const f = s + durations[op.id];
    const e = eps[op.id];
    const row = {
      shift_id: shift.id, op_id: op.id, op, start: +s.toFixed(2), finish: +f.toFixed(2),
      duration: +durations[op.id].toFixed(2), demand: demands[op.id], locked,
      pts: e.pts, start_pt: e.start, end_pt: e.end, crew_id: op.crew_id,
      handover_crew: op.handover_crew, prop_id: op.prop_id, kind: op.kind,
      move_time: Math.max(1e-9, durations[op.id] - (op.kind === 'handover' ? HANDOVER_PAUSE : 0)),
    };
    if (op.kind === 'handover') {
      row.handover_time = +(s + row.move_time / 2).toFixed(2);
      row.handover_pt = CE.positionAt(e, 0.5);
    }
    return row;
  };
  // 锁定操作
  for (const op of ops.filter((o) => !cycleSet.has(o.id) && o.locked_start !== null && o.locked_start !== undefined && o.locked_start !== '')) {
    schedules[op.id] = makeRow(op, +op.locked_start, true);
  }
  let intervals = CE.crewIntervals(idx, shift.id, Object.values(schedules));
  for (const opId of order) {
    const op = byId[opId];
    if (schedules[opId]) continue;
    let earliest = 0;
    let blocked = false;
    for (const dep of preds[opId]) {
      const r = schedules[dep];
      if (r) earliest = Math.max(earliest, r.finish);
      else if (unscheduled.has(dep)) { blocked = true; break; }
    }
    const crew = idx.crews[op.crew_id];
    if (blocked) { unscheduled.add(opId); continue; }
    if (!crew) { schedules[opId] = makeRow(op, earliest, false); continue; }
    let s;
    if (op.kind === 'handover' && idx.crews[op.handover_crew]) {
      const hcrew = idx.crews[op.handover_crew];
      const half = durations[op.id] <= 0 ? 0 : Math.max(1e-9, durations[op.id] - HANDOVER_PAUSE) / 2;
      s = earliest;
      for (let k = 0; k < 48; k++) {
        const sa = CE.crewFreeAfter(intervals, op.crew_id, demands[opId], s, +crew.members);
        const wantB = sa + half + (durations[op.id] > 0 ? HANDOVER_PAUSE : 0);
        const sb = CE.crewFreeAfter(intervals, op.handover_crew, demands[opId], wantB, +hcrew.members);
        if (Math.abs(sb - wantB) < 1e-9) { s = sa; break; }
        const cand = sb - half - HANDOVER_PAUSE;
        if (cand < earliest) { s = sa; break; }
        s = cand;
      }
    } else {
      s = CE.crewFreeAfter(intervals, op.crew_id, demands[opId], earliest, +crew.members);
    }
    schedules[opId] = makeRow(op, s, false);
    intervals = CE.crewIntervals(idx, shift.id, Object.values(schedules));
  }
  return { schedules, unscheduled, cycle: cycleSet, eps, durations, demands };
};

CE.buildTimelines = function (idx, shift, rows) {
  const tl = {};
  for (const [pid, pt] of Object.entries(CE.initialOccupancy(idx, shift))) {
    (tl[pid] = tl[pid] || []).push([0, null, pt]);
  }
  for (const r of [...rows].sort((a, b) => a.start - b.start || (a.op_id < b.op_id ? -1 : 1))) {
    (tl[r.prop_id] = tl[r.prop_id] || []).push([r.start, r.finish, r]);
    if (r.end_pt && CE.onStage(idx, r.end_pt)) tl[r.prop_id].push([r.finish, null, r.end_pt]);
  }
  return tl;
};
CE.stateAt = function (tl, pid, t) {
  let still = null;
  for (const [t0, t1, payload] of (tl[pid] || [])) {
    if (t1 === null) { if (t >= t0 - 1e-9) still = payload; continue; }
    if (t0 - 1e-9 <= t && t <= t1 + 1e-9) {
      const frac = t1 - t0 < 1e-9 ? 0 : (t - t0) / (t1 - t0);
      return ['moving', payload, Math.max(0, Math.min(1, frac))];
    }
    if (t < t0) break;
  }
  return Array.isArray(still) ? ['still', still] : null;
};

CE.analyzeShift = function (idx, shift, allOps, depSet) {
  const ops = allOps.filter((o) => o.shift_id === shift.id);
  const { schedules, unscheduled, cycle, eps, durations, demands } =
    CE.scheduleShift(idx, shift, ops, depSet);
  const problems = [];
  const P = (type, severity, message, extra) =>
    problems.push(Object.assign({ type, severity, message, shift_id: shift.id,
      op_id: null, x: null, y: null }, extra || {}));
  const propName = (pid) => (idx.props[pid] || {}).name || '?';

  if (cycle.size) {
    P('cycle', 'error', '操作先后依赖存在环，无法排程（涉及：' +
      [...cycle].map((id) => propName(byId(id).prop_id)).join('、') + '）');
  }
  function byId(id) { return ops.find((o) => o.id === id); }

  for (const op of ops) {
    const e = eps[op.id];
    const prop = idx.props[op.prop_id];
    const label = `「${KIND_LABEL[op.kind] || op.kind}」` + (prop ? `（${prop.name}）` : '');
    if (!prop) { P('config', 'error', `操作${label}引用的物件已删除`, { op_id: op.id }); continue; }
    for (const [role, sn] of e.missing) {
      P('config', 'error', `${prop.name} 的${label}缺少${role}${sn ? '（场景 ' + sn + '）' : ''}`,
        { op_id: op.id, x: (e.end || e.start || [])[0] ?? null, y: (e.end || e.start || [])[1] ?? null, prop_id: prop.id });
    }
    if (!op.crew_id || !idx.crews[op.crew_id]) {
      P('manpower', 'error', `${prop.name} 的${label}未指派负责搬运组`,
        { op_id: op.id, x: e.start ? e.start[0] : null, y: e.start ? e.start[1] : null, prop_id: prop.id });
    }
    if (op.kind === 'handover' && (!op.handover_crew || !idx.crews[op.handover_crew])) {
      P('manpower', 'error', `${prop.name} 的交接操作${label}未指定接收组`,
        { op_id: op.id, x: e.end ? e.end[0] : null, y: e.end ? e.end[1] : null, prop_id: prop.id });
    }
    if ((op.kind === 'strike' || op.kind === 'preset') && !e.missing.length && !e.gate) {
      const sp = CE.storagePoint(idx, prop);
      P('gate', 'error', `${prop.name} 没有允许的出入口，${label}无法上下台`,
        { op_id: op.id, x: sp[0], y: sp[1], prop_id: prop.id });
    }
    if (!e.missing.length && !unscheduled.has(op.id)) {
      // 障碍穿越（仅台内段）
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        if (!CE.onStage(idx, a) || !CE.onStage(idx, b)) continue;
        const hit = idx.obstacles.find((ob) => CE.segIntersectsPolygon(a, b, ob.points));
        if (hit) {
          P('obstacle', 'error', `${prop.name} 的路线穿越固定障碍「${hit.name}」`,
            { op_id: op.id, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, prop_id: prop.id, obstacle_id: hit.id });
          break;
        }
      }
    }
  }

  const rows = [...Object.values(schedules)].sort((a, b) => a.start - b.start || (a.op_id < b.op_id ? -1 : 1));
  // 人手不足
  for (const r of rows) {
    const crew = idx.crews[r.crew_id];
    if (crew && +crew.members < r.demand) {
      P('manpower', 'error', `${propName(r.prop_id)} 需 ${r.demand} 人搬运，「${crew.name}」只有 ${crew.members} 人`,
        { op_id: r.op_id, x: r.start_pt ? r.start_pt[0] : null, y: r.start_pt ? r.start_pt[1] : null, prop_id: r.prop_id });
    }
    if (r.kind === 'handover') {
      const hc = idx.crews[r.handover_crew];
      if (hc && +hc.members < r.demand) {
        P('manpower', 'error', `${propName(r.prop_id)} 交接需 ${r.demand} 人，接收组「${hc.name}」只有 ${hc.members} 人`,
          { op_id: r.op_id, x: r.end_pt ? r.end_pt[0] : null, y: r.end_pt ? r.end_pt[1] : null, prop_id: r.prop_id });
      }
    }
  }
  // 可用时段 + 同组重叠
  const usage = {};
  const addUse = (cid, s, f, demand, r) => (usage[cid] = usage[cid] || []).push([s, f, demand, r]);
  for (const r of rows) {
    if (r.kind === 'handover') {
      if (idx.crews[r.crew_id]) addUse(r.crew_id, r.start, r.handover_time + TOL, r.demand, r);
      if (idx.crews[r.handover_crew]) addUse(r.handover_crew, r.handover_time, r.finish, r.demand, r);
    } else if (idx.crews[r.crew_id]) addUse(r.crew_id, r.start, r.finish, r.demand, r);
  }
  for (const [cid, ivs] of Object.entries(usage)) {
    const crew = idx.crews[cid];
    const w0 = +(crew.win_start ?? 0), w1 = +(crew.win_end ?? 1e9);
    for (const [s, f, , r] of ivs) {
      if (s < w0 - TOL || f > w1 + TOL) {
        P('window', 'error', `「${crew.name}」的任务 ${s.toFixed(1)}–${f.toFixed(1)}s 超出其可用时段 ${w0.toFixed(0)}–${w1.toFixed(0)}s`,
          { op_id: r.op_id, x: r.start_pt ? r.start_pt[0] : null, y: r.start_pt ? r.start_pt[1] : null, crew_id: cid });
      }
    }
    const ev = [];
    for (const [s, f, d, r] of ivs) { ev.push([s, +d, r]); ev.push([f, -d, r]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let used = 0;
    const active = {};
    let overlapReported = false;
    for (const [t, d, r] of ev) {
      if (d > 0) active[r.op_id] = (active[r.op_id] || 0) + d;
      used += d;
      if (d < 0) active[r.op_id] = (active[r.op_id] || 0) + d;
      if (used > +crew.members && !overlapReported) {
        overlapReported = true;
        const others = Object.entries(active).filter(([oid, n]) => n > 0 && oid !== r.op_id)
          .map(([oid]) => propName((byId(oid) || {}).prop_id)).filter(Boolean);
        P('overlap', 'error',
          `约 ${t.toFixed(1)}s「${crew.name}」同时承担 ${used} 人任务（仅 ${crew.members} 人）：` +
          propName(r.prop_id) + (others.length ? ' 与 ' + others.join('、') + ' 时间重叠' : ' 时间重叠'),
          { op_id: r.op_id, x: r.start_pt ? r.start_pt[0] : null, y: r.start_pt ? r.start_pt[1] : null, crew_id: cid });
      }
    }
  }

  // 目标腾空 / 碰撞（配置完整的行）
  const validRows = rows.filter((r) => r.pts.length >= 2 && !eps[r.op_id].missing.length);
  const tl = CE.buildTimelines(idx, shift, validRows);
  for (const r of [...validRows].sort((a, b) => a.finish - b.finish)) {
    if (!r.end_pt || !CE.onStage(idx, r.end_pt)) continue;
    const rend = CE.propRect(idx, r.prop_id, r.end_pt);
    for (const other of Object.keys(tl)) {
      if (other === r.prop_id) continue;
      const st = CE.stateAt(tl, other, r.finish);
      if (!st) continue;
      const pt = st[0] === 'still' ? st[1] : CE.positionAt({ pts: st[1].pts }, st[2]);
      if (!pt || !CE.onStage(idx, pt)) continue;
      if (CE.rectOverlap(rend, CE.propRect(idx, other, pt))) {
        P('target', 'error', `${r.finish.toFixed(0)}s 时 ${propName(r.prop_id)} 的目标位置仍被 ${propName(other)} 占用，目标位未腾空`,
          { op_id: r.op_id, x: r.end_pt[0], y: r.end_pt[1], prop_id: r.prop_id, other_prop_id: other });
      }
    }
  }
  const tEnd = validRows.reduce((m, r) => Math.max(m, r.finish), 0);
  const initOcc = CE.initialOccupancy(idx, shift);
  const initBoxes = Object.fromEntries(Object.entries(initOcc).map(([pid, pt]) => [pid, CE.propRect(idx, pid, pt)]));
  const initOverlap = new Set();
  const iids = Object.keys(initBoxes);
  for (let i = 0; i < iids.length; i++) for (let j = i + 1; j < iids.length; j++) {
    if (CE.rectOverlap(initBoxes[iids[i]], initBoxes[iids[j]], 0)) {
      const a = iids[i], b = iids[j];
      initOverlap.add(a + '|' + b);
      P('config', 'error', `${propName(a)} 与 ${propName(b)} 的收场位互相重叠`,
        { x: (initBoxes[a][0] + initBoxes[b][2]) / 2, y: (initBoxes[a][1] + initBoxes[b][3]) / 2, prop_id: a, other_prop_id: b });
    }
  }
  const reportedPairs = new Set();
  for (let t = TIMESTEP; t <= tEnd + 1e-9; t += TIMESTEP) {
    const boxes = {};
    for (const pid of Object.keys(tl)) {
      const st = CE.stateAt(tl, pid, t);
      if (!st) continue;
      const pt = st[0] === 'still' ? st[1] : CE.positionAt({ pts: st[1].pts }, st[2]);
      if (pt && CE.onStage(idx, pt)) boxes[pid] = [CE.propRect(idx, pid, pt), st];
    }
    const ids = Object.keys(boxes);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      if (!CE.rectOverlap(boxes[a][0], boxes[b][0], 0)) continue;
      const pairKey = [a, b].sort().join('|');
      if (initOverlap.has(pairKey)) continue;
      if (reportedPairs.has(pairKey)) continue;
      reportedPairs.add(pairKey);
      const moving = [a, b].filter((pid) => boxes[pid][1][0] === 'moving');
      if (!moving.length) continue;
      const cx = (boxes[a][0][0] + boxes[a][0][2] + boxes[b][0][0] + boxes[b][0][2]) / 4;
      const cy = (boxes[a][0][1] + boxes[a][0][3] + boxes[b][0][1] + boxes[b][0][3]) / 4;
      const opId = boxes[moving[0]][1][1].op_id;
      let msg;
      if (moving.length === 2) msg = `约 ${t.toFixed(1)}s ${propName(a)} 与 ${propName(b)} 同时移动并相撞`;
      else {
        const other = moving[0] === a ? b : a;
        msg = `约 ${t.toFixed(1)}s 移动的 ${propName(moving[0])} 与台上的 ${propName(other)} 相撞`;
      }
      P('collision', 'error', msg, { op_id: opId, x: cx, y: cy, prop_id: a, other_prop_id: b });
    }
  }

  const makespan = rows.reduce((m, r) => Math.max(m, r.finish), 0);
  const deadline = +(shift.deadline || 0);
  if (makespan > deadline + TOL) {
    const late = rows.filter((r) => r.finish > deadline + TOL);
    const last = late[late.length - 1];
    P('deadline', 'error', `换景总用时 ${makespan.toFixed(1)}s，超出 ${deadline.toFixed(0)}s 时限（${late.length} 个操作在时限后结束）`,
      { op_id: last ? last.op_id : null, x: last && last.end_pt ? last.end_pt[0] : null, y: last && last.end_pt ? last.end_pt[1] : null });
  }

  const outOps = ops.map((op) => {
    const r = schedules[op.id];
    const e = eps[op.id];
    const base = {
      op_id: op.id, kind: op.kind, prop_id: op.prop_id, prop_name: propName(op.prop_id),
      crew_id: op.crew_id, crew_name: (idx.crews[op.crew_id] || {}).name || '',
      handover_crew: op.handover_crew,
      handover_crew_name: (idx.crews[op.handover_crew] || {}).name || '',
      locked: op.locked_start !== null && op.locked_start !== undefined && op.locked_start !== '',
      locked_start: op.locked_start, order_hint: op.order_hint || 0,
      length: +CE.polyLen(e.pts).toFixed(2), missing: e.missing,
      unscheduled: unscheduled.has(op.id),
    };
    if (r) Object.assign(base, { start: r.start, finish: r.finish, duration: r.duration,
      demand: r.demand, handover_time: r.handover_time });
    else Object.assign(base, { start: null, finish: null, duration: null, demand: demands[op.id] });
    return base;
  });
  return { shift_id: shift.id, name: shift.name || '',
    from_scene: (idx.scenes[shift.from_scene_id] || {}).name || '（已删场景）',
    to_scene: (idx.scenes[shift.to_scene_id] || {}).name || '（已删场景）',
    deadline, makespan: +makespan.toFixed(2), problems, ops: outOps,
    _rows: rows, _eps: eps };
};

CE.analyze = function (doc) {
  const idx = CE.index(doc);
  const allOps = doc.shift_ops || [];
  const depSet = new Set((doc.shift_deps || []).map((d) => `${d.op_id}>${d.depends_on}`));
  const shifts = [...(doc.shifts || [])].sort((a, b) => (a.position || 0) - (b.position || 0) || (a.id < b.id ? -1 : 1));
  const out = shifts.map((s) => CE.analyzeShift(idx, s, allOps, depSet));
  const problems = out.flatMap((s) => s.problems);
  const scenes = [...(doc.scenes || [])].sort((a, b) => (a.position || 0) - (b.position || 0) || (a.name < b.name ? -1 : 1));
  const existing = new Set(shifts.map((s) => `${s.from_scene_id}|${s.to_scene_id}`));
  for (let i = 0; i < scenes.length - 1; i++) {
    const key = `${scenes[i].id}|${scenes[i + 1].id}`;
    if (!existing.has(key)) {
      problems.push({ type: 'config', severity: 'warning', shift_id: null, op_id: null, x: null, y: null,
        message: `相邻场景「${scenes[i].name}」→「${scenes[i + 1].name}」尚未创建换景调度`,
        from_scene_id: scenes[i].id, to_scene_id: scenes[i + 1].id });
    }
  }
  return { shifts: out, problems };
};

// ================================================================ 视图 / Canvas
const canvas = $c('#coCanvas');
const ctx = canvas.getContext('2d');
CO.view = { scale: 40, ox: 80, oy: 60 };
CO.tool = 'select';
CO.phase = 'close';
CO.currentShiftId = null;
CO.sel = null;                 // {kind:'op'|'prop'|'crew'|'gate'|'pos', id, ...}
CO.result = null;              // 最近一次分析结果
CO.play = { playing: false, t: 0, raf: null, last: 0 };
CO.flash = null;
CO.drag = null;

function fitView() {
  if (!doc || !doc.stage || !doc.stage.id) return;
  const r = canvas.getBoundingClientRect();
  const W = +doc.stage.width + 6, H = +doc.stage.height + 4;
  CO.view.scale = Math.min((r.width - 60) / W, (r.height - 60) / H);
  CO.view.ox = (r.width - doc.stage.width * CO.view.scale) / 2;
  CO.view.oy = 24;
}
function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(50, r.width * dpr);
  canvas.height = Math.max(50, r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function w2s(p) { return [p[0] * CO.view.scale + CO.view.ox, p[1] * CO.view.scale + CO.view.oy]; }
function s2w(x, y) { return [(x - CO.view.ox) / CO.view.scale, (y - CO.view.oy) / CO.view.scale]; }

function currentShift() {
  return (doc.shifts || []).find((s) => s.id === CO.currentShiftId) || null;
}
function currentResult() {
  return CO.result ? CO.result.shifts.find((s) => s.shift_id === CO.currentShiftId) : null;
}
function setPos(propId, sceneId, kind, pt) {
  const q = (doc.set_positions || []).find((x) => x.prop_id === propId && x.scene_id === sceneId && x.kind === kind);
  if (q) { q.x = pt === null ? null : +pt[0].toFixed(3); q.y = pt === null ? null : +pt[1].toFixed(3); }
  else doc.set_positions.push({ id: uid('q'), stage_id: doc.stage.id, prop_id: propId, scene_id: sceneId, kind,
    x: pt === null ? null : +pt[0].toFixed(3), y: pt === null ? null : +pt[1].toFixed(3) });
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!doc || !doc.stage.id) { drawEmpty('请先在「编排」中新建舞台与场景'); return; }
  const idx = CE.index(doc);
  const W = idx.W, H = idx.H;

  // 侧台区域
  const [x0, y0] = w2s([0, 0]);
  const sw = W * CO.view.scale, sh = H * CO.view.scale;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(CO.view.ox - 70, y0, 70 - 8, sh);
  ctx.fillRect(x0 + sw + 8, y0, 62, sh);
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('侧台 SL', CO.view.ox - 38, y0 + 14);
  ctx.fillText('侧台 SR', x0 + sw + 39, y0 + 14);

  // 舞台底
  ctx.fillStyle = '#fbf7ee';
  ctx.fillRect(x0, y0, sw, sh);
  ctx.strokeStyle = '#33414f'; ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, sw, sh);
  // 网格
  ctx.strokeStyle = 'rgba(120,100,60,.15)'; ctx.lineWidth = 1;
  for (let x = 1; x < W; x++) lineW([x, 0], [x, H]);
  for (let y = 1; y < H; y++) lineW([0, y], [W, y]);

  // 区域 / 障碍（只读，沿用编排数据）
  for (const reg of doc.regions || []) {
    drawPoly(reg.points, reg.kind === 'obstacle' ? 'rgba(217,83,79,.35)' : `${reg.color}33`,
             reg.kind === 'obstacle' ? '#b53834' : '#2f6fb3');
  }

  const shift = currentShift();
  const res = currentResult();

  // 出入口
  for (const g of doc.gates || []) {
    const [sx, sy] = w2s([g.x, g.y]);
    const selG = CO.sel && CO.sel.kind === 'gate' && CO.sel.id === g.id;
    ctx.save();
    ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = selG ? '#fff' : '#f2c66d';
    ctx.strokeStyle = '#8a6d1f'; ctx.lineWidth = selG ? 2.5 : 1.5;
    ctx.fillRect(-6, -6, 12, 12); ctx.strokeRect(-6, -6, 12, 12);
    ctx.restore();
    ctx.fillStyle = '#f2c66d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(g.name, sx, sy - 10);
  }

  // 非当前阶段的物件位置（另一阶段：半透明虚影）
  if (shift) {
    for (const p of doc.props || []) {
      const otherKind = CO.phase === 'close' ? 'open' : 'close';
      const otherScene = CO.phase === 'close' ? shift.to_scene_id : shift.from_scene_id;
      const curScene = CO.phase === 'close' ? shift.from_scene_id : shift.to_scene_id;
      const ptOther = CE.positionPoint(idx, p.id, otherScene, otherKind);
      const ptCur = CE.positionPoint(idx, p.id, curScene, CO.phase);
      if (ptOther) drawPropRect(idx, p, ptOther, 0.18, CO.phase === 'close' ? '#3f9d6b' : '#e07b39', true);
      if (ptCur && !CO.play.playing) {
        const sel = CO.sel && CO.sel.kind === 'pos' && CO.sel.id === p.id;
        drawPropRect(idx, p, ptCur, sel ? 0.95 : 0.75,
          CO.phase === 'close' ? '#e07b39' : '#3f9d6b', false, p.name);
      }
      // 存放点
      if (!CO.play.playing) {
        const sp = CE.storagePoint(idx, p);
        if (CE.onStage(idx, sp) === false) {
          const [sx, sy] = w2s(sp);
          ctx.fillStyle = 'rgba(125,142,160,.55)';
          ctx.fillRect(sx - 9, sy - 7, 18, 14);
          ctx.fillStyle = '#cfe0f2'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(p.name, sx, sy + 3);
        }
      }
    }
  }

  // 路线
  if (res) {
    const badOps = new Set(res.problems.filter((p) => ['obstacle', 'gate'].includes(p.type) && p.op_id)
      .map((p) => p.op_id));
    for (const opOut of res.ops) {
      const op = doc.shift_ops.find((o) => o.id === opOut.op_id);
      const e = res._eps[opOut.op_id];
      const selOp = CO.sel && CO.sel.kind === 'op' && CO.sel.id === opOut.op_id;
      if (!e.pts.length) continue;
      const crew = idx.crews[op.crew_id];
      const color = badOps.has(op.id) ? '#d9534f' : (crew ? crew.color : '#aaa');
      ctx.save();
      ctx.globalAlpha = selOp ? 1 : 0.55;
      ctx.strokeStyle = color; ctx.lineWidth = selOp ? 3 : 2;
      ctx.setLineDash(op.kind === 'handover' ? [7, 4] : []);
      ctx.beginPath();
      e.pts.forEach((pt, i) => { const [sx, sy] = w2s(pt); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.stroke();
      ctx.setLineDash([]);
      // 起终点标记
      if (e.start) { const [sx, sy] = w2s(e.start); ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.stroke(); }
      if (e.end) { const [sx, sy] = w2s(e.end); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill(); }
      // 可拖动锚点（仅选中操作）
      if (selOp) {
        (op.route || []).forEach((a, ai) => {
          const [sx, sy] = w2s(a);
          ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill(); ctx.stroke();
        });
      }
      ctx.restore();
    }
  }

  // 播放状态
  if (CO.play.playing && res) drawPlayback(idx, res);

  // 问题定位闪烁
  if (CO.flash && performance.now() < CO.flash.until) {
    const [sx, sy] = w2s([CO.flash.x, CO.flash.y]);
    const k = (CO.flash.until - performance.now()) / 1600;
    ctx.strokeStyle = `rgba(217,83,79,${0.4 + k * 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, 14 + (1 - k) * 22, 0, 7); ctx.stroke();
  }

  // 观众席
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillRect(x0, y0 + sh + 4, sw, 2);
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('观 众 席', x0 + sw / 2, y0 + sh + 20);
}

function drawPlayback(idx, res) {
  const t = CO.play.t;
  const rows = res._rows;
  const tl = CE.buildTimelines(idx, currentShift(), rows);
  for (const pid of Object.keys(tl)) {
    const st = CE.stateAt(tl, pid, t);
    if (!st) continue;
    const pt = st[0] === 'still' ? st[1] : CE.positionAt({ pts: st[1].pts }, st[2]);
    if (!pt) continue;
    const p = idx.props[pid];
    if (!CE.onStage(idx, pt)) {
      // 台下也画一个淡影
      const [sx, sy] = w2s(pt);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = p.color;
      ctx.fillRect(sx - 8, sy - 6, 16, 12);
      ctx.globalAlpha = 1;
      continue;
    }
    drawPropRect(idx, p, pt, 0.95, p.color, false, p.name);
    // 搬运组成员：沿物件两侧显示小点
    const r = st[0] === 'moving' ? st[1] : null;
    if (r) {
      const crewIds = r.kind === 'handover'
        ? (t < r.handover_time ? [r.crew_id] : [r.handover_crew])
        : [r.crew_id];
      for (const cid of crewIds) {
        const crew = idx.crews[cid];
        if (!crew) continue;
        const n = Math.min(+crew.members, r.demand);
        for (let i = 0; i < n; i++) {
          const dx = (i - (n - 1) / 2) * 0.45;
          const pp = [pt[0] + dx, pt[1] - (+p.h) / 2 - 0.35];
          if (!CE.onStage(idx, pp)) continue;
          const [sx, sy] = w2s(pp);
          ctx.fillStyle = crew.color;
          ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();
        }
      }
    }
  }
}

function drawEmpty(msg) {
  ctx.fillStyle = '#9fb4c9'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
  const r = canvas.getBoundingClientRect();
  ctx.fillText(msg, r.width / 2, r.height / 2);
}
function lineW(a, b) {
  const [x1, y1] = w2s(a), [x2, y2] = w2s(b);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function drawPoly(points, fill, stroke) {
  if (!points.length) return;
  ctx.beginPath();
  points.forEach((p, i) => { const [sx, sy] = w2s(p); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
}
function drawPropRect(idx, p, pt, alpha, color, dashed, label) {
  const rc = CE.propRect(idx, p.id, pt);
  const [x0, y0] = w2s([rc[0], rc[1]]);
  const [x1, y1] = w2s([rc[2], rc[3]]);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color || p.color;
  if (dashed) ctx.setLineDash([5, 3]);
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = '#23303d'; ctx.lineWidth = 1.2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
  if (label) {
    ctx.fillStyle = '#23303d'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, (x0 + x1) / 2, y0 - 3);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- 命中测试 / 指针
function hitTest(wx, wy) {
  const idx = CE.index(doc);
  const shift = currentShift();
  // 锚点（路线工具 + 选中操作）
  if (shift && CO.sel && CO.sel.kind === 'op') {
    const op = doc.shift_ops.find((o) => o.id === CO.sel.id);
    if (op) {
      const i = (op.route || []).findIndex((a) => Math.hypot(a[0] - wx, a[1] - wy) < 0.35);
      if (i >= 0) return { kind: 'anchor', id: CO.sel.id, index: i };
    }
  }
  // 出入口
  for (const g of doc.gates || []) {
    if (Math.hypot(g.x - wx, g.y - wy) < 0.45) return { kind: 'gate', id: g.id };
  }
  if (shift) {
    const sceneId = CO.phase === 'close' ? shift.from_scene_id : shift.to_scene_id;
    // 物件矩形（当前阶段）
    for (const p of [...(doc.props || [])].reverse()) {
      const pt = CE.positionPoint(idx, p.id, sceneId, CO.phase);
      if (pt) {
        const rc = CE.propRect(idx, p.id, pt);
        if (wx >= rc[0] - 0.1 && wx <= rc[2] + 0.1 && wy >= rc[1] - 0.1 && wy <= rc[3] + 0.1) {
          return { kind: 'pos', id: p.id };
        }
      }
    }
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!doc || !doc.stage.id) return;
  const rect = canvas.getBoundingClientRect();
  const wx = (e.clientX - rect.left - CO.view.ox) / CO.view.scale;
  const wy = (e.clientY - rect.top - CO.view.oy) / CO.view.scale;
  canvas.setPointerCapture(e.pointerId);
  CO.down = { x: e.clientX, y: e.clientY, wx, wy, moved: false };

  if (CO.tool === 'gate') {
    const g = hitTest(wx, wy);
    if (g && g.kind === 'gate') { CO.sel = g; }
    else {
      const ng = { id: uid('g'), stage_id: doc.stage.id, name: '台口 ' + ((doc.gates || []).length + 1),
        x: +wx.toFixed(2), y: +clampStage(wx, wy).y.toFixed(2), position: (doc.gates || []).length };
      doc.gates.push(ng); CO.sel = { kind: 'gate', id: ng.id };
      commit();
    }
    CO.drag = { mode: 'gate', id: CO.sel.id };
    refresh();
    return;
  }

  const h = hitTest(wx, wy);
  const shift = currentShift();
  if (CO.tool === 'route') {
    if (h && h.kind === 'anchor') {
      CO.sel = { kind: 'op', id: h.id };
      CO.drag = { mode: 'anchor', id: h.id, index: h.index };
    } else if (h && h.kind === 'pos') {
      // 点击物件：若该物件在当前换景有操作则选中其第一个操作
      const op = shift && doc.shift_ops.find((o) => o.shift_id === shift.id && o.prop_id === h.id);
      if (op) { CO.sel = { kind: 'op', id: op.id }; }
    } else if (shift && CO.sel && CO.sel.kind === 'op') {
      // 空白处：为选中操作添加锚点（要落在最近的路线段附近）
      const op = doc.shift_ops.find((o) => o.id === CO.sel.id);
      if (op && wx >= -0.2 && wx <= CE.index(doc).W + 0.2) {
        op.route = op.route || [];
        op.route.push([+wx.toFixed(3), +wy.toFixed(3)]);
        CO.drag = { mode: 'anchor', id: op.id, index: op.route.length - 1 };
        commit();
      }
    }
    refresh();
    return;
  }

  if (h && h.kind === 'pos' && shift) {
    CO.sel = h;
    CO.drag = { mode: 'pos', id: h.id };
  } else if (h && h.kind === 'gate') {
    CO.sel = h;
    CO.drag = { mode: 'gate', id: h.id };
  } else if (CO.tool === 'close' || CO.tool === 'open') {
    // 此工具靠左栏"在画布上设置"按钮进入；普通点击不处理
    CO.sel = null;
  } else {
    CO.sel = null;
  }
  refresh();
});

canvas.addEventListener('pointermove', (e) => {
  if (!CO.down) return;
  const dx = e.clientX - CO.down.x, dy = e.clientY - CO.down.y;
  if (Math.hypot(dx, dy) < 3) return;
  CO.down.moved = true;
  const rect = canvas.getBoundingClientRect();
  const wx = (e.clientX - rect.left - CO.view.ox) / CO.view.scale;
  const wy = (e.clientY - rect.top - CO.view.oy) / CO.view.scale;
  const shift = currentShift();
  if (!shift) return;
  if (CO.drag && CO.drag.mode === 'pos') {
    const sceneId = CO.phase === 'close' ? shift.from_scene_id : shift.to_scene_id;
    const c = clampStage(wx, wy);
    setPos(CO.drag.id, sceneId, CO.phase, c);
    commit(true);
  } else if (CO.drag && CO.drag.mode === 'gate') {
    const g = doc.gates.find((x) => x.id === CO.drag.id);
    if (g) { const c = clampStage(wx, wy, true); g.x = +c.x.toFixed(2); g.y = +c.y.toFixed(2); commit(true); }
  } else if (CO.drag && CO.drag.mode === 'anchor') {
    const op = doc.shift_ops.find((o) => o.id === CO.drag.id);
    if (op && op.route[CO.drag.index]) {
      op.route[CO.drag.index] = [+wx.toFixed(3), +wy.toFixed(3)];
      commit(true);
    }
  }
});
canvas.addEventListener('pointerup', () => {
  if (CO.down && CO.down.moved) commit();
  CO.down = null; CO.drag = null;
});
canvas.addEventListener('dblclick', (e) => {
  if (CO.tool !== 'route' || !CO.sel || CO.sel.kind !== 'op') return;
  const rect = canvas.getBoundingClientRect();
  const wx = (e.clientX - rect.left - CO.view.ox) / CO.view.scale;
  const wy = (e.clientY - rect.top - CO.view.oy) / CO.view.scale;
  const op = doc.shift_ops.find((o) => o.id === CO.sel.id);
  if (!op) return;
  // 双击锚点删除
  const i = (op.route || []).findIndex((a) => Math.hypot(a[0] - wx, a[1] - wy) < 0.4);
  if (i >= 0) { op.route.splice(i, 1); commit(); refresh(); }
});
function clampStage(x, y, gateEdge) {
  const W = +doc.stage.width, H = +doc.stage.height;
  if (gateEdge) {
    // 出入口吸附到最近的台边
    const edges = [[x, 0], [x, H], [0, y], [W, y]];
    return edges.reduce((a, b) => Math.hypot(a[0] - x, a[1] - y) <= Math.hypot(b[0] - x, b[1] - y) ? a : b);
  }
  return [Math.max(0.05, Math.min(W - 0.05, x)), Math.max(0.05, Math.min(H - 0.05, y))];
};
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const wx = (mx - CO.view.ox) / CO.view.scale;
  const wy = (my - CO.view.oy) / CO.view.scale;
  CO.view.scale = Math.max(8, Math.min(200, CO.view.scale * f));
  CO.view.ox = mx - wx * CO.view.scale;
  CO.view.oy = my - wy * CO.view.scale;
  draw();
}, { passive: false });

// ================================================================ 数据维护
function ensureArrays() {
  for (const k of ['crews', 'props', 'gates', 'set_positions', 'shifts', 'shift_ops', 'shift_deps']) {
    if (!Array.isArray(doc[k])) doc[k] = [];
  }
}
function commit(deferDraw) {
  try {
    if (typeof dirty !== 'undefined') { dirty = true; if (typeof updateSaveState === 'function') updateSaveState(); }
  } catch (e) { /* dirty 尚未初始化（空舞台占位文档）时忽略 */ }
  recompute();
  if (!deferDraw) draw();
}
function recompute() {
  if (!doc || !doc.stage.id) { CO.result = null; return; }
  ensureArrays();
  CO.result = CE.analyze(doc);
  renderLists();
  renderTimeline();
}
function refresh() {
  recompute();
  draw();
}

function addCrew() {
  ensureArrays();
  const n = doc.crews.length + 1;
  const c = { id: uid('cr'), stage_id: doc.stage.id, name: `搬运组 ${n}`, members: 2,
    win_start: 0, win_end: 600, color: CREW_COLORS[(doc.crews.length) % CREW_COLORS.length],
    position: doc.crews.length };
  doc.crews.push(c);
  CO.sel = { kind: 'crew', id: c.id };
  commit();
}
function addProp() {
  ensureArrays();
  const n = doc.props.length + 1;
  const p = { id: uid('pr'), stage_id: doc.stage.id, name: `布景 ${n}`, w: 1.2, h: 1.0,
    weight: 20, min_crew: 2, speed: 0.8, storage: 'SL', gates: [],
    color: PROP_COLORS[(doc.props.length) % PROP_COLORS.length], position: doc.props.length };
  doc.props.push(p);
  CO.sel = { kind: 'prop', id: p.id };
  commit();
}
function addShift() {
  ensureArrays();
  if (doc.scenes.length < 2) { alert('请先在「编排」中建立至少两个场景'); return; }
  const scenes = [...doc.scenes].sort((a, b) => (a.position || 0) - (b.position || 0));
  // 默认选尚无换景的第一对相邻场景
  const existing = new Set(doc.shifts.map((s) => `${s.from_scene_id}|${s.to_scene_id}`));
  let pair = null;
  for (let i = 0; i < scenes.length - 1; i++) {
    if (!existing.has(`${scenes[i].id}|${scenes[i + 1].id}`)) { pair = [scenes[i], scenes[i + 1]]; break; }
  }
  if (!pair) pair = [scenes[0], scenes[1]];
  const sh = { id: uid('sh'), stage_id: doc.stage.id, from_scene_id: pair[0].id,
    to_scene_id: pair[1].id, name: `${pair[0].name} → ${pair[1].name}`,
    deadline: 120, position: doc.shifts.length };
  doc.shifts.push(sh);
  CO.currentShiftId = sh.id;
  CO.sel = null;
  commit();
}
function addOp(kind) {
  ensureArrays();
  const shift = currentShift();
  if (!shift) { alert('请先在左侧选择/新建一个换景'); return; }
  const op = { id: uid('op'), stage_id: doc.stage.id, shift_id: shift.id,
    prop_id: (doc.props[0] || {}).id || null, kind, crew_id: (doc.crews[0] || {}).id || null,
    handover_crew: null, demands: null, locked_start: null,
    order_hint: doc.shift_ops.filter((o) => o.shift_id === shift.id).length,
    route: [], position: doc.shift_ops.length };
  doc.shift_ops.push(op);
  CO.sel = { kind: 'op', id: op.id };
  commit();
}
function deleteSelected() {
  if (!CO.sel) return;
  const { kind, id } = CO.sel;
  if (kind === 'op') {
    doc.shift_ops = doc.shift_ops.filter((o) => o.id !== id);
    doc.shift_deps = doc.shift_deps.filter((d) => d.op_id !== id && d.depends_on !== id);
  } else if (kind === 'prop') {
    if (!confirm('删除该物件及其全部位置与换景操作？')) return;
    doc.props = doc.props.filter((p) => p.id !== id);
    doc.set_positions = doc.set_positions.filter((q) => q.prop_id !== id);
    const ops = doc.shift_ops.filter((o) => o.prop_id === id).map((o) => o.id);
    doc.shift_ops = doc.shift_ops.filter((o) => o.prop_id !== id);
    doc.shift_deps = doc.shift_deps.filter((d) => !ops.includes(d.op_id) && !ops.includes(d.depends_on));
  } else if (kind === 'crew') {
    doc.crews = doc.crews.filter((c) => c.id !== id);
  } else if (kind === 'gate') {
    doc.gates = doc.gates.filter((g) => g.id !== id);
    for (const p of doc.props) p.gates = (p.gates || []).filter((g) => g !== id);
  }
  CO.sel = null;
  commit();
}

// ================================================================ 列表面板
function renderLists() {
  renderShiftList();
  renderCrewList();
  renderPropList();
  renderOpList();
  renderProblems();
  renderInspector();
}
function renderShiftList() {
  const ul = $c('#coShiftList');
  ul.innerHTML = '';
  for (const sh of doc.shifts || []) {
    const res = CO.result && CO.result.shifts.find((s) => s.shift_id === sh.id);
    const nBad = res ? res.problems.length : 0;
    const li = document.createElement('li');
    li.className = `${CO.currentShiftId === sh.id ? 'sel' : ''} ${nBad ? 'bad' : 'ok'}`;
    li.innerHTML = `<span class="nm">${esc(sh.name || '未命名换景')}</span>
      <span class="v">${res ? res.makespan.toFixed(0) : '?'}/${(+sh.deadline).toFixed(0)}s</span>
      <button class="del" title="删除">×</button>`;
    li.querySelector('.nm').onclick = () => { CO.currentShiftId = sh.id; CO.sel = null; stopPlay(); refresh(); };
    li.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      if (!confirm('删除该换景及其全部操作？')) return;
      doc.shifts = doc.shifts.filter((x) => x.id !== sh.id);
      doc.shift_ops = doc.shift_ops.filter((o) => o.shift_id !== sh.id);
      doc.shift_deps = doc.shift_deps.filter((d) => d.shift_id !== sh.id);
      if (CO.currentShiftId === sh.id) CO.currentShiftId = doc.shifts[0]?.id || null;
      commit();
    };
    ul.appendChild(li);
  }
  const meta = $c('#coShiftMeta');
  const sh = currentShift();
  meta.classList.toggle('hidden', !sh);
  if (sh) {
    $c('#coShiftName').value = sh.name || '';
    $c('#coDeadline').value = sh.deadline;
    const res = currentResult();
    $c('#coMakespan').value = res ? `${res.makespan.toFixed(1)} s` : '';
  }
}
function renderCrewList() {
  const ul = $c('#coCrewList');
  ul.innerHTML = '';
  for (const c of doc.crews || []) {
    const li = document.createElement('li');
    li.className = CO.sel && CO.sel.kind === 'crew' && CO.sel.id === c.id ? 'sel' : '';
    li.innerHTML = `<span class="swatch" style="background:${esc(c.color)}"></span>
      <span class="nm">${esc(c.name)}</span>
      <span class="meta">${c.members}人 · ${(+c.win_start).toFixed(0)}-${(+c.win_end).toFixed(0)}s</span>`;
    li.onclick = () => { CO.sel = { kind: 'crew', id: c.id }; renderInspector(); draw(); renderCrewList(); };
    ul.appendChild(li);
  }
}
function renderPropList() {
  const ul = $c('#coPropList');
  ul.innerHTML = '';
  for (const p of doc.props || []) {
    const li = document.createElement('li');
    li.className = CO.sel && CO.sel.kind === 'prop' && CO.sel.id === p.id ? 'sel' : '';
    li.innerHTML = `<span class="swatch" style="background:${esc(p.color)}"></span>
      <span class="nm">${esc(p.name)}</span>
      <span class="meta">${p.min_crew}人 · ${p.speed}m/s</span>`;
    li.onclick = () => { CO.sel = { kind: 'prop', id: p.id }; renderInspector(); draw(); renderPropList(); };
    ul.appendChild(li);
  }
}
function renderOpList() {
  const ul = $c('#coOpList');
  ul.innerHTML = '';
  const sh = currentShift();
  const res = currentResult();
  if (!sh) return;
  const ops = doc.shift_ops.filter((o) => o.shift_id === sh.id)
    .sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0));
  const badOps = new Set((res ? res.problems : []).map((p) => p.op_id).filter(Boolean));
  for (const op of ops) {
    const out = res && res.ops.find((o) => o.op_id === op.id);
    const crew = doc.crews.find((c) => c.id === op.crew_id);
    const prop = doc.props.find((p) => p.id === op.prop_id);
    const li = document.createElement('li');
    li.className = `${CO.sel && CO.sel.kind === 'op' && CO.sel.id === op.id ? 'sel' : ''} ${badOps.has(op.id) || (out && out.unscheduled) ? 'bad' : ''}`;
    const time = out && out.start !== null && !out.unscheduled
      ? `${out.start.toFixed(1)}-${out.finish.toFixed(1)}s` : (out && out.unscheduled ? '未排程' : '—');
    li.innerHTML = `<div class="o1">
        <span class="kind" style="background:${KIND_COLOR[op.kind]}">${KIND_LABEL[op.kind]}</span>
        <span class="nm">${esc(prop ? prop.name : '?')}</span>
        <span class="v">${time}</span>
      </div>
      <div class="o2"><span>${esc(crew ? crew.name : '未指派')}${op.kind === 'handover' ? ' → ' + esc((doc.crews.find((c) => c.id === op.handover_crew) || {}).name || '?') : ''}</span>
      <span>${out ? out.length.toFixed(1) : '?'}m · ${out ? out.duration.toFixed(1) : '?'}s</span></div>`;
    li.onclick = () => { CO.sel = { kind: 'op', id: op.id }; renderInspector(); draw(); renderOpList(); };
    ul.appendChild(li);
  }
}
function renderProblems() {
  const ul = $c('#coProblemList');
  const res = currentResult();
  const globalOthers = CO.result ? CO.result.problems.filter((p) => p.shift_id !== CO.currentShiftId) : [];
  const list = [...(res ? res.problems : []), ...(res ? [] : globalOthers)];
  $c('#coProblemCount').textContent = list.length;
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.className = p.severity === 'warning' ? 'warning' : 'error';
    li.textContent = p.message;
    li.onclick = () => locateProblem(p);
    ul.appendChild(li);
  }
}
function locateProblem(p) {
  if (p.shift_id && p.shift_id !== CO.currentShiftId) {
    CO.currentShiftId = p.shift_id;
    refresh();
  }
  if (p.op_id) {
    CO.sel = { kind: 'op', id: p.op_id };
    renderInspector(); draw(); renderOpList();
  }
  if (p.x !== null && p.y !== null && p.x !== undefined) {
    CO.flash = { x: p.x, y: p.y, until: performance.now() + 1600 };
    // 居中
    const rect = canvas.getBoundingClientRect();
    CO.view.ox = rect.width / 2 - p.x * CO.view.scale;
    CO.view.oy = rect.height / 2 - p.y * CO.view.scale;
    draw();
  }
}

// ---------------------------------------------------------------- 属性面板
function field(label, inputHtml) {
  return `<label>${label} ${inputHtml}</label>`;
}
function renderInspector() {
  const el = $c('#coInspector');
  if (!CO.sel) { el.innerHTML = '<p class="muted">未选中任何对象</p>'; return; }
  const { kind, id } = CO.sel;
  if (kind === 'crew') {
    const c = doc.crews.find((x) => x.id === id);
    if (!c) return;
    el.innerHTML = `
      ${field('名称', `<input data-f="name" type="text" value="${esc(c.name)}">`)}
      <div class="grid2">
        ${field('人数', `<input data-f="members" type="number" min="1" step="1" value="${c.members}">`)}
        ${field('颜色', `<input data-f="color" type="color" value="${esc(c.color)}">`)}
      </div>
      <div class="grid2">
        ${field('可用起(s)', `<input data-f="win_start" type="number" step="1" value="${c.win_start}">`)}
        ${field('可用止(s)', `<input data-f="win_end" type="number" step="1" value="${c.win_end}">`)}
      </div>
      <button class="act danger" data-act="del">删除搬运组</button>`;
    bindInspector(c, ['name', 'members', 'color', 'win_start', 'win_end']);
  } else if (kind === 'prop') {
    const p = doc.props.find((x) => x.id === id);
    if (!p) return;
    const gates = (doc.gates || []).map((g) =>
      `<label class="ckrow"><input type="checkbox" data-gate="${g.id}" ${(p.gates || []).includes(g.id) ? 'checked' : ''}> ${esc(g.name)} (${g.x.toFixed(1)},${g.y.toFixed(1)})</label>`).join('') || '<span class="muted">尚无出入口，用画布上方「出入口」工具在台边添加</span>';
    el.innerHTML = `
      ${field('名称', `<input data-f="name" type="text" value="${esc(p.name)}">`)}
      <div class="grid2">
        ${field('宽(m)', `<input data-f="w" type="number" min="0.1" step="0.1" value="${p.w}">`)}
        ${field('深(m)', `<input data-f="h" type="number" min="0.1" step="0.1" value="${p.h}">`)}
      </div>
      <div class="grid2">
        ${field('重量(kg)', `<input data-f="weight" type="number" min="0" step="1" value="${p.weight}">`)}
        ${field('最低人数', `<input data-f="min_crew" type="number" min="1" step="1" value="${p.min_crew}">`)}
      </div>
      <div class="grid2">
        ${field('移动速度(m/s)', `<input data-f="speed" type="number" min="0.05" step="0.05" value="${p.speed}">`)}
        ${field('颜色', `<input data-f="color" type="color" value="${esc(p.color)}">`)}
      </div>
      ${field('存放侧台', `<select data-f="storage"><option value="SL" ${p.storage === 'SL' ? 'selected' : ''}>舞台左侧台 SL</option><option value="SR" ${p.storage === 'SR' ? 'selected' : ''}>舞台右侧台 SR</option></select>`)}
      <label>允许出入口</label><div class="gatebox">${gates}</div>
      <button class="act danger" data-act="del">删除物件（含位置与操作）</button>`;
    bindInspector(p, ['name', 'w', 'h', 'weight', 'min_crew', 'speed', 'color', 'storage']);
    el.querySelectorAll('[data-gate]').forEach((cb) => cb.addEventListener('change', () => {
      p.gates = p.gates || [];
      const gid = cb.dataset.gate;
      if (cb.checked) { if (!p.gates.includes(gid)) p.gates.push(gid); }
      else p.gates = p.gates.filter((x) => x !== gid);
      commit();
    }));
    el.querySelector('[data-act=del]').onclick = deleteSelected;
  } else if (kind === 'gate') {
    const g = doc.gates.find((x) => x.id === id);
    if (!g) return;
    el.innerHTML = `
      ${field('名称', `<input data-f="name" type="text" value="${esc(g.name)}">`)}
      <div class="grid2">
        ${field('x(m)', `<input data-f="x" type="number" step="0.1" value="${g.x}">`)}
        ${field('y(m)', `<input data-f="y" type="number" step="0.1" value="${g.y}">`)}
      </div>
      <button class="act danger" data-act="del">删除出入口</button>`;
    bindInspector(g, ['name', 'x', 'y']);
    el.querySelector('[data-act=del]').onclick = deleteSelected;
  } else if (kind === 'pos') {
    const sh = currentShift();
    const p = doc.props.find((x) => x.id === id);
    if (!p || !sh) return;
    const sceneId = CO.phase === 'close' ? sh.from_scene_id : sh.to_scene_id;
    const sceneName = (doc.scenes.find((s) => s.id === sceneId) || {}).name || '';
    const pt = CE.positionPoint(CE.index(doc), id, sceneId, CO.phase);
    el.innerHTML = `<p><b>${esc(p.name)}</b> 的${CO.phase === 'close' ? '收场位' : '开场位'}（${esc(sceneName)}）</p>
      <div class="grid2">
        ${field('x(m)', `<input id="coPosX" type="number" step="0.1" value="${pt ? pt[0] : ''}">`)}
        ${field('y(m)', `<input id="coPosY" type="number" step="0.1" value="${pt ? pt[1] : ''}">`)}
      </div>
      <button class="act" id="coPosClear">清除（视为在侧台）</button>
      <p class="muted">也可直接在画布上拖动物件矩形。</p>`;
    const onPos = (axis) => (e) => {
      const cur = CE.positionPoint(CE.index(doc), id, sceneId, CO.phase) || [0, 0];
      const nx = axis === 'x' ? +e.target.value || 0 : cur[0];
      const ny = axis === 'y' ? +e.target.value || 0 : cur[1];
      setPos(id, sceneId, CO.phase, [nx, ny]); commit();
    };
    $c('#coPosX').onchange = onPos('x');
    $c('#coPosY').onchange = onPos('y');
    $c('#coPosClear').onclick = () => { setPos(id, sceneId, CO.phase, null); commit(); };
  } else if (kind === 'op') {
    const op = doc.shift_ops.find((x) => x.id === id);
    if (!op) return;
    const sh = currentShift();
    const res = currentResult();
    const out = res && res.ops.find((o) => o.op_id === id);
    const propOpts = (doc.props || []).map((p) =>
      `<option value="${p.id}" ${op.prop_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const crewOpts = ['<option value="">（未指派）</option>'].concat(
      (doc.crews || []).map((c) => `<option value="${c.id}" ${op.crew_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)).join('');
    const handoverOpts = ['<option value="">（无）</option>'].concat(
      (doc.crews || []).map((c) => `<option value="${c.id}" ${op.handover_crew === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)).join('');
    // 依赖勾选
    const others = doc.shift_ops.filter((o) => o.shift_id === sh.id && o.id !== op.id)
      .sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0));
    const depSet = new Set((doc.shift_deps || []).filter((d) => d.op_id === op.id).map((d) => d.depends_on));
    const depBox = others.map((o) => {
      const p = doc.props.find((x) => x.id === o.prop_id);
      return `<label class="ckrow"><input type="checkbox" data-dep="${o.id}" ${depSet.has(o.id) ? 'checked' : ''}> ${KIND_LABEL[o.kind]} ${esc(p ? p.name : '?')}</label>`;
    }).join('') || '<span class="muted">没有其他操作</span>';
    el.innerHTML = `
      ${field('类型', `<select data-f="kind">${Object.entries(KIND_LABEL).map(([k, v]) =>
        `<option value="${k}" ${op.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}
      ${field('物件', `<select data-f="prop_id">${propOpts}</select>`)}
      ${field('负责组', `<select data-f="crew_id">${crewOpts}</select>`)}
      ${op.kind === 'handover' ? field('接收组', `<select data-f="handover_crew">${handoverOpts}</select>`) : ''}
      <div class="grid2">
        ${field('投用人数', `<input data-f="demands" type="number" min="1" step="1" placeholder="默认=最低人数" value="${op.demands ?? ''}">`)}
        ${field('锁定开始(s)', `<input data-f="locked_start" type="number" min="0" step="0.5" placeholder="不锁定" value="${op.locked_start ?? ''}">`)}
      </div>
      <p class="muted">${out && !out.unscheduled ? `排程：${out.start.toFixed(1)} – ${out.finish.toFixed(1)}s（${out.duration.toFixed(1)}s，${out.length.toFixed(1)}m，${out.demand} 人）` : '该操作当前无法排程（依赖环或前置未排程）'}</p>
      <label>先后依赖（完成后才开始本操作）</label><div class="gatebox">${depBox}</div>
      <div style="display:flex;gap:4px">
        <button class="act" data-act="up" title="提前顺序">↑ 提前</button>
        <button class="act" data-act="down" title="延后顺序">↓ 延后</button>
      </div>
      <button class="act danger" data-act="del">删除操作</button>`;
    bindInspector(op, ['kind', 'prop_id', 'crew_id', 'handover_crew', 'demands', 'locked_start']);
    el.querySelectorAll('[data-dep]').forEach((cb) => cb.addEventListener('change', () => {
      const dep = cb.dataset.dep;
      doc.shift_deps = doc.shift_deps || [];
      if (cb.checked) doc.shift_deps.push({ id: uid('dp'), stage_id: doc.stage.id, shift_id: sh.id, op_id: op.id, depends_on: dep });
      else doc.shift_deps = doc.shift_deps.filter((d) => !(d.op_id === op.id && d.depends_on === dep));
      commit();
    }));
    el.querySelector('[data-act=del]').onclick = deleteSelected;
    el.querySelector('[data-act=up]').onclick = () => reorderOp(op, -1);
    el.querySelector('[data-act=down]').onclick = () => reorderOp(op, +1);
  }
}
function bindInspector(obj, fields) {
  const el = $c('#coInspector');
  for (const f of fields) {
    const input = el.querySelector(`[data-f="${f}"]`);
    if (!input) continue;
    input.addEventListener('change', () => {
      if (input.type === 'number') {
        if (input.value === '') obj[f] = (f === 'demands' || f === 'locked_start') ? null : +input.value;
        else obj[f] = +input.value;
      } else obj[f] = input.value;
      commit();
    });
  }
  const del = el.querySelector('[data-act=del]');
  if (del) del.onclick = deleteSelected;
}
function reorderOp(op, dir) {
  const sh = currentShift();
  const peers = doc.shift_ops.filter((o) => o.shift_id === sh.id)
    .sort((a, b) => (a.order_hint || 0) - (b.order_hint || 0));
  const i = peers.findIndex((o) => o.id === op.id);
  const j = i + dir;
  if (j < 0 || j >= peers.length) return;
  const a = peers[i].order_hint || 0, b = peers[j].order_hint || 0;
  peers[i].order_hint = b; peers[j].order_hint = a;
  commit();
}

// ================================================================ 时间线（甘特）
function renderTimeline() {
  const wrap = $c('#coTimeline');
  wrap.innerHTML = '';
  const res = currentResult();
  const sh = currentShift();
  if (!sh || !res) return;
  const left = 110, right = 10, rowH = 20;
  const widthPct = 100; // 用比例定位
  const tMax = Math.max(res.deadline, res.makespan,
    res.ops.reduce((m, o) => Math.max(m, o.finish || 0), 0), 5);
  wrap.style.height = `${Math.max(90, doc.crews.length * rowH + 30)}px`;
  const X = (t) => `calc(${left}px + (100% - ${left + right}px) * ${(t / tMax).toFixed(4)})`;
  const W = (dt) => `calc((100% - ${left + right}px) * ${(dt / tMax).toFixed(4)})`;
  // 网格刻度
  const tickStep = tMax > 90 ? 30 : tMax > 40 ? 15 : tMax > 15 ? 5 : 2;
  for (let t = 0; t <= tMax; t += tickStep) {
    const tk = document.createElement('div');
    tk.className = 'rv-tick';
    tk.style.left = X(t);
    const lab = document.createElement('span');
    lab.className = 'rv-tick-label';
    lab.style.left = X(t); lab.textContent = t + 's';
    wrap.appendChild(tk); wrap.appendChild(lab);
  }
  // 时限红线
  const dl = document.createElement('div');
  dl.className = 'co-deadline-line';
  dl.style.left = X(res.deadline);
  const dt = document.createElement('div');
  dt.className = 'co-deadline-txt';
  dt.style.left = X(res.deadline); dt.textContent = `时限 ${res.deadline}s`;
  wrap.appendChild(dl); wrap.appendChild(dt);

  doc.crews.forEach((crew, ri) => {
    const row = document.createElement('div');
    row.className = 'co-row';
    row.style.top = `${20 + ri * rowH}px`;
    const lab = document.createElement('span');
    lab.className = 'co-rowlabel';
    lab.style.top = `${20 + ri * rowH + 3}px`;
    lab.textContent = `${crew.name}（${crew.members}人）`;
    wrap.appendChild(lab);
    const line = document.createElement('div');
    line.style.position = 'absolute';
    line.style.left = `${left}px`; line.style.right = `${right}px`;
    line.style.top = `${20 + ri * rowH + 9}px`; line.style.height = '1px';
    line.style.background = '#d8e0e9';
    wrap.appendChild(line);
  });
  // 操作块：交接在交出/接收两行各画半段，其余画在负责组行
  for (const o of res.ops) {
    if (o.unscheduled || o.start === null) continue;
    const crew = doc.crews.find((c) => c.id === o.crew_id);
    const rows = [];
    if (o.kind === 'handover') {
      rows.push([o.crew_id, o.start, o.handover_time]);
      rows.push([o.handover_crew, o.handover_time, o.finish]);
    } else rows.push([o.crew_id, o.start, o.finish]);
    for (const [cid, s, f] of rows) {
      const ri = doc.crews.findIndex((c) => c.id === cid);
      if (ri < 0) continue;
      const b = document.createElement('div');
      b.className = 'co-block';
      b.classList.toggle('locked', !!o.locked);
      b.classList.toggle('sel', CO.sel && CO.sel.kind === 'op' && CO.sel.id === o.op_id);
      b.style.left = X(s); b.style.width = W(Math.max(0.3, f - s));
      b.style.top = `${20 + ri * rowH + 2}px`;
      b.style.background = (crew && o.crew_id === cid) ? crew.color : (doc.crews.find((c) => c.id === cid) || {}).color || '#888';
      b.textContent = `${KIND_LABEL[o.kind]} ${o.prop_name}${o.locked ? ' 🔒' : ''}`;
      b.title = `${KIND_LABEL[o.kind]} ${o.prop_name}：${s.toFixed(1)}-${f.toFixed(1)}s（拖动调整先后顺序）`;
      b.dataset.opid = o.op_id;
      b.addEventListener('click', (e) => { e.stopPropagation(); CO.sel = { kind: 'op', id: o.op_id }; renderInspector(); draw(); renderOpList(); renderTimeline(); });
      addBlockDrag(b, o.op_id);
      wrap.appendChild(b);
    }
  }
  // 播放头
  const ph = document.createElement('div');
  ph.className = 'co-playhead';
  ph.style.left = X(Math.min(CO.play.t, tMax));
  ph.id = 'coPlayhead';
  wrap.appendChild(ph);
}
function addBlockDrag(block, opId) {
  block.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const startX = e.clientX;
    const onMove = (me) => {
      if (Math.abs(me.clientX - startX) < 8) return;
      const wrap = $c('#coTimeline');
      const rows = [...wrap.querySelectorAll('.co-block')].filter((b) => b !== block);
      let target = null;
      for (const b of rows) {
        const r = b.getBoundingClientRect();
        if (me.clientX >= r.left && me.clientX <= r.right && me.clientY >= r.top && me.clientY <= r.bottom) { target = b; break; }
      }
      rows.forEach((b) => b.style.outline = '');
      if (target) target.style.outline = '2px dashed #1f2d3d';
      block._target = target;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const target = block._target;
      document.querySelectorAll('.co-block').forEach((b) => b.style.outline = '');
      if (target) {
        // 交换 order_hint
        const otherId = findOpIdByBlock(target);
        const a = doc.shift_ops.find((o) => o.id === opId);
        const b = doc.shift_ops.find((o) => o.id === otherId);
        if (a && b) {
          const ha = a.order_hint || 0, hb = b.order_hint || 0;
          a.order_hint = hb; b.order_hint = ha;
          commit();
        }
      }
      block._target = null;
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}
function findOpIdByBlock(block) {
  // 通过 title/selection 反查较脆弱；在创建时记录
  return block.dataset ? block.dataset.opid : null;
}

// ================================================================ 播放
function setPlayTime(t) {
  const res = currentResult();
  if (!res) return;
  CO.play.t = Math.max(0, Math.min(res.makespan, t));
  $c('#coScrub').value = res.makespan > 0 ? (CO.play.t / res.makespan) * 1000 : 0;
  $c('#coTimeLabel').textContent = CO.play.t.toFixed(1) + 's';
  const ph = $c('#coPlayhead');
  if (ph) {
    const sh = currentShift();
    const tMax = Math.max(res.deadline, res.makespan, 5);
    ph.style.left = `calc(110px + (100% - 120px) * ${Math.min(CO.play.t, tMax) / tMax})`;
  }
  draw();
}
function stopPlay() {
  CO.play.playing = false;
  if (CO.play.raf) cancelAnimationFrame(CO.play.raf);
  CO.play.raf = null;
  $c('#coPlayBtn').textContent = '▶';
}
function togglePlay() {
  const res = currentResult();
  if (!res) return;
  if (CO.play.playing) { stopPlay(); return; }
  if (CO.play.t >= res.makespan - 0.05) setPlayTime(0);
  CO.play.playing = true;
  $c('#coPlayBtn').textContent = '⏸';
  CO.play.last = performance.now();
  const tick = (now) => {
    if (!CO.play.playing) return;
    const dt = (now - CO.play.last) / 1000;
    CO.play.last = now;
    let t = CO.play.t + dt;
    if (t >= res.makespan) { t = res.makespan; stopPlay(); }
    setPlayTime(t);
    if (CO.play.playing) CO.play.raf = requestAnimationFrame(tick);
  };
  CO.play.raf = requestAnimationFrame(tick);
}

// ================================================================ 模式入口 / 事件
let entered = false;
function enterMode() {
  ensureArrays();
  if (!doc || !doc.stage.id) { draw(); return; }
  if (!CO.currentShiftId || !doc.shifts.some((s) => s.id === CO.currentShiftId)) {
    CO.currentShiftId = doc.shifts[0]?.id || null;
  }
  resizeCanvas();
  fitView();
  stopPlay();
  setPlayTime(0);
  refresh();
}
function reloadForStage() {
  if (mode() !== 'changeover') return;
  CO.sel = null;
  CO.currentShiftId = (doc.shifts || [])[0]?.id || null;
  stopPlay();
  enterMode();
}
function mode() { return typeof appMode !== 'undefined' ? appMode : 'plan'; }

// 保存完成后重算（服务端可能补了默认值），但保留当前选中的换景
document.addEventListener('co:stageChanged', () => {
  if (mode() !== 'changeover') return;
  const keep = CO.currentShiftId;
  CO.sel = null;
  if (keep && (doc.shifts || []).some((s) => s.id === keep)) CO.currentShiftId = keep;
  else CO.currentShiftId = (doc.shifts || [])[0]?.id || null;
  stopPlay();
  enterMode();
});

document.addEventListener('DOMContentLoaded', () => {
  // 工具
  document.querySelectorAll('#coTools button').forEach((btn) => btn.addEventListener('click', () => {
    CO.tool = btn.dataset.ctool;
    document.querySelectorAll('#coTools button').forEach((b) => b.classList.toggle('active', b === btn));
    const hints = {
      select: '选择/拖动：拖动物件矩形调整位置，拖路线锚点改路线，点击选中。',
      close: '收场位工具：在左栏点物件后直接在画布拖动；或用「在画布设置」。',
      open: '开场位工具：同上，编辑的是下一场开场位置。',
      route: '编辑路线：先在右侧选中操作，点击空白加锚点、拖动锚点改线，双击锚点删除。',
      gate: '出入口：点击台边空白新增出入口（自动吸附台边），拖动调整。',
    };
    $c('#coToolHint').textContent = hints[CO.tool];
  }));
  document.querySelectorAll('input[name=coPhase]').forEach((r) => r.addEventListener('change', (e) => {
    CO.phase = e.target.value; CO.sel = null; refresh();
  }));
  $c('#coAddShiftBtn').onclick = addShift;
  $c('#coAddCrewBtn').onclick = addCrew;
  $c('#coAddPropBtn').onclick = addProp;
  $c('#coAddStrikeBtn').onclick = () => addOp('strike');
  $c('#coAddMoveBtn').onclick = () => addOp('move');
  $c('#coAddPresetBtn').onclick = () => addOp('preset');
  $c('#coAddHandoverBtn').onclick = () => addOp('handover');
  $c('#coShiftName').onchange = (e) => { const sh = currentShift(); if (sh) { sh.name = e.target.value; commit(); } };
  $c('#coDeadline').onchange = (e) => { const sh = currentShift(); if (sh) { sh.deadline = Math.max(1, +e.target.value || 120); commit(); } };
  $c('#coZoomIn').onclick = () => zoomBy(1.2);
  $c('#coZoomOut').onclick = () => zoomBy(1 / 1.2);
  $c('#coZoomFit').onclick = () => { fitView(); draw(); };
  $c('#coPlayBtn').onclick = togglePlay;
  $c('#coScrub').addEventListener('input', (e) => {
    const res = currentResult();
    if (res) { stopPlay(); setPlayTime((e.target.value / 1000) * res.makespan); }
  });
  $c('#printChangeoverBtn').onclick = openChangeoverPrint;
  window.addEventListener('resize', () => { if (mode() === 'changeover') { resizeCanvas(); fitView(); draw(); } });
  document.addEventListener('keydown', (e) => {
    if (mode() !== 'changeover') return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  });
  resizeCanvas();
});

function zoomBy(f) {
  const r = canvas.getBoundingClientRect();
  const mx = r.width / 2, my = r.height / 2;
  const wx = (mx - CO.view.ox) / CO.view.scale;
  const wy = (my - CO.view.oy) / CO.view.scale;
  CO.view.scale = Math.max(8, Math.min(200, CO.view.scale * f));
  CO.view.ox = mx - wx * CO.view.scale;
  CO.view.oy = my - wy * CO.view.scale;
  draw();
}
async function openChangeoverPrint() {
  if (!doc || !doc.stage.id) return;
  if (typeof dirty !== 'undefined' && dirty && typeof saveDoc === 'function') await saveDoc(true);
  window.open(`/print/stages/${doc.stage.id}/changeover`, '_blank');
}

// 与 app.js / rehearsal.js 的模式切换对接
document.querySelectorAll('#modeTabs .mtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === 'changeover') {
      setTimeout(enterMode, 0);
    } else {
      stopPlay();
    }
  });
});
// 舞台切换/保存后刷新（监听 app.js afterLoad 发出的事件）
// 暴露给测试与调试
window.CO = { CE, CO, enterMode, recompute };
})();
