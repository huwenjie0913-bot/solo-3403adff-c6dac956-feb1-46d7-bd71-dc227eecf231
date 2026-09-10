/* 舞台走位编排前端：Canvas 编辑器 + 时间轴 + 分析。
 * 数据模型与后端文档结构一致（doc.stage/regions/actors/scenes/beats/placements/paths）。
 */
'use strict';

// ---------------------------------------------------------------- 基础工具
const $ = (sel) => document.querySelector(sel);
const uid = (p) => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const ACTOR_COLORS = ['#e8734a', '#3f8fdd', '#46a063', '#9b6dd3', '#d4a23a', '#d05b93', '#2fafb0', '#8a8f99'];
const AREA_COLORS = ['#8ab4f8', '#7fd1a5', '#f2c66d', '#b39ddb'];

let doc = null;                 // 当前排练文档
let stages = [];
let tool = 'select';
let currentBeatId = null;
let selection = [];             // [{kind:'actor'|'region'|'placement'|'anchor'|'beat', id?, beatId?, actorId?, index?}]
let view = { scale: 40, ox: 60, oy: 40 };
let history = { stack: [], idx: -1, pending: null };
let dirty = false;
let drawing = null;             // {kind:'area'|'obstacle', pts:[]}
let problems = [], moveMap = {};
let flash = null;               // 问题定位闪烁 {x,y,until}
let clipboard = null;
let play = { active: false, playing: false, t: 0, raf: null, last: null };
let compareOn = false;
let panState = null, marquee = null, dragInfo = null;
const keys = {};

// ---------------------------------------------------------------- 几何
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function polyLen(pts) {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return s;
}
function cross(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
function segIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = cross(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = cross(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = cross(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pathHitsPolygon(a, b, poly) {
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (segIntersect(a, b, c, d)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 数据派生
const beatsSorted = () => [...doc.beats].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
const actorById = (id) => doc.actors.find((a) => a.id === id);
const beatById = (id) => doc.beats.find((b) => b.id === id);
const sceneById = (id) => doc.scenes.find((s) => s.id === id);
const placementsOf = (beatId) => doc.placements.filter((p) => p.beat_id === beatId);
function prevBeatInScene(beat) {
  if (!beat) return null;
  const list = beatsSorted();
  const i = list.findIndex((b) => b.id === beat.id);
  for (let k = i - 1; k >= 0; k--) {
    if (list[k].scene_id === beat.scene_id) return list[k];
    break; // 跨场景即断开
  }
  return null;
}
function anchorsFor(fromId, toId, actorId) {
  const p = doc.paths.find((q) => q.from_beat_id === fromId && q.to_beat_id === toId && q.actor_id === actorId);
  return p ? p.points.map((q) => [...q]) : null;
}
function fullPath(prev, beat, actorId) {
  const a = doc.placements.find((p) => p.beat_id === prev.id && p.actor_id === actorId);
  const b = doc.placements.find((p) => p.beat_id === beat.id && p.actor_id === actorId);
  if (!a || !b) return null;
  const mid = anchorsFor(prev.id, beat.id, actorId) || [];
  return [[a.x, a.y], ...mid, [b.x, b.y]];
}

// ---------------------------------------------------------------- 历史
function resetHistory() {
  history = { stack: [JSON.stringify(doc)], idx: 0, pending: null };
  dirty = false; updateSaveState();
}
function beginInteraction() { history.pending = JSON.stringify(doc); }
function endInteraction(label) {
  if (!history.pending) return;
  if (history.pending !== JSON.stringify(doc)) {
    history.stack.splice(history.idx + 1);
    history.stack.push(history.pending);
    history.stack.push(JSON.stringify(doc));
    if (history.stack.length > 120) history.stack.shift();
    history.idx = history.stack.length - 1;
    markDirty();
  }
  history.pending = null;
  refresh();
}
function commit(label) {
  history.stack.splice(history.idx + 1);
  history.stack.push(JSON.stringify(doc));
  if (history.stack.length > 120) history.stack.shift();
  history.idx = history.stack.length - 1;
  markDirty();
  refresh();
}
function undo() {
  if (history.idx <= 0) return;
  history.idx--;
  doc = JSON.parse(history.stack[history.idx]);
  pruneSelection(); markDirty(); refresh();
}
function redo() {
  if (history.idx >= history.stack.length - 1) return;
  history.idx++;
  doc = JSON.parse(history.stack[history.idx]);
  pruneSelection(); markDirty(); refresh();
}
function markDirty() { dirty = true; updateSaveState(); }
function pruneSelection() {
  const ok = selection.filter((s) => {
    if (s.kind === 'actor') return actorById(s.id);
    if (s.kind === 'region') return doc.regions.find((r) => r.id === s.id);
    if (s.kind === 'placement') return doc.placements.find((p) => p.beat_id === s.beatId && p.actor_id === s.actorId);
    if (s.kind === 'beat') return beatById(s.id);
    return true;
  });
  selection = ok;
  if (currentBeatId && !beatById(currentBeatId)) currentBeatId = doc.beats[0]?.id || null;
}

// ---------------------------------------------------------------- Canvas
const canvas = $('#stageCanvas');
const ctx = canvas.getContext('2d');
let hatchPattern = null;

function fitView() {
  const wrap = $('#canvasWrap').getBoundingClientRect();
  const W = doc.stage.width, H = doc.stage.height;
  view.scale = Math.min((wrap.width - 100) / W, (wrap.height - 120) / H);
  view.scale = clamp(view.scale, 5, 400);
  view.ox = (wrap.width - W * view.scale) / 2;
  view.oy = (wrap.height - H * view.scale) / 2 - 10;
}
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(50, r.width * dpr);
  canvas.height = Math.max(50, r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!hatchPattern) hatchPattern = makeHatch();
  draw();
}
function makeHatch() {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(181,56,52,.55)';
  g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
  return ctx.createPattern(c, 'repeat');
}
function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale,
           sx: e.clientX - r.left, sy: e.clientY - r.top };
}
function zoomAt(factor, sx, sy) {
  const ns = clamp(view.scale * factor, 5, 400);
  const k = ns / view.scale;
  view.ox = sx - (sx - view.ox) * k;
  view.oy = sy - (sy - view.oy) * k;
  view.scale = ns;
  draw();
}

// ---------------------------------------------------------------- 绘制
function draw() {
  if (!doc) return;
  const W = doc.stage.width, H = doc.stage.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);

  // 地面网格
  ctx.fillStyle = '#fbf7ee';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e7e0d2';
  ctx.lineWidth = 1 / view.scale;
  ctx.beginPath();
  for (let x = 1; x < W; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 1; y < H; y++) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  drawRegions(W, H);
  const beat = beatById(currentBeatId);

  if (!play.active) {
    drawPaths(beat);
    if (compareOn) drawCompare(beat);
    drawPlacements(beat);
    drawAnchors(beat);
    drawRegionVertices();
  } else {
    drawPlayback(beat);
  }

  // 舞台边框与观众侧
  ctx.strokeStyle = '#33414f';
  ctx.lineWidth = 2.5 / view.scale;
  ctx.strokeRect(0, 0, W, H);
  ctx.save();
  ctx.fillStyle = 'rgba(51,65,79,.18)';
  ctx.fillRect(0, H, W, 0.5);
  ctx.strokeStyle = '#33414f';
  ctx.setLineDash([0.25, 0.15]);
  ctx.beginPath(); ctx.moveTo(0, H + 0.06); ctx.lineTo(W, H + 0.06); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#5a6b7c';
  ctx.font = `${13 / view.scale}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('观 众 席', W / 2, H + 0.38);
  ctx.restore();

  // 多边形绘制草稿
  if (drawing) drawDraft();

  // 框选
  if (marquee) {
    ctx.fillStyle = 'rgba(80,140,220,.12)';
    ctx.strokeStyle = '#4a8bd8';
    ctx.lineWidth = 1.5 / view.scale;
    const [x0, y0, x1, y1] = [Math.min(marquee.x0, marquee.x1), Math.min(marquee.y0, marquee.y1),
                              Math.max(marquee.x0, marquee.x1), Math.max(marquee.y0, marquee.y1)];
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.restore();

  // 屏幕空间信息
  ctx.fillStyle = '#cdd9e6';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${doc.stage.name} · ${W}m × ${H}m`, 12, canvas.getBoundingClientRect().height - 12);

  if (flash && performance.now() < flash.until) drawFlash();
}

function drawRegions(W, H) {
  for (const r of doc.regions) {
    const pts = r.points;
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (r.kind === 'obstacle') {
      ctx.fillStyle = 'rgba(217,83,79,.18)';
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = hatchPattern;
      ctx.fillRect(-2, -2, W + 4, H + 4);
      ctx.restore();
      ctx.strokeStyle = '#b53834';
    } else {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = r.color || '#8ab4f8';
      ctx.globalAlpha = 0.22;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = r.color || '#2f6fb3';
    }
    ctx.lineWidth = (isSelected({ kind: 'region', id: r.id }) ? 3 : 1.6) / view.scale;
    ctx.stroke();
    // 名称
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    ctx.font = `${11.5 / view.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = r.kind === 'obstacle' ? '#96322e' : '#33506e';
    ctx.fillText(r.name + (r.kind === 'obstacle' ? '（障碍）' : ''), cx, cy);
  }
}
function drawRegionVertices() {
  for (const s of selection) {
    if (s.kind !== 'region') continue;
    const r = doc.regions.find((q) => q.id === s.id);
    if (!r) continue;
    for (const p of r.points) drawHandle(p[0], p[1], '#fff', '#2f6fb3');
  }
}
function drawHandle(x, y, fill, stroke) {
  const r = 6 / view.scale;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.6 / view.scale;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawPaths(beat) {
  const prev = prevBeatInScene(beat);
  if (!prev) return;
  for (const actor of doc.actors) {
    const pts = fullPath(prev, beat, actor.id);
    if (!pts) continue;
    const mv = moveMap[`${beat.id}:${actor.id}`];
    const obstacleHit = problems.some((p) => p.type === 'obstacle' && p.beat_id === beat.id && p.actor_id === actor.id);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = mv && !mv.ok ? '#d9534f' : obstacleHit ? '#b53834' : actor.color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = (mv && !mv.ok ? 3 : 2) / view.scale;
    if (obstacleHit) ctx.setLineDash([0.3, 0.18]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // 路径长度/耗时
    if (mv) {
      const mid = pathMidpoint(pts);
      ctx.font = `${10.5 / view.scale}px sans-serif`;
      ctx.textAlign = 'center';
      const label = `${mv.length.toFixed(1)}m/${mv.duration.toFixed(1)}s`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(mid[0] - tw / 2 - 0.08, mid[1] - 0.22, tw + 0.16, 0.3);
      ctx.fillStyle = mv.ok ? '#4a5a6b' : '#c63732';
      ctx.fillText(label, mid[0], mid[1]);
    }
  }
}
function pathMidpoint(pts) {
  const total = polyLen(pts), target = total / 2;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (acc + seg >= target && seg > 0) {
      const r = (target - acc) / seg;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}
function drawAnchors(beat) {
  if (tool !== 'path' || !beat) return;
  const prev = prevBeatInScene(beat);
  if (!prev) return;
  for (const actor of doc.actors) {
    const pts = fullPath(prev, beat, actor.id);
    if (!pts) continue;
    for (let i = 1; i < pts.length - 1; i++) {
      drawHandle(pts[i][0], pts[i][1], '#fff', actor.color);
    }
  }
}

function drawMarker(x, y, actor, opts = {}) {
  const r = 0.3;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = opts.ghost ? 'rgba(255,255,255,.35)' : actor.color;
  ctx.fill();
  ctx.lineWidth = (opts.sel ? 3.4 : 2) / view.scale;
  ctx.strokeStyle = opts.ghost ? actor.color : '#ffffff';
  if (opts.ghost) ctx.setLineDash([0.12, 0.08]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (!opts.ghost) {
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${0.34}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(opts.index ?? ''), x, y + 0.01);
    ctx.textBaseline = 'alphabetic';
  }
  // 朝向箭头
  const f = (opts.facing ?? 0) * Math.PI / 180;
  const dx = Math.sin(f), dy = Math.cos(f);
  ctx.beginPath();
  ctx.moveTo(x + dx * (r + 0.04), y + dy * (r + 0.04));
  ctx.lineTo(x + dx * (r + 0.34), y + dy * (r + 0.34));
  ctx.strokeStyle = opts.ghost ? actor.color : '#23303d';
  ctx.lineWidth = 2 / view.scale;
  ctx.stroke();
}

function drawPlacements(beat) {
  if (!beat) return;
  const list = placementsOf(beat.id);
  list.forEach((p, i) => {
    const actor = actorById(p.actor_id);
    if (!actor) return;
    const idx = doc.actors.indexOf(actor) + 1;
    const sel = isSelected({ kind: 'placement', beatId: beat.id, actorId: p.actor_id });
    drawMarker(p.x, p.y, actor, { facing: p.facing, sel, index: idx });
    ctx.font = `${10.5 / view.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#23303d';
    ctx.fillText(actor.name, p.x, p.y - 0.42);
  });
}

function drawCompare(beat) {
  const prev = prevBeatInScene(beat);
  if (!prev) { $('#compareLabel').textContent = '当前节点在场景开头，无上一节点'; return; }
  const now = placementsOf(beat.id), past = placementsOf(prev.id);
  let moved = 0, entered = 0, left = 0;
  for (const pa of past) {
    const pb = now.find((q) => q.actor_id === pa.actor_id);
    const actor = actorById(pa.actor_id);
    if (!actor) continue;
    if (!pb) {
      left++;
      drawMarker(pa.x, pa.y, actor, { ghost: true, facing: pa.facing });
    } else {
      if (dist(pa.x, pa.y, pb.x, pb.y) > 0.05) {
        moved++;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
        ctx.strokeStyle = 'rgba(70,110,150,.55)';
        ctx.setLineDash([0.18, 0.12]);
        ctx.lineWidth = 1.6 / view.scale;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
  for (const pb of now) if (!past.some((q) => q.actor_id === pb.actor_id)) entered++;
  $('#compareLabel').textContent = `对比「${prev.name}」→「${beat.name}」：移动 ${moved} 人，新入场 ${entered} 人，离场 ${left} 人`;
}

function drawDraft() {
  const pts = drawing.pts;
  ctx.beginPath();
  pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
  if (pts.length >= 3) {
    ctx.closePath();
    ctx.fillStyle = drawing.kind === 'obstacle' ? 'rgba(217,83,79,.15)' : 'rgba(80,140,220,.15)';
    ctx.fill();
  }
  ctx.strokeStyle = drawing.kind === 'obstacle' ? '#b53834' : '#2f6fb3';
  ctx.setLineDash([0.2, 0.12]);
  ctx.lineWidth = 2 / view.scale;
  ctx.stroke();
  ctx.setLineDash([]);
  pts.forEach((p) => drawHandle(p[0], p[1], '#fff', drawing.kind === 'obstacle' ? '#b53834' : '#2f6fb3'));
}

// ---------------------------------------------------------------- 时间轴回放
function timeRange() {
  if (!doc.beats.length) return [0, 1];
  const ts = doc.beats.map((b) => b.time);
  return [Math.min(...ts), Math.max(...ts)];
}
function positionAtSceneTime(scene, t) {
  const sceneBeats = beatsSorted().filter((b) => b.scene_id === scene.id);
  if (!sceneBeats.length) return {};
  const out = {};
  for (const actor of doc.actors) {
    const apps = sceneBeats
      .map((b) => ({ b, p: doc.placements.find((q) => q.beat_id === b.id && q.actor_id === actor.id) }))
      .filter((x) => x.p)
      .sort((x, y) => x.b.time - y.b.time);
    if (!apps.length) continue;
    if (t < apps[0].b.time - 1e-6 || t > apps[apps.length - 1].b.time + 1e-6) continue;
    if (t <= apps[0].b.time) { out[actor.id] = [apps[0].p.x, apps[0].p.y, apps[0].p.facing]; continue; }
    if (t >= apps[apps.length - 1].b.time) { const last = apps[apps.length - 1].p; out[actor.id] = [last.x, last.y, last.facing]; continue; }
    for (let i = 0; i < apps.length - 1; i++) {
      const a = apps[i], b = apps[i + 1];
      if (a.b.time <= t && t <= b.b.time) {
        const pts = fullPath(a.b, b.b, actor.id) || [[a.p.x, a.p.y], [b.p.x, b.p.y]];
        const total = polyLen(pts);
        const dt = b.b.time - a.b.time;
        const want = total * (dt > 0 ? (t - a.b.time) / dt : 1);
        let acc = 0;
        for (let k = 0; k < pts.length - 1; k++) {
          const seg = dist(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
          if (acc + seg >= want) {
            const r = seg > 0 ? (want - acc) / seg : 0;
            const f = a.p.facing + (b.p.facing - a.p.facing) * (dt > 0 ? (t - a.b.time) / dt : 1);
            out[actor.id] = [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * r,
                             pts[k][1] + (pts[k + 1][1] - pts[k][1]) * r, f];
            break;
          }
          acc += seg;
        }
        if (!out[actor.id]) out[actor.id] = [b.p.x, b.p.y, b.p.facing];
        break;
      }
    }
  }
  return out;
}
function positionsAtTime(t) {
  // 找到时间覆盖 t 的场景（beat 时间范围包含 t）
  for (const scene of doc.scenes) {
    const sb = doc.beats.filter((b) => b.scene_id === scene.id);
    if (!sb.length) continue;
    const t0 = Math.min(...sb.map((b) => b.time)), t1 = Math.max(...sb.map((b) => b.time));
    if (t0 - 1e-6 <= t && t <= t1 + 1e-6) {
      const pos = positionAtSceneTime(scene, t);
      pos.__scene = scene.id;
      return pos;
    }
  }
  return {};
}
function drawPlayback() {
  const pos = positionsAtTime(play.t);
  doc.actors.forEach((actor, i) => {
    const q = pos[actor.id];
    if (!q) return;
    drawMarker(q[0], q[1], actor, { facing: q[2], index: i + 1 });
    ctx.font = `${10.5 / view.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#23303d';
    ctx.fillText(actor.name, q[0], q[1] - 0.42);
  });
}
function setPlayTime(t) {
  const [t0, t1] = timeRange();
  play.t = clamp(t, t0, t1);
  play.active = true;
  const v = t1 > t0 ? ((play.t - t0) / (t1 - t0)) * 1000 : 0;
  $('#timeScrub').value = v;
  $('#timeLabel').textContent = play.t.toFixed(1) + 's';
  draw();
}
function stopPlayback() {
  play.active = false; play.playing = false; play.last = null;
  if (play.raf) cancelAnimationFrame(play.raf);
  $('#playBtn').textContent = '▶';
  refresh();
}

// ---------------------------------------------------------------- 命中测试
function hitTest(w) {
  const beat = beatById(currentBeatId);
  const px = 7.5 / view.scale;
  // 路径锚点
  if (tool === 'path' && beat) {
    const prev = prevBeatInScene(beat);
    if (prev) {
      for (const actor of doc.actors) {
        const pts = fullPath(prev, beat, actor.id);
        if (!pts) continue;
        for (let i = 1; i < pts.length - 1; i++) {
          if (dist(w.x, w.y, pts[i][0], pts[i][1]) <= px)
            return { kind: 'anchor', beatId: beat.id, actorId: actor.id, index: i - 1 };
        }
      }
    }
  }
  // 区域顶点（选中区域时）
  for (const s of selection) {
    if (s.kind !== 'region') continue;
    const r = doc.regions.find((q) => q.id === s.id);
    if (!r) continue;
    for (let i = 0; i < r.points.length; i++) {
      if (dist(w.x, w.y, r.points[i][0], r.points[i][1]) <= px)
        return { kind: 'regionVertex', id: r.id, index: i };
    }
  }
  // 演员标记
  if (beat && !play.active) {
    const list = placementsOf(beat.id);
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (dist(w.x, w.y, p.x, p.y) <= 0.34)
        return { kind: 'placement', beatId: beat.id, actorId: p.actor_id };
    }
  }
  // 区域内部（后画的在上）
  if (!play.active) {
    for (let i = doc.regions.length - 1; i >= 0; i--) {
      const r = doc.regions[i];
      if (r.points.length >= 3 && pointInPoly(w.x, w.y, r.points))
        return { kind: 'region', id: r.id };
    }
  }
  return null;
}
function isSelected(s) {
  return selection.some((q) => q.kind === s.kind &&
    (s.kind === 'placement' ? q.beatId === s.beatId && q.actorId === s.actorId : q.id === s.id));
}

// ---------------------------------------------------------------- 鼠标交互
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || keys[' ']) { panState = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy }; e.preventDefault(); return; }
  if (e.button !== 0) return;
  const w = toWorld(e);

  if (drawing) {
    if (e.target === canvas) {
      drawing.pts.push([clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height)]);
      updateDrawBar();
      draw();
    }
    return;
  }
  if (tool === 'area' || tool === 'obstacle') {
    drawing = { kind: tool, pts: [[clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height)]] };
    $('#drawBar').classList.remove('hidden');
    updateDrawBar();
    draw();
    return;
  }

  const hit = hitTest(w);
  if (hit) {
    if (hit.kind === 'placement' && e.shiftKey) {
      if (isSelected(hit)) selection = selection.filter((s) => !(s.kind === 'placement' && s.beatId === hit.beatId && s.actorId === hit.actorId));
      else selection.push(hit);
    } else if (hit.kind === 'placement') {
      if (!isSelected(hit)) selection = [hit];
    } else {
      if (!isSelected(hit)) selection = [hit];
    }
    beginInteraction();
    dragInfo = { hit, start: w, moved: false,
      originals: selection.filter((s) => s.kind === 'placement').map((s) => {
        const p = doc.placements.find((q) => q.beat_id === s.beatId && q.actor_id === s.actorId);
        return { s, x: p.x, y: p.y };
      }) };
    renderInspector();
    draw();
  } else if (tool === 'path' && !e.shiftKey) {
    // 点击路径附近添加锚点：找当前节点该演员的最近线段
    addAnchorNear(w);
  } else if (tool === 'select') {
    if (e.shiftKey) {
      marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, additive: true };
    } else {
      selection = [];
      marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, additive: false };
    }
    beginInteraction();
    renderInspector();
    draw();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const w = toWorld(e);
  if (panState) {
    view.ox = panState.ox + (e.clientX - panState.sx);
    view.oy = panState.oy + (e.clientY - panState.sy);
    draw();
    return;
  }
  if (drawing) { draw(); return; }
  if (!dragInfo) {
    if (marquee) { marquee.x1 = w.x; marquee.y1 = w.y; draw(); }
    return;
  }
  const dx = w.x - dragInfo.start.x, dy = w.y - dragInfo.start.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.05) dragInfo.moved = true;
  const hit = dragInfo.hit;
  if (hit.kind === 'placement') {
    for (const o of dragInfo.originals) {
      const p = doc.placements.find((q) => q.beat_id === o.s.beatId && q.actor_id === o.s.actorId);
      p.x = clamp(o.x + dx, 0, doc.stage.width);
      p.y = clamp(o.y + dy, 0, doc.stage.height);
    }
    draw();
  } else if (hit.kind === 'region') {
    const r = doc.regions.find((q) => q.id === hit.id);
    if (!dragInfo.regionOrig) dragInfo.regionOrig = r.points.map((p) => [...p]);
    r.points = dragInfo.regionOrig.map((p) => [clamp(p[0] + dx, 0, doc.stage.width), clamp(p[1] + dy, 0, doc.stage.height)]);
    draw();
  } else if (hit.kind === 'regionVertex') {
    const r = doc.regions.find((q) => q.id === hit.id);
    r.points[hit.index] = [clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height)];
    draw();
  } else if (hit.kind === 'anchor') {
    const prev = prevBeatInScene(beatById(hit.beatId));
    if (!prev) return;
    let path = doc.paths.find((q) => q.from_beat_id === prev.id && q.to_beat_id === hit.beatId && q.actor_id === hit.actorId);
    if (!path) return;
    path.points[hit.index] = [clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height)];
    draw();
  }
});

window.addEventListener('mouseup', (e) => {
  if (panState) { panState = null; return; }
  if (marquee) {
    const [x0, y0, x1, y1] = [Math.min(marquee.x0, marquee.x1), Math.min(marquee.y0, marquee.y1),
                              Math.max(marquee.x0, marquee.x1), Math.max(marquee.y0, marquee.y1)];
    const beat = beatById(currentBeatId);
    if (beat && (x1 - x0) * (y1 - y0) > 0.01) {
      const inside = placementsOf(beat.id)
        .filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
        .map((p) => ({ kind: 'placement', beatId: beat.id, actorId: p.actor_id }));
      selection = marquee.additive ? [...selection, ...inside] : inside;
    }
    marquee = null;
    endInteraction();
    return;
  }
  if (dragInfo) { endInteraction(); dragInfo = null; }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => {
  if (tool === 'path') {
    e.preventDefault();
    const w = toWorld(e);
    const hit = hitTest(w);
    if (hit && hit.kind === 'anchor') deleteAnchor(hit);
  }
});

// 双击：选中区域时在边上插入顶点；否则把下一位尚未上台的演员放到点击处
canvas.addEventListener('dblclick', (e) => {
  if (drawing || play.active) return;
  const w = toWorld(e);
  for (const s of selection) {
    if (s.kind !== 'region') continue;
    const r = doc.regions.find((q) => q.id === s.id);
    if (!r) continue;
    const hit = nearestSegment(w, r.points);
    if (hit && hit.d < 0.5) {
      beginInteraction();
      r.points.splice(hit.i + 1, 0, [hit.x, hit.y]);
      endInteraction();
      return;
    }
  }
  const beat = beatById(currentBeatId);
  if (!beat || !doc.actors.length) return;
  const onStage = new Set(placementsOf(beat.id).map((p) => p.actor_id));
  const next = doc.actors.find((a) => !onStage.has(a.id));
  if (next) placeActorAt(next.id, clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height));
});

function nearestSegment(w, pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = dist(a[0], a[1], b[0], b[1]);
    if (L < 1e-6) continue;
    let t = ((w.x - a[0]) * (b[0] - a[0]) + (w.y - a[1]) * (b[1] - a[1])) / (L * L);
    t = clamp(t, 0, 1);
    const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
    const d = dist(w.x, w.y, px, py);
    if (!best || d < best.d) best = { d, i, x: px, y: py };
  }
  return best;
}

canvas.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('text/actor')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
});
canvas.addEventListener('drop', (e) => {
  const actorId = e.dataTransfer.getData('text/actor');
  if (!actorId) return;
  e.preventDefault();
  const w = toWorld(e);
  placeActorAt(actorId, clamp(w.x, 0, doc.stage.width), clamp(w.y, 0, doc.stage.height));
});

function addAnchorNear(w) {
  const beat = beatById(currentBeatId);
  const prev = prevBeatInScene(beat);
  if (!beat || !prev) return;
  let best = null;
  for (const actor of doc.actors) {
    const pts = fullPath(prev, beat, actor.id);
    if (!pts || pts.length < 2) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = dist(a[0], a[1], b[0], b[1]);
      if (L < 1e-6) continue;
      let t = ((w.x - a[0]) * (b[0] - a[0]) + (w.y - a[1]) * (b[1] - a[1])) / (L * L);
      t = clamp(t, 0, 1);
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const d = dist(w.x, w.y, px, py);
      if (!best || d < best.d) best = { d, actor, i, x: px, y: py };
    }
  }
  if (!best || best.d > 0.6) return;
  beginInteraction();
  let path = doc.paths.find((q) => q.from_beat_id === prev.id && q.to_beat_id === beat.id && q.actor_id === best.actor.id);
  if (!path) {
    path = { id: uid('p'), from_beat_id: prev.id, to_beat_id: beat.id, actor_id: best.actor.id, points: [] };
    doc.paths.push(path);
  }
  // best.i 是 fullPath 段索引；内部锚点插入位置 = best.i（在第 i 段之后）
  path.points.splice(clamp(best.i, 0, path.points.length), 0, [best.x, best.y]);
  endInteraction();
}
function deleteAnchor(hit) {
  const prev = prevBeatInScene(beatById(hit.beatId));
  if (!prev) return;
  beginInteraction();
  deleteAnchorRaw(hit, prev);
  selection = selection.filter((s) => s.kind !== 'anchor');
  endInteraction();
}
function deleteAnchorRaw(hit, prev) {
  prev = prev || prevBeatInScene(beatById(hit.beatId));
  if (!prev) return;
  const path = doc.paths.find((q) => q.from_beat_id === prev.id && q.to_beat_id === hit.beatId && q.actor_id === hit.actorId);
  if (path) {
    path.points.splice(hit.index, 1);
    if (!path.points.length) doc.paths = doc.paths.filter((q) => q !== path);
  }
}
function rawDeleteActor(id) {
  doc.actors = doc.actors.filter((a) => a.id !== id);
  doc.placements = doc.placements.filter((p) => p.actor_id !== id);
  doc.paths = doc.paths.filter((p) => p.actor_id !== id);
}

// ---------------------------------------------------------------- 多边形绘制
function updateDrawBar() {
  $('#drawInfo').textContent = drawing
    ? `${drawing.kind === 'obstacle' ? '障碍' : '区域'}：已添加 ${drawing.pts.length} 个顶点（至少 3 个）`
    : '';
}
function finishDrawing() {
  if (!drawing) return;
  if (drawing.pts.length < 3) { alert('至少需要 3 个顶点'); return; }
  const colors = drawing.kind === 'obstacle' ? ['#d9534f'] : AREA_COLORS;
  const region = {
    id: uid('r'),
    name: (drawing.kind === 'obstacle' ? '障碍 ' : '区域 ') + (doc.regions.filter((r) => r.kind === drawing.kind).length + 1),
    kind: drawing.kind,
    points: drawing.pts,
    color: colors[doc.regions.filter((r) => r.kind === drawing.kind).length % colors.length],
  };
  drawing = null;
  $('#drawBar').classList.add('hidden');
  doc.regions.push(region);
  selection = [{ kind: 'region', id: region.id }];
  commit();
}
function cancelDrawing() {
  drawing = null;
  $('#drawBar').classList.add('hidden');
  draw();
}
$('#drawFinishBtn').addEventListener('click', finishDrawing);
$('#drawCancelBtn').addEventListener('click', cancelDrawing);

// ---------------------------------------------------------------- 分析（与后端 analysis.py 同规则）
const TIMING_TOL = 0.02, COLLISION_R = 0.35, TIMESTEP = 0.5;
function analyze() {
  problems = [];
  moveMap = {};
  if (!doc) return;
  const obstacles = doc.regions.filter((r) => r.kind === 'obstacle');
  const beats = beatsSorted();

  for (const actor of doc.actors) {
    let prev = null;
    let prevScene = null;
    for (const beat of beats) {
      if (prevScene !== null && beat.scene_id !== prevScene) prev = null;
      const pl = doc.placements.find((p) => p.beat_id === beat.id && p.actor_id === actor.id);
      if (!pl) { prev = null; prevScene = beat.scene_id; continue; }
      for (const ob of obstacles) {
        if (pointInPoly(pl.x, pl.y, ob.points)) {
          problems.push({ type: 'obstacle', severity: 'error',
            message: `${actor.name} 在节点「${beat.name}」的位置位于障碍「${ob.name}」内`,
            actor_id: actor.id, beat_id: beat.id, x: pl.x, y: pl.y });
        }
      }
      if (prev) {
        const pts = fullPath(prev.beat, beat, actor.id);
        const length = polyLen(pts), available = Math.max(0, beat.time - prev.beat.time);
        const speed = Math.max(0.01, actor.speed || 1.2), duration = length / speed;
        const key = `${beat.id}:${actor.id}`;
        const ok = duration <= available + TIMING_TOL;
        moveMap[key] = { length, duration, available, ok };
        if (!ok) {
          const extra = available > 1e-9 ? `（需 ${(length / available).toFixed(2)} m/s，常用 ${speed} m/s）` : '';
          problems.push({ type: 'timing', severity: 'error',
            message: `${actor.name} 「${prev.beat.name}」→「${beat.name}」：${length.toFixed(1)}m 需 ${duration.toFixed(1)}s，仅有 ${available.toFixed(1)}s${extra}`,
            actor_id: actor.id, beat_id: beat.id, x: pl.x, y: pl.y, from_beat_id: prev.beat.id,
            midpoint: pathMidpoint(pts) });
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const hit = obstacles.find((ob) => pathHitsPolygon(pts[i], pts[i + 1], ob.points));
          if (hit) {
            problems.push({ type: 'obstacle', severity: 'error',
              message: `${actor.name} 「${prev.beat.name}」→「${beat.name}」的路径穿越障碍「${hit.name}」`,
              actor_id: actor.id, beat_id: beat.id, x: pl.x, y: pl.y, from_beat_id: prev.beat.id,
              midpoint: [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2] });
            break;
          }
        }
      }
      prev = { beat, pl };
      prevScene = beat.scene_id;
    }
  }

  // 碰撞：时间采样
  if (doc.actors.length >= 2 && beats.length) {
    const t0 = Math.min(...beats.map((b) => b.time)), t1 = Math.max(...beats.map((b) => b.time));
    const seen = new Set();
    for (let t = t0; t <= t1 + 1e-9; t += TIMESTEP) {
      const pos = {};
      for (const a of doc.actors) pos[a.id] = null;
      for (const scene of doc.scenes) {
        const got = positionAtSceneTime(scene, t);
        for (const k of Object.keys(got)) if (got[k]) pos[k] = got[k];
      }
      for (let i = 0; i < doc.actors.length; i++) {
        for (let j = i + 1; j < doc.actors.length; j++) {
          const a = doc.actors[i], b = doc.actors[j];
          const pa = pos[a.id], pb = pos[b.id];
          if (!pa || !pb) continue;
          if (dist(pa[0], pa[1], pb[0], pb[1]) < COLLISION_R * 2) {
            const near = beats.filter((q) => Math.abs(q.time - t) < TIMESTEP + 1e-6)[0]
              || beats.filter((q) => q.time >= t)[0] || beats[beats.length - 1];
            const sig = `${a.id}|${b.id}|${near ? near.id : ''}|${t.toFixed(1)}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            problems.push({ type: 'collision', severity: 'warning', t,
              message: `${a.name} 与 ${b.name} 在约 ${t.toFixed(1)}s（节点「${near ? near.name : '-'}」附近）距离过近，可能碰撞`,
              actor_id: a.id, other_actor_id: b.id, beat_id: near ? near.id : null,
              x: (pa[0] + pb[0]) / 2, y: (pa[1] + pb[1]) / 2 });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 面板渲染
function refresh() {
  analyze();
  draw();
  renderActorList();
  renderRegionList();
  renderSceneList();
  renderProblemList();
  renderInspector();
  $('#undoBtn').disabled = history.idx <= 0;
  $('#redoBtn').disabled = history.idx >= history.stack.length - 1;
  $('#zoomLabel').textContent = Math.round(view.scale / baseScale() * 100) + '%';
}
function baseScale() {
  const wrap = $('#canvasWrap').getBoundingClientRect();
  return Math.min((wrap.width - 100) / doc.stage.width, (wrap.height - 120) / doc.stage.height);
}

function renderActorList() {
  const ul = $('#actorList');
  ul.innerHTML = '';
  doc.actors.forEach((a, i) => {
    const li = document.createElement('li');
    if (isSelected({ kind: 'actor', id: a.id })) li.classList.add('sel');
    li.innerHTML = `<span class="swatch" style="background:${a.color}"></span>
      <span class="nm">${i + 1}. ${escapeHtml(a.name)}</span>
      <span class="meta">${a.speed.toFixed(1)}m/s</span>
      <button class="del" title="删除">✕</button>`;
    li.addEventListener('click', () => { selection = [{ kind: 'actor', id: a.id }]; renderInspector(); renderActorList(); });
    li.draggable = true;
    li.title = '拖到画布可加入当前节点；双击画布放入下一位演员';
    li.addEventListener('dragstart', (e) => {
      if (!currentBeatId) { e.preventDefault(); alert('请先选择一个场景节点'); return; }
      e.dataTransfer.setData('text/actor', a.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteActor(a.id); });
    ul.appendChild(li);
  });
}
function renderRegionList() {
  const ul = $('#regionList');
  ul.innerHTML = '';
  doc.regions.forEach((r) => {
    const li = document.createElement('li');
    if (isSelected({ kind: 'region', id: r.id })) li.classList.add('sel');
    li.innerHTML = `<span class="swatch" style="background:${r.kind === 'obstacle' ? '#d9534f' : r.color}"></span>
      <span class="nm">${escapeHtml(r.name)}</span>
      <button class="del" title="删除">✕</button>`;
    li.addEventListener('click', () => {
      selection = [{ kind: 'region', id: r.id }];
      const cx = r.points.reduce((s, p) => s + p[0], 0) / r.points.length;
      const cy = r.points.reduce((s, p) => s + p[1], 0) / r.points.length;
      centerOn(cx, cy);
      renderInspector(); renderRegionList();
    });
    li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteRegion(r.id); });
    ul.appendChild(li);
  });
  if (!doc.regions.length) ul.innerHTML = '<li class="muted">尚无区域，用顶部工具绘制</li>';
}
function renderSceneList() {
  const ul = $('#sceneList');
  ul.innerHTML = '';
  doc.scenes.forEach((scene, si) => {
    const li = document.createElement('li');
    li.draggable = false;
    const head = document.createElement('div');
    head.className = 'sceneHead';
    head.innerHTML = `<span>🎬</span><span class="nm">${escapeHtml(scene.name)}</span>
      <button class="mini addBeat" title="在场景末尾添加节点">+节点</button>
      <button class="del" title="删除场景">✕</button>`;
    head.querySelector('.nm').addEventListener('click', () => {
      const name = prompt('场景名称', scene.name);
      if (name && name.trim()) { scene.name = name.trim(); commit(); }
    });
    head.querySelector('.addBeat').addEventListener('click', () => addBeat(scene.id));
    head.querySelector('.del').addEventListener('click', () => {
      if (confirm(`删除场景「${scene.name}」及其全部节点？`)) deleteScene(scene.id);
    });
    li.appendChild(head);
    const bl = document.createElement('ul');
    bl.className = 'beatlist';
    const beats = beatsSorted().filter((b) => b.scene_id === scene.id);
    beats.forEach((beat) => {
      const item = document.createElement('li');
      item.draggable = true;
      if (beat.id === currentBeatId) item.classList.add('sel');
      if (placementsOf(beat.id).length) item.classList.add('has');
      item.innerHTML = `<span class="nm">${escapeHtml(beat.name)}</span><span class="tm">${beat.time.toFixed(0)}s</span><button class="del" title="删除节点">✕</button>`;
      item.addEventListener('click', () => selectBeat(beat.id));
      item.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteBeat(beat.id); });
      item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/beat', beat.id); e.dataTransfer.effectAllowed = 'move'; });
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.style.borderTop = '2px solid #4a8bd8'; });
      item.addEventListener('dragleave', () => { item.style.borderTop = ''; });
      item.addEventListener('drop', (e) => {
        e.preventDefault(); item.style.borderTop = '';
        const id = e.dataTransfer.getData('text/beat');
        if (id) reorderBeat(id, beat.id, scene.id);
      });
      bl.appendChild(item);
    });
    // 场景整体作为放置目标（拖到空白处 = 场景末尾）
    li.addEventListener('dragover', (e) => { if (!e.target.closest('.beatlist li')) e.preventDefault(); });
    li.addEventListener('drop', (e) => {
      if (e.target.closest('.beatlist li')) return;
      e.preventDefault();
      const id = e.dataTransfer.getData('text/beat');
      if (id) reorderBeat(id, null, scene.id);
    });
    li.appendChild(bl);
    ul.appendChild(li);
  });
}

function renderProblemList() {
  const ul = $('#problemList');
  ul.innerHTML = '';
  const errs = problems.filter((p) => p.severity === 'error').length;
  $('#problemCount').textContent = problems.length;
  $('#problemCount').style.background = problems.length ? (errs ? '#d9534f' : '#e0a32e') : '#46a063';
  problems.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = p.severity;
    const icon = p.type === 'timing' ? '⏱' : p.type === 'obstacle' ? '🚧' : '💥';
    li.innerHTML = `${icon} ${escapeHtml(p.message)}`;
    li.addEventListener('click', () => locateProblem(p));
    ul.appendChild(li);
  });
  if (!problems.length) ul.innerHTML = '<li class="muted">未发现走位问题 ✅</li>';
}

function renderInspector() {
  const box = $('#inspector');
  if (!selection.length) { box.innerHTML = '<p class="muted">未选中任何对象</p>'; return; }
  const s = selection[0];
  if (s.kind === 'placement') {
    const beat = beatById(s.beatId);
    const p = doc.placements.find((q) => q.beat_id === s.beatId && q.actor_id === s.actorId);
    const actor = actorById(s.actorId);
    if (!p || !actor) { box.innerHTML = '<p class="muted">未选中任何对象</p>'; return; }
    box.innerHTML = `
      <label>演员</label><div><b style="color:${actor.color}">${escapeHtml(actor.name)}</b> @ 节点「${escapeHtml(beat.name)}」</div>
      <div class="row">
        <label>X(m) <input type="number" step="0.1" id="inspX" value="${p.x.toFixed(2)}"></label>
        <label>Y(m) <input type="number" step="0.1" id="inspY" value="${p.y.toFixed(2)}"></label>
      </div>
      <label>朝向（0°=朝观众，90°=舞台右，180°=台后）
        <input type="number" step="5" id="inspF" value="${Math.round(p.facing)}"></label>
      <input type="range" min="-180" max="180" step="5" id="inspFR" value="${Math.round(p.facing)}">
      <button class="act" id="inspRemove">移出本节点</button>`;
    const fx = $('#inspX'), fy = $('#inspY'), ff = $('#inspF'), ffr = $('#inspFR');
    const apply = () => { beginInteraction(); p.x = clamp(parseFloat(fx.value) || 0, 0, doc.stage.width); p.y = clamp(parseFloat(fy.value) || 0, 0, doc.stage.height); p.facing = parseFloat(ff.value) || 0; ffr.value = p.facing; endInteraction(); };
    fx.addEventListener('change', apply); fy.addEventListener('change', apply);
    ff.addEventListener('change', () => { ffr.value = ff.value; apply(); });
    ffr.addEventListener('input', () => { ff.value = ffr.value; p.facing = parseFloat(ffr.value); analyze(); draw(); });
    ffr.addEventListener('change', () => commit());
    $('#inspRemove').addEventListener('click', () => removePlacement(beat.id, actor.id));
  } else if (s.kind === 'region') {
    const r = doc.regions.find((q) => q.id === s.id);
    box.innerHTML = `
      <label>名称 <input type="text" id="inspRName" value="${escapeHtml(r.name)}"></label>
      <label>类型
        <select id="inspRKind"><option value="area">普通区域</option><option value="obstacle"${r.kind === 'obstacle' ? ' selected' : ''}>障碍（不可穿越）</option></select>
      </label>
      <label>颜色 <input type="color" id="inspRColor" value="${r.kind === 'obstacle' ? '#d9534f' : r.color}"></label>
      <p class="muted">在画布上拖动顶点可调整形状（至少 3 个顶点）。</p>
      <button class="act" id="inspRDel">删除区域</button>`;
    $('#inspRName').addEventListener('change', (e) => { r.name = e.target.value || r.name; commit(); });
    $('#inspRKind').addEventListener('change', (e) => { r.kind = e.target.value; commit(); });
    $('#inspRColor').addEventListener('change', (e) => { r.color = e.target.value; commit(); });
    $('#inspRDel').addEventListener('click', () => deleteRegion(r.id));
  } else if (s.kind === 'beat') {
    const b = beatById(s.id);
    if (b) {
      const scene = sceneById(b.scene_id);
      box.innerHTML = `
        <label>所属场景</label><div>${scene ? escapeHtml(scene.name) : '—'}</div>
        <label>节点名称 <input type="text" id="inspBName" value="${escapeHtml(b.name)}"></label>
        <label>到位时间（秒） <input type="number" id="inspBTime" step="0.5" min="0" value="${b.time}"></label>
        <button class="act" id="inspBDup">复制此节点（含走位）</button>
        <button class="act" id="inspBDel">删除节点</button>`;
      $('#inspBName').addEventListener('change', (e) => { b.name = e.target.value || b.name; commit(); });
      $('#inspBTime').addEventListener('change', (e) => { b.time = Math.max(0, parseFloat(e.target.value) || 0); commit(); });
      $('#inspBDup').addEventListener('click', () => duplicateBeat(b.id));
      $('#inspBDel').addEventListener('click', () => deleteBeat(b.id));
    }
  } else if (s.kind === 'actor') {
    const a = actorById(s.id);
    box.innerHTML = `
      <label>姓名 <input type="text" id="inspAName" value="${escapeHtml(a.name)}"></label>
      <label>常用步速 (m/s) <input type="number" id="inspASpeed" step="0.05" min="0.1" value="${a.speed}"></label>
      <label>颜色 <input type="color" id="inspAColor" value="${a.color}"></label>
      <button class="act" id="inspADel">删除演员（连同其全部走位）</button>`;
    $('#inspAName').addEventListener('change', (e) => { a.name = e.target.value || a.name; commit(); });
    $('#inspASpeed').addEventListener('change', (e) => { a.speed = clamp(parseFloat(e.target.value) || 1.2, 0.1, 10); commit(); });
    $('#inspAColor').addEventListener('change', (e) => { a.color = e.target.value; commit(); });
    $('#inspADel').addEventListener('click', () => deleteActor(a.id));
  }
}

// ---------------------------------------------------------------- 增删操作
function addActor() {
  beginInteraction();
  const a = { id: uid('a'), name: `演员 ${doc.actors.length + 1}`,
    speed: 1.2, color: ACTOR_COLORS[doc.actors.length % ACTOR_COLORS.length] };
  doc.actors.push(a);
  selection = [{ kind: 'actor', id: a.id }];
  endInteraction();
}
function deleteActor(id) {
  if (!confirm('删除该演员及其全部走位与路径？')) return;
  beginInteraction();
  rawDeleteActor(id);
  selection = selection.filter((s) => !(s.kind === 'actor' && s.id === id));
  endInteraction();
}
function deleteRegion(id) {
  beginInteraction();
  doc.regions = doc.regions.filter((r) => r.id !== id);
  selection = selection.filter((s) => s.kind !== 'region' || s.id !== id);
  endInteraction();
}
function removePlacement(beatId, actorId) {
  doc.placements = doc.placements.filter((p) => !(p.beat_id === beatId && p.actor_id === actorId));
  doc.paths = doc.paths.filter((p) => p.actor_id !== actorId || (p.to_beat_id !== beatId && p.from_beat_id !== beatId));
  selection = selection.filter((s) => !(s.kind === 'placement' && s.beatId === beatId && s.actorId === actorId));
}
function addBeat(sceneId) {
  beginInteraction();
  const sceneBeats = doc.beats.filter((b) => b.scene_id === sceneId).sort((a, b) => a.position - b.position);
  const last = sceneBeats[sceneBeats.length - 1];
  const maxPos = doc.beats.reduce((m, b) => Math.max(m, b.position), 0);
  const beat = {
    id: uid('b'), scene_id: sceneId,
    name: `节点 ${doc.beats.length + 1}`,
    position: maxPos + 1,
    time: last ? last.time + 5 : 0,
  };
  doc.beats.push(beat);
  currentBeatId = beat.id;
  endInteraction();
}
function deleteBeat(id) {
  const b = beatById(id);
  if (!b || !confirm(`删除节点「${b.name}」？`)) return;
  beginInteraction();
  doc.beats = doc.beats.filter((x) => x.id !== id);
  doc.placements = doc.placements.filter((p) => p.beat_id !== id);
  doc.paths = doc.paths.filter((p) => p.from_beat_id !== id && p.to_beat_id !== id);
  if (currentBeatId === id) currentBeatId = doc.beats[0]?.id || null;
  endInteraction();
}
function deleteScene(id) {
  beginInteraction();
  const beatIds = new Set(doc.beats.filter((b) => b.scene_id === id).map((b) => b.id));
  doc.beats = doc.beats.filter((b) => b.scene_id !== id);
  doc.placements = doc.placements.filter((p) => !beatIds.has(p.beat_id));
  doc.paths = doc.paths.filter((p) => !beatIds.has(p.from_beat_id) && !beatIds.has(p.to_beat_id));
  doc.scenes = doc.scenes.filter((s) => s.id !== id);
  if (!doc.scenes.length) currentBeatId = null;
  endInteraction();
}
function addScene() {
  beginInteraction();
  const maxPos = doc.beats.reduce((m, b) => Math.max(m, b.position), 0);
  const scene = { id: uid('s'), name: `第 ${doc.scenes.length + 1} 幕`, position: doc.scenes.length };
  const beat = { id: uid('b'), scene_id: scene.id, name: `节点 1`, position: maxPos + 1, time: 0 };
  doc.scenes.push(scene);
  doc.beats.push(beat);
  currentBeatId = beat.id;
  endInteraction();
}
function reorderBeat(beatId, beforeId, sceneId) {
  const beat = beatById(beatId);
  if (!beat) return;
  beginInteraction();
  beat.scene_id = sceneId;
  // 按场景内目标顺序重排，position 全局重新编号
  const sceneGroups = {};
  for (const s of doc.scenes) sceneGroups[s.id] = beatsSorted().filter((b) => b.scene_id === s.id && b.id !== beatId);
  const target = sceneGroups[sceneId];
  const idx = beforeId ? target.findIndex((b) => b.id === beforeId) : target.length;
  target.splice(Math.max(0, idx), 0, beat);
  let pos = 1;
  for (const s of doc.scenes) for (const b of sceneGroups[s.id]) b.position = pos++;
  endInteraction();
}

// 复制当前节点（节点复制：含全部走位与来向路径）
function duplicateBeat(beatId) {
  const src = beatById(beatId || currentBeatId);
  if (!src) return;
  beginInteraction();
  const nb = { id: uid('b'), scene_id: src.scene_id, name: src.name + ' 副本',
    position: src.position + 1, time: src.time + 5 };
  doc.beats.push(nb);
  // 原 src 之后的节点 position+1
  for (const b of doc.beats) if (b.id !== nb.id && b.position >= nb.position) b.position += 1;
  const idMap = {};
  for (const p of placementsOf(src.id)) {
    const np = { id: uid('pl'), beat_id: nb.id, actor_id: p.actor_id, x: p.x, y: p.y, facing: p.facing };
    idMap[p.actor_id] = np;
    doc.placements.push(np);
  }
  // 复制来向路径（prev → src 变成 src → 副本）
  for (const path of doc.paths.filter((q) => q.to_beat_id === src.id)) {
    doc.paths.push({ id: uid('p'), from_beat_id: src.id, to_beat_id: nb.id,
      actor_id: path.actor_id, points: path.points.map((q) => [...q]) });
  }
  currentBeatId = nb.id;
  endInteraction();
}

function deleteSelection() {
  if (drawing) { cancelDrawing(); return; }
  if (!selection.length) return;
  const actorSel = selection.filter((s) => s.kind === 'actor');
  if (actorSel.length && !confirm('删除选中的演员及其全部走位？')) return;
  beginInteraction();
  const removedBeats = new Set();
  for (const s of selection) {
    if (s.kind === 'region') {
      doc.regions = doc.regions.filter((r) => r.id !== s.id);
    } else if (s.kind === 'placement') {
      removePlacement(s.beatId, s.actorId);
    } else if (s.kind === 'anchor') {
      deleteAnchorRaw(s);
    } else if (s.kind === 'actor') {
      rawDeleteActor(s.id);
    } else if (s.kind === 'beat') {
      removedBeats.add(s.id);
    }
  }
  if (removedBeats.size) {
    doc.beats = doc.beats.filter((b) => !removedBeats.has(b.id));
    doc.placements = doc.placements.filter((p) => !removedBeats.has(p.beat_id));
    doc.paths = doc.paths.filter((p) => !removedBeats.has(p.from_beat_id) && !removedBeats.has(p.to_beat_id));
    if (removedBeats.has(currentBeatId)) currentBeatId = doc.beats[0]?.id || null;
  }
  selection = [];
  endInteraction();
}

// ---------------------------------------------------------------- 节点选择 / 定位
function selectBeat(id) {
  currentBeatId = id;
  selection = [{ kind: 'beat', id }];
  stopPlayback();
  renderSceneList(); draw(); renderInspector();
}
function placeActorAt(actorId, x, y) {
  const beat = beatById(currentBeatId);
  if (!beat) { alert('请先在右侧创建并选择一个场景节点'); return; }
  beginInteraction();
  let p = doc.placements.find((q) => q.beat_id === beat.id && q.actor_id === actorId);
  if (!p) {
    p = { id: uid('pl'), beat_id: beat.id, actor_id: actorId, x, y, facing: 0 };
    doc.placements.push(p);
  } else {
    p.x = x; p.y = y;
  }
  selection = [{ kind: 'placement', beatId: beat.id, actorId }];
  endInteraction();
}
function centerOn(x, y) {
  const r = canvas.getBoundingClientRect();
  view.ox = r.width / 2 - x * view.scale;
  view.oy = r.height / 2 - y * view.scale;
  draw();
}
function locateProblem(p) {
  stopPlayback();
  if (p.beat_id) currentBeatId = p.beat_id;
  const target = p.midpoint || [p.x, p.y];
  if (target) {
    centerOn(target[0], target[1]);
    flash = { x: target[0], y: target[1], until: performance.now() + 1600 };
    animateFlash();
  }
  if (p.actor_id && p.beat_id) {
    selection = [{ kind: 'placement', beatId: p.beat_id, actorId: p.actor_id }];
  }
  renderSceneList(); renderInspector();
}
function animateFlash() {
  if (!flash || performance.now() >= flash.until) { flash = null; draw(); return; }
  draw();
  requestAnimationFrame(animateFlash);
}
function drawFlash() {
  ctx.save();
  const r = canvas.getBoundingClientRect();
  const sx = flash.x * view.scale + view.ox, sy = flash.y * view.scale + view.oy;
  const k = (flash.until - performance.now()) / 1600;
  ctx.strokeStyle = `rgba(217,83,79,${0.4 + k * 0.6})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(sx, sy, 18 + (1 - k) * 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- 保存 / 舞台管理
async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    let msg = `请求失败 ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}
async function saveDoc(silent) {
  if (!doc) return;
  $('#saveState').textContent = '保存中…';
  try {
    doc = await api(`/api/stages/${doc.stage.id}`, { method: 'PUT', body: JSON.stringify(doc) });
    dirty = false; updateSaveState();
    await loadStageList(false);
    if (!silent) { $('#saveState').textContent = '已保存 ✓'; setTimeout(updateSaveState, 1500); }
  } catch (e) {
    $('#saveState').textContent = '保存失败';
    alert('保存失败：' + e.message);
  }
}
function updateSaveState() {
  const el = $('#saveState');
  if (el) el.textContent = dirty ? '有未保存修改 ●' : '';
}
async function loadStageList(reloadCurrent = true) {
  stages = await api('/api/stages');
  const sel = $('#stageSelect');
  sel.innerHTML = '';
  if (!stages.length) {
    sel.innerHTML = '<option value="">（尚未创建舞台）</option>';
  } else {
    for (const s of stages) sel.innerHTML += `<option value="${s.id}">${escapeHtml(s.name)}（${s.width}×${s.height}m）</option>`;
    sel.value = doc ? doc.stage.id : stages[0].id;
  }
}
async function openStage(id) {
  if (!id) return;
  if (dirty && !confirm('当前有未保存修改，切换将丢失，确定继续？')) { $('#stageSelect').value = doc.stage.id; return; }
  doc = await api(`/api/stages/${id}`);
  afterLoad();
}
function afterLoad() {
  currentBeatId = doc.beats[0]?.id || null;
  selection = [];
  drawing = null; $('#drawBar').classList.add('hidden');
  stopPlayback();
  $('#stageName').value = doc.stage.name;
  $('#stageW').value = doc.stage.width;
  $('#stageH').value = doc.stage.height;
  fitView();
  resetHistory();
  refresh();
  const [t0, t1] = timeRange();
  $('#timeScrub').value = 0; $('#timeLabel').textContent = t0.toFixed(1) + 's';
}
async function newStage() {
  const name = prompt('舞台名称', `舞台 ${stages.length + 1}`);
  if (name === null) return;
  const w = parseFloat(prompt('舞台宽度（米）', '12'));
  if (isNaN(w)) return;
  const h = parseFloat(prompt('舞台深度（米）', '8'));
  if (isNaN(h)) return;
  const created = await api('/api/stages', { method: 'POST', body: JSON.stringify({ name: name || '未命名舞台', width: w, height: h }) });
  // 预置一个场景与一个节点
  const scene = { id: uid('s'), name: '第一幕', position: 0 };
  const beat = { id: uid('b'), scene_id: scene.id, name: '节点 1', position: 1, time: 0 };
  created.scenes = [scene]; created.beats = [beat];
  doc = created;
  await saveDoc(true);
  await loadStageList();
  $('#stageSelect').value = doc.stage.id;
  afterLoad();
}

// ---------------------------------------------------------------- 工具按钮 / 快捷键
document.querySelectorAll('.tools button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (drawing) cancelDrawing();
    tool = btn.dataset.tool;
    document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('active', b === btn));
    const hints = {
      select: '拖动演员标记安排位置；从左栏拖演员到画布上台（或双击画布）；空白处框选，Shift 多选；滚轮缩放，空格拖动画布平移。',
      area: '在舞台上依次点击添加顶点，Enter / 完成按钮闭合区域。',
      obstacle: '在舞台上依次点击绘制障碍，演员路径穿越障碍会被标出。',
      path: '点击路径线段添加弯折锚点并拖动；右键锚点删除。路径仅在同场景相邻节点间存在。',
    };
    $('#toolHint').textContent = hints[tool];
    selection = [];
    refresh();
  });
});

$('#addActorBtn').addEventListener('click', addActor);
$('#addSceneBtn').addEventListener('click', addScene);
$('#saveBtn').addEventListener('click', () => saveDoc(false));
$('#newStageBtn').addEventListener('click', newStage);
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#copyBtn').addEventListener('click', () => duplicateBeat());
$('#deleteBtn').addEventListener('click', deleteSelection);
$('#stageSelect').addEventListener('change', (e) => openStage(e.target.value));
$('#zoomInBtn').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); });
$('#zoomOutBtn').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); });
$('#zoomFitBtn').addEventListener('click', () => { fitView(); draw(); });

$('#stageName').addEventListener('change', (e) => { doc.stage.name = e.target.value || doc.stage.name; commit(); });
$('#stageW').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0.5) { doc.stage.width = v; commit(); fitView(); }
});
$('#stageH').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0.5) { doc.stage.height = v; commit(); fitView(); }
});

// 时间轴
$('#timeScrub').addEventListener('input', (e) => {
  const [t0, t1] = timeRange();
  setPlayTime(t0 + (e.target.value / 1000) * (t1 - t0));
});
$('#playBtn').addEventListener('click', () => {
  if (play.playing) { play.playing = false; $('#playBtn').textContent = '▶'; return; }
  if (!play.active) { const [t0] = timeRange(); setPlayTime(t0); }
  play.playing = true; play.last = performance.now();
  $('#playBtn').textContent = '⏸';
  const tick = (now) => {
    if (!play.playing) return;
    const dt = (now - play.last) / 1000; play.last = now;
    const [, t1] = timeRange();
    let t = play.t + dt;
    if (t >= t1) { t = t1; play.playing = false; $('#playBtn').textContent = '▶'; }
    setPlayTime(t);
    if (play.playing) play.raf = requestAnimationFrame(tick);
  };
  play.raf = requestAnimationFrame(tick);
});
$('#compareChk').addEventListener('change', (e) => { compareOn = e.target.checked; draw(); });

// 打印：先保存再打开服务端渲染页
async function openPrint(kind) {
  if (dirty) await saveDoc(true);
  if (!doc) return;
  window.open(`/print/stages/${doc.stage.id}/${kind}`, '_blank');
}
$('#printCuesBtn').addEventListener('click', () => openPrint('cues'));
$('#printOverviewBtn').addEventListener('click', () => openPrint('overview'));

window.addEventListener('keydown', (e) => {
  keys[e.key === ' ' ? ' ' : e.key.toLowerCase()] = true;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (typing) return;
  if (e.key === 'Enter' && drawing) { finishDrawing(); e.preventDefault(); return; }
  if (e.key === 'Escape') { if (drawing) cancelDrawing(); else stopPlayback(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { redo(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { duplicateBeat(); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { saveDoc(false); e.preventDefault(); return; }
  if (e.key === '+' || e.key === '=') { const r = canvas.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); }
  if (e.key === '-') { const r = canvas.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); }
});
window.addEventListener('keyup', (e) => { keys[e.key === ' ' ? ' ' : e.key.toLowerCase()] = false; });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- 初始化
async function init() {
  window.addEventListener('resize', resizeCanvas);
  await loadStageList();
  const id = window.INITIAL_STAGE_ID || stages[0]?.id;
  if (id) {
    doc = await api(`/api/stages/${id}`);
    afterLoad();
  } else {
    doc = { stage: { id: '', name: '请先新建舞台', width: 12, height: 8 },
      regions: [], actors: [], scenes: [], beats: [], placements: [], paths: [] };
    fitView(); resizeCanvas();
  }
  resizeCanvas();
}
init();
