/* 排练实录与复盘前端。
 * 依赖 app.js 暴露的全局：doc, api, uid, escapeHtml, clamp, dist, polyLen,
 * beatsSorted, actorById(仅限编排文档), appMode, resizeCanvas 等。
 * 排练画布使用自身的快照文档（rec.snapshot），不改动原编排 doc。
 */
'use strict';

// ================================================================ 工具
const r$ = (sel) => document.querySelector(sel);
const fmt = (t) => (t === null || t === undefined) ? '—' : `${Number(t).toFixed(1)}s`;
const fmtSigned = (t) => (t === null || t === undefined) ? '—' : `${t >= 0 ? '+' : ''}${Number(t).toFixed(1)}s`;
const nowIso = () => new Date().toISOString();
const isoAge = (iso) => iso ? (Date.now() - Date.parse(iso)) / 1000 : 0;
function debounce(fn, ms) {
  let h = null;
  return (...args) => { window.clearTimeout(h); h = window.setTimeout(() => fn(...args), ms); };
}
function docActors(snap) { return snap.actors; }
function sceneBeatsOf(snap, sceneId) {
  return snap.beats.filter((b) => b.scene_id === sceneId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}
function snapActor(snap, id) { return snap.actors.find((a) => a.id === id); }
function snapBeat(snap, id) { return snap.beats.find((b) => b.id === id); }
function planPlacement(snap, beatId, actorId) {
  return (snap.placements || []).find((p) => p.beat_id === beatId && p.actor_id === actorId);
}
function planPath(snap, fromId, toId, actorId) {
  return (snap.paths || []).find((p) => p.from_beat_id === fromId && p.to_beat_id === toId && p.actor_id === actorId);
}
function fullPathSnap(snap, prev, beat, actorId) {
  const a = planPlacement(snap, prev.id, actorId);
  const b = planPlacement(snap, beat.id, actorId);
  if (!a || !b) return null;
  const p = planPath(snap, prev.id, beat.id, actorId);
  return [[a.x, a.y], ...(p ? p.points.map((q) => [...q]) : []), [b.x, b.y]];
}

// 快照场景内某演员的计划轨迹（与 app.js positionAtSceneTime 同规则）
function planPositionAt(snap, sceneId, actorId, t) {
  const sb = sceneBeatsOf(snap, sceneId);
  const apps = sb
    .map((b) => ({ b, p: planPlacement(snap, b.id, actorId) }))
    .filter((x) => x.p)
    .sort((x, y) => x.b.time - y.b.time);
  if (!apps.length || t < apps[0].b.time - 1e-6 || t > apps[apps.length - 1].b.time + 1e-6) return null;
  if (t <= apps[0].b.time) return [apps[0].p.x, apps[0].p.y, apps[0].p.facing || 0];
  if (t >= apps[apps.length - 1].b.time) { const l = apps[apps.length - 1].p; return [l.x, l.y, l.facing || 0]; }
  for (let i = 0; i < apps.length - 1; i++) {
    const a = apps[i], b = apps[i + 1];
    if (a.b.time <= t && t <= b.b.time) {
      const pts = fullPathSnap(snap, a.b, b.b, actorId) || [[a.p.x, a.p.y], [b.p.x, b.p.y]];
      const total = polyLen(pts), dt = b.b.time - a.b.time;
      const want = total * (dt > 0 ? (t - a.b.time) / dt : 1);
      let acc = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        const seg = dist(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
        if (acc + seg >= want) {
          const r = seg > 0 ? (want - acc) / seg : 0;
          const f = (a.p.facing || 0) + ((b.p.facing || 0) - (a.p.facing || 0)) * (dt > 0 ? (t - a.b.time) / dt : 1);
          return [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * r,
                  pts[k][1] + (pts[k + 1][1] - pts[k][1]) * r, f];
        }
        acc += seg;
      }
      return [b.p.x, b.p.y, b.p.facing || 0];
    }
  }
  return null;
}

// ================================================================ 轻量舞台画布
/** 生成一个绑定到 canvas 的快照画布视图。opts: { zoomEl, onPointerDown(info, w, e) } */
function makeStageView(canvasEl, opts = {}) {
  const v = {
    canvas: canvasEl, ctx: canvasEl.getContext('2d'),
    snap: null, view: { scale: 40, ox: 60, oy: 40 },
    hatch: null, pan: null, drag: null,
  };
  function fit() {
    if (!v.snap) return;
    const wrap = canvasEl.parentElement.getBoundingClientRect();
    const W = v.snap.stage.width, H = v.snap.stage.height;
    v.view.scale = clamp(Math.min((wrap.width - 80) / W, (wrap.height - 80) / H), 5, 400);
    v.view.ox = (wrap.width - W * v.view.scale) / 2;
    v.view.oy = (wrap.height - H * v.view.scale) / 2;
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvasEl.parentElement.getBoundingClientRect();
    canvasEl.width = Math.max(50, r.width * dpr);
    canvasEl.height = Math.max(50, r.height * dpr);
    canvasEl.style.width = r.width + 'px';
    canvasEl.style.height = r.height + 'px';
    v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    v.hatch = null;
    draw();
  }
  function toWorld(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: (e.clientX - r.left - v.view.ox) / v.view.scale,
             y: (e.clientY - r.top - v.view.oy) / v.view.scale };
  }
  function zoomAt(factor, sx, sy) {
    const ns = clamp(v.view.scale * factor, 5, 400);
    const k = ns / v.view.scale;
    v.view.ox = sx - (sx - v.view.ox) * k;
    v.view.oy = sy - (sy - v.view.oy) * k;
    v.view.scale = ns;
    draw();
  }
  function hatchPattern() {
    if (v.hatch) return v.hatch;
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(181,56,52,.55)';
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.stroke();
    v.hatch = v.ctx.createPattern(c, 'repeat');
    return v.hatch;
  }

  function drawBase(W, H) {
    const ctx = v.ctx;
    ctx.fillStyle = '#fbf7ee';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e7e0d2';
    ctx.lineWidth = 1 / v.view.scale;
    ctx.beginPath();
    for (let x = 1; x < W; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 1; y < H; y++) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    for (const r0 of v.snap.regions) {
      const pts = r0.points;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      if (r0.kind === 'obstacle') {
        ctx.fillStyle = 'rgba(217,83,79,.18)';
        ctx.fill();
        ctx.save(); ctx.clip();
        ctx.fillStyle = hatchPattern();
        ctx.fillRect(-2, -2, W + 4, H + 4);
        ctx.restore();
        ctx.strokeStyle = '#b53834';
      } else {
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = r0.color || '#8ab4f8';
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = r0.color || '#2f6fb3';
      }
      ctx.lineWidth = 1.6 / v.view.scale;
      ctx.stroke();
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      ctx.font = `${11.5 / v.view.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = r0.kind === 'obstacle' ? '#96322e' : '#33506e';
      ctx.fillText(r0.name + (r0.kind === 'obstacle' ? '（障碍）' : ''), cx, cy);
    }
  }
  function frameBorder(W, H) {
    const ctx = v.ctx;
    ctx.strokeStyle = '#33414f';
    ctx.lineWidth = 2.5 / v.view.scale;
    ctx.strokeRect(0, 0, W, H);
    ctx.setLineDash([0.25, 0.15]);
    ctx.strokeStyle = '#33414f';
    ctx.beginPath(); ctx.moveTo(0, H + 0.06); ctx.lineTo(W, H + 0.06); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#5a6b7c';
    ctx.font = `${13 / v.view.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('观 众 席', W / 2, H + 0.38);
  }
  function marker(x, y, actor, o = {}) {
    const ctx = v.ctx, r = o.radius || 0.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (o.ghost) {
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.fill();
      ctx.lineWidth = (o.sel ? 3.4 : 2) / v.view.scale;
      ctx.strokeStyle = actor.color;
      ctx.setLineDash([0.12, 0.08]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = o.fill || actor.color;
      ctx.fill();
      ctx.lineWidth = (o.sel ? 3.4 : 2) / v.view.scale;
      ctx.strokeStyle = o.stroke || '#ffffff';
      ctx.stroke();
    }
    if (o.absent) {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.7, y - r * 0.7); ctx.lineTo(x + r * 0.7, y + r * 0.7);
      ctx.moveTo(x + r * 0.7, y - r * 0.7); ctx.lineTo(x - r * 0.7, y + r * 0.7);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.4 / v.view.scale;
      ctx.stroke();
    }
    const f = (o.facing || 0) * Math.PI / 180;
    const dx = Math.sin(f), dy = Math.cos(f);
    ctx.beginPath();
    ctx.moveTo(x + dx * (r + 0.04), y + dy * (r + 0.04));
    ctx.lineTo(x + dx * (r + 0.3), y + dy * (r + 0.3));
    ctx.strokeStyle = o.ghost ? actor.color : '#23303d';
    ctx.lineWidth = 2 / v.view.scale;
    ctx.stroke();
    if (o.label) {
      ctx.font = `${10.5 / v.view.scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = o.labelColor || '#23303d';
      ctx.fillText(o.label, x, y - (o.labelDy ?? 0.42));
    }
  }
  function connector(ax, ay, bx, by, color, dashed) {
    const ctx = v.ctx;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4 / v.view.scale;
    if (dashed) ctx.setLineDash([0.16, 0.1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function startFrame() {
    if (!v.snap) return null;
    const W = v.snap.stage.width, H = v.snap.stage.height;
    const ctx = v.ctx;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.save();
    ctx.translate(v.view.ox, v.view.oy);
    ctx.scale(v.view.scale, v.view.scale);
    drawBase(W, H);
    return { W, H, ctx, end: () => { frameBorder(W, H); ctx.restore(); } };
  }
  function draw() { /* 由外部覆盖：v.draw = custom */ if (v.customDraw) v.customDraw(v); }

  // 指针：中键/空格平移；左键交给 opts.onPointerDown(info,w,e)，
  // info 由 opts.hitTest(w) 给出；拖动交给 opts.onDragMove/onDragEnd。
  canvasEl.addEventListener('mousedown', (e) => {
    if (!v.snap) return;
    if (e.button === 1 || (e.button === 0 && opts.spacePan && opts.spacePan())) {
      v.pan = { sx: e.clientX, sy: e.clientY, ox: v.view.ox, oy: v.view.oy };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const w = toWorld(e);
    w.x = clamp(w.x, 0, v.snap.stage.width);
    w.y = clamp(w.y, 0, v.snap.stage.height);
    const info = opts.hitTest ? opts.hitTest(w, v) : null;
    v.drag = { info, start: w, moved: false };
    if (opts.onPointerDown) opts.onPointerDown(info, w, e, v);
  });
  window.addEventListener('mousemove', (e) => {
    if (v.pan) {
      v.view.ox = v.pan.ox + (e.clientX - v.pan.sx);
      v.view.oy = v.pan.oy + (e.clientY - v.pan.sy);
      draw();
      return;
    }
    if (v.drag) {
      const w = toWorld(e);
      w.x = clamp(w.x, 0, v.snap.stage.width);
      w.y = clamp(w.y, 0, v.snap.stage.height);
      if (dist(w.x, w.y, v.drag.start.x, v.drag.start.y) > 0.05) v.drag.moved = true;
      if (opts.onDragMove) opts.onDragMove(v.drag.info, w, v.drag, v);
    }
  });
  window.addEventListener('mouseup', () => {
    if (v.pan) { v.pan = null; return; }
    if (v.drag) {
      if (opts.onDragEnd) opts.onDragEnd(v.drag.info, v.drag, v);
      v.drag = null;
    }
  });
  canvasEl.addEventListener('wheel', (e) => {
    if (!v.snap) return;
    e.preventDefault();
    const r = canvasEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  v.fit = fit; v.resize = resize; v.draw = draw; v.marker = marker;
  v.connector = connector; v.startFrame = startFrame; v.toWorld = toWorld;
  v.zoomAt = zoomAt;
  return v;
}

// ================================================================ 模式切换
let mode = 'plan';
const modeButtons = document.querySelectorAll('#modeTabs .mtab');
modeButtons.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

function setMode(next) {
  mode = next;
  if (typeof appMode !== 'undefined') appMode = next;
  modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  r$('#planView').classList.toggle('hidden', next !== 'plan');
  r$('#rehearseView').classList.toggle('hidden', next !== 'rehearse');
  r$('#reviewView').classList.toggle('hidden', next !== 'review');
  const coView = document.getElementById('changeoverView');
  if (coView) coView.classList.toggle('hidden', next !== 'changeover');
  document.querySelectorAll('.plan-only').forEach((el) => el.classList.toggle('hidden', next !== 'plan'));
  document.querySelectorAll('.co-only').forEach((el) => el.classList.toggle('hidden', next !== 'changeover'));
  r$('#printReviewBtn').classList.toggle('hidden', next !== 'review');
  if (next === 'plan') {
    window.dispatchEvent(new Event('resize'));
  } else if (next === 'rehearse') {
    enterRehearseMode();
  } else if (next === 'review') {
    enterReviewMode();
  }
  // 换景模式由 changeover.js 监听同一批按钮自行进入
}

function requireDoc(alertMsg) {
  if (!doc || !doc.stage || !doc.stage.id) { alert(alertMsg || '请先新建或选择舞台'); return false; }
  return true;
}

// 舞台下拉变化时刷新两个模式的数据（app.js openStage 会改 doc）
r$('#stageSelect').addEventListener('change', () => {
  rehearsalListCache = [];
  if (mode === 'rehearse') enterRehearseMode();
  if (mode === 'review') enterReviewMode();
});

// ################################################################
// #                                                              #
// #                     排练实录模式                             #
// #                                                              #
// ################################################################
let R = null;                 // 当前运行的排练记录（含 snapshot）
let rehearsalListCache = [];
let rhView = null;
let rhTicker = null;
let rhSaving = false;
let rhSaveQueued = false;
let rhLocalRev = 0;         // 本地打点数据版本：每次有本地改动 +1
const rhSave = debounce(() => saveRehearsal(), 800);

function rhClockNow() {
  if (!R.clock_running) return R.clock_elapsed;
  return R.clock_elapsed + isoAge(R.clock_at);
}
function beatMark(bid) { return R.beat_marks.find((m) => m.beat_id === bid); }
function actorMark(bid, aid) {
  return R.actor_marks.find((m) => m.beat_id === bid && m.actor_id === aid);
}
function rhBeats() { return sceneBeatsOf(R.snapshot, R.scene_id); }
function rhPlannedActors(beatId) {
  // 快照中该节点有计划走位的演员（按演员表顺序）
  return R.snapshot.actors.filter((a) => planPlacement(R.snapshot, beatId, a.id));
}

async function enterRehearseMode() {
  if (!requireDoc()) return;
  fillRhSceneSelect();
  await loadRehearsalList();
  if (R && R.stage_id === doc.stage.id) {
    openRehearsalRuntime(R);
  } else {
    R = null;
    r$('#rhRunPanel').classList.add('hidden');
    r$('#rhBeatPanel').classList.add('hidden');
  }
  if (!rhView) {
    rhView = makeStageView(r$('#rhCanvas'), {
      spacePan: () => rhKeys[' '],
      hitTest: rhHitTest,
      onPointerDown: rhPointerDown,
      onDragMove: rhDragMove,
      onDragEnd: rhDragEnd,
    });
    r$('#rhZoomIn').addEventListener('click', () => rhZoom(1.2));
    r$('#rhZoomOut').addEventListener('click', () => rhZoom(1 / 1.2));
    r$('#rhZoomFit').addEventListener('click', () => { rhView.fit(); rhView.draw(); });
  }
  requestAnimationFrame(() => { if (rhView) { rhView.resize(); } });
}

function fillRhSceneSelect() {
  const sel = r$('#rhSceneSelect');
  sel.innerHTML = '';
  if (!doc.scenes.length) {
    sel.innerHTML = '<option value="">（请先在编排页创建场景与节点）</option>';
    return;
  }
  for (const s of doc.scenes) {
    const n = doc.beats.filter((b) => b.scene_id === s.id).length;
    sel.innerHTML += `<option value="${s.id}">${escapeHtml(s.name)}（${n} 节点）</option>`;
  }
}

async function loadRehearsalList() {
  rehearsalListCache = await api(`/api/stages/${doc.stage.id}/rehearsals`);
  const sel = r$('#rhExisting');
  sel.innerHTML = '<option value="">— 新排练 —</option>';
  for (const r0 of rehearsalListCache) {
    sel.innerHTML += `<option value="${r0.id}">${escapeHtml(r0.name)}（${r0.status === 'finished' ? '已完成' : '进行中'}）</option>`;
  }
  return rehearsalListCache;
}

r$('#rhStartBtn').addEventListener('click', startCountdown);
r$('#rhOpenBtn').addEventListener('click', async () => {
  const id = r$('#rhExisting').value;
  if (!id) return;
  const rec = await api(`/api/rehearsals/${id}`);
  R = rec;
  openRehearsalRuntime(rec);
});

async function startCountdown() {
  if (!requireDoc()) return;
  const sceneId = r$('#rhSceneSelect').value;
  if (!sceneId) { alert('请先在编排页创建场景与节点'); return; }
  let n = Math.max(0, parseInt(r$('#rhCountdown').value, 10) || 0);
  const overlay = r$('#rhOverlay');
  overlay.classList.remove('hidden');
  const sub = r$('#rhOverlaySub');
  sub.textContent = '准备开始排练';
  await new Promise((resolve) => {
    const tick = () => {
      if (n <= 0) {
        r$('#rhCountText').textContent = '开始！';
        setTimeout(() => { overlay.classList.add('hidden'); resolve(); }, 450);
        return;
      }
      r$('#rhCountText').textContent = String(n);
      n--;
      setTimeout(tick, 1000);
    };
    tick();
  });
  const name = (r$('#rhName').value || '').trim();
  const created = await api(`/api/stages/${doc.stage.id}/rehearsals`, {
    method: 'POST',
    body: JSON.stringify({ scene_id: sceneId, name }),
  });
  R = created;
  // 倒计时已结束，此刻起算排练时钟
  R.clock_running = true;
  R.clock_elapsed = 0;
  R.clock_at = nowIso();
  await loadRehearsalList();
  r$('#rhExisting').value = R.id;
  openRehearsalRuntime(R);
  // 立即把起算状态落库（防抖外的首次同步）
  saveRehearsal();
}

function openRehearsalRuntime(rec) {
  R = rec;
  // 刷新时钟：若服务端记录为运行中，则按离线时长延续
  if (R.clock_running && R.clock_at) {
    R.clock_elapsed += isoAge(R.clock_at);
    R.clock_at = nowIso();
  }
  r$('#rhRunPanel').classList.remove('hidden');
  r$('#rhBeatPanel').classList.remove('hidden');
  rhView.snap = R.snapshot;
  rhView.fit();
  renderRhAll();
  startRhTicker();
}

function startRhTicker() {
  if (rhTicker) clearInterval(rhTicker);
  rhTicker = setInterval(() => {
    if (!R) return;
    r$('#rhClock').textContent = rhClockNow().toFixed(1) + 's';
  }, 100);
}

// -------------------------------------------------- 记录节点 / 回退 / 补记
function rhCurrentIndex() {
  // 第一个尚未记录的节点；全部已记录则返回长度
  const beats = rhBeats();
  for (let i = 0; i < beats.length; i++) {
    if (!beatMark(beats[i].id) || beatMark(beats[i].id).actual_time === null) return i;
  }
  return beats.length;
}

function recordCurrentBeat() {
  if (!R || R.status === 'finished') return;
  const beats = rhBeats();
  const idx = rhCurrentIndex();
  if (idx >= beats.length) { flashRhStatus('所有节点已记录，可用「回退节点」修正'); return; }
  const t = +Math.max(0, rhClockNow()).toFixed(1);
  recordBeatAt(beats[idx].id, t);
  flashRhStatus(`已记录节点「${beats[idx].name}」@ ${t.toFixed(1)}s`);
}

function recordBeatAt(beatId, t) {
  let m = beatMark(beatId);
  if (!m) {
    m = { id: uid('bm'), beat_id: beatId, actual_time: t, note: '' };
    R.beat_marks.push(m);
  } else {
    m.actual_time = t;
  }
  // 为该节点有计划走位的演员预建打点行（便于逐人到位）
  for (const a of rhPlannedActors(beatId)) {
    if (!actorMark(beatId, a.id)) {
      R.actor_marks.push({ id: uid('am'), beat_id: beatId, actor_id: a.id,
        actual_time: null, x: null, y: null, absent: false, note: '' });
    }
  }
  renderRhAll();
  scheduleRhSave();
}

function rollbackBeat() {
  if (!R) return;
  const beats = rhBeats();
  // 最后一个已记录节点
  let target = null;
  for (let i = beats.length - 1; i >= 0; i--) {
    const m = beatMark(beats[i].id);
    if (m && m.actual_time !== null) { target = { beat: beats[i], mark: m }; break; }
  }
  if (!target) { flashRhStatus('没有可回退的已记录节点'); return; }
  if (!confirm(`回退节点「${target.beat.name}」？该节点的节点时刻与演员打点都会清空。`)) return;
  target.mark.actual_time = null;
  R.actor_marks = R.actor_marks.filter((m) => m.beat_id !== target.beat.id);
  renderRhAll();
  scheduleRhSave();
}

function makeupBeat() {
  if (!R) return;
  const beats = rhBeats();
  const missing = beats.filter((b) => {
    const m = beatMark(b.id);
    return !m || m.actual_time === null;
  });
  if (!missing.length) { alert('没有漏掉的节点'); return; }
  const labels = missing.map((b, i) => `${i + 1}. ${b.name}（计划 ${(b.time - R.origin).toFixed(1)}s）`).join('\n');
  const pick = prompt(`补记哪个节点？输入序号：\n${labels}`, '1');
  const i = parseInt(pick, 10) - 1;
  if (!(i >= 0 && i < missing.length)) return;
  const cur = rhClockNow();
  const t0 = parseFloat(prompt(`补记时刻（排练时钟秒），当前 ${cur.toFixed(1)}s`, cur.toFixed(1)));
  if (isNaN(t0) || t0 < 0) return;
  recordBeatAt(missing[i].id, +t0.toFixed(1));
  flashRhStatus(`已补记「${missing[i].name}」@ ${t0.toFixed(1)}s`);
}

// -------------------------------------------------- 演员打点 / 缺席 / 修正
function tapActor(beatId, actorId) {
  if (!R || R.status === 'finished') return;
  const t = +Math.max(0, rhClockNow()).toFixed(1);
  let m = actorMark(beatId, actorId);
  if (!m) {
    m = { id: uid('am'), beat_id: beatId, actor_id: actorId,
      actual_time: t, x: null, y: null, absent: false, note: '' };
    R.actor_marks.push(m);
  } else if (m.absent) {
    // 缺席后再次打点 = 到场
    m.absent = false;
    m.actual_time = t;
    flashRhStatus(`「${snapActor(R.snapshot, actorId).name}」到场 @ ${t.toFixed(1)}s`);
  } else if (m.actual_time === null) {
    m.actual_time = t;
    flashRhStatus(`「${snapActor(R.snapshot, actorId).name}」到位 @ ${t.toFixed(1)}s`);
  } else {
    // 误打点修正：再次点击按当前时钟重打
    m.actual_time = t;
    flashRhStatus(`已修正「${snapActor(R.snapshot, actorId).name}」打点为 ${t.toFixed(1)}s`);
  }
  renderRhAll();
  scheduleRhSave();
}

function toggleActorAbsent(beatId, actorId) {
  if (R.status === 'finished') return;
  let m = actorMark(beatId, actorId);
  if (!m) {
    m = { id: uid('am'), beat_id: beatId, actor_id: actorId,
      actual_time: null, x: null, y: null, absent: true, note: '' };
    R.actor_marks.push(m);
  }
  m.absent = m.absent ? false : true;
  if (m.absent) { m.actual_time = null; }
  renderRhAll();
  scheduleRhSave();
}

function deleteActorMark(beatId, actorId) {
  if (R.status === 'finished') return;
  R.actor_marks = R.actor_marks.filter((m) => !(m.beat_id === beatId && m.actor_id === actorId));
  renderRhAll();
  scheduleRhSave();
}

// -------------------------------------------------- 画布命中与拖动
function rhHitTest(w) {
  if (!R) return null;
  const beat = rhWorkingBeat();
  if (!beat) return null;
  // 优先命中实测点（可拖动）
  for (const m of R.actor_marks.filter((q) => q.beat_id === beat.id && q.x !== null && q.y !== null)) {
    if (dist(w.x, w.y, m.x, m.y) <= 0.38) return { kind: 'actual', beatId: beat.id, actorId: m.actor_id };
  }
  // 其次计划点（点击 = 打点到位，带修饰键语义不变）
  for (const a of rhPlannedActors(beat.id)) {
    const p = planPlacement(R.snapshot, beat.id, a.id);
    if (dist(w.x, w.y, p.x, p.y) <= 0.38) return { kind: 'plan', beatId: beat.id, actorId: a.id, plan: p };
  }
  return null;
}

function rhPointerDown(info, w) {
  if (!info || R.status === 'finished') return;
  if (info.kind === 'plan') {
    // 单击（未拖动）= 打点到位；拖动 = 直接记录实测位置
    let m = actorMark(info.beatId, info.actorId);
    if (!m) {
      m = { id: uid('am'), beat_id: info.beatId, actor_id: info.actorId,
        actual_time: +Math.max(0, rhClockNow()).toFixed(1), x: null, y: null, absent: false, note: '' };
      R.actor_marks.push(m);
      scheduleRhSave();
      renderRhPanels();
    }
  }
}

function rhDragMove(info, w, drag) {
  if (!info || !drag.moved || R.status === 'finished') return;
  if (info.kind === 'plan') {
    const m = actorMark(info.beatId, info.actorId);
    if (m) { m.x = +w.x.toFixed(3); m.y = +w.y.toFixed(3); m.absent = false; rhView.draw(); }
  } else if (info.kind === 'actual') {
    const m = actorMark(info.beatId, info.actorId);
    if (m) { m.x = +w.x.toFixed(3); m.y = +w.y.toFixed(3); rhView.draw(); }
  }
}

function rhDragEnd(info, drag) {
  if (!info) return;
  if (drag.moved && (info.kind === 'plan' || info.kind === 'actual')) {
    renderRhPanels();
    scheduleRhSave();
  }
}

function rhZoom(factor) {
  const r = r$('#rhCanvas').getBoundingClientRect();
  rhView.zoomAt(factor, r.width / 2, r.height / 2);
}

// -------------------------------------------------- 当前工作节点
function rhWorkingBeat() {
  const beats = rhBeats();
  const selId = r$('#rhBeatJump').value;
  const selected = beats.find((b) => b.id === selId);
  if (selected) return selected;
  const idx = rhCurrentIndex();
  return beats[Math.min(idx, beats.length - 1)] || null;
}

// -------------------------------------------------- 渲染
function renderRhAll() {
  renderRhPanels();
  renderRhCanvas();
}

function renderRhPanels() {
  const beats = rhBeats();
  const curIdx = rhCurrentIndex();
  const workBeat = rhWorkingBeat();

  // 节点跳转下拉
  const jump = r$('#rhBeatJump');
  const jumpVal = jump.value || (workBeat ? workBeat.id : '');
  jump.innerHTML = beats.map((b) => {
    const m = beatMark(b.id);
    const state = !m || m.actual_time === null ? '○' : '●';
    return `<option value="${b.id}">${state} ${escapeHtml(b.name)}（计划 ${(b.time - R.origin).toFixed(0)}s）</option>`;
  }).join('');
  jump.value = beats.some((b) => b.id === jumpVal) ? jumpVal : (workBeat ? workBeat.id : '');

  // 节点进度列表
  const ul = r$('#rhBeatList');
  ul.innerHTML = '';
  beats.forEach((b, i) => {
    const m = beatMark(b.id);
    const li = document.createElement('li');
    const isCur = i === curIdx;
    const missing = !m || m.actual_time === null;
    if (workBeat && b.id === workBeat.id) li.classList.add('cur');
    if (missing && i < curIdx) li.classList.add('miss');
    const delta = m && m.actual_time !== null ? m.actual_time - (b.time - R.origin) : null;
    li.innerHTML = `<span class="nm">${missing ? '○' : '●'} ${escapeHtml(b.name)}</span>
      <span class="tm">${m && m.actual_time !== null
        ? `${m.actual_time.toFixed(1)} ${fmtSigned(delta)}`
        : `计划 ${(b.time - R.origin).toFixed(1)}s`}</span>
      ${m && m.actual_time !== null ? '<button class="del" title="清空该节点记录">↺</button>' : ''}`;
    li.addEventListener('click', () => { jump.value = b.id; renderRhPanels(); rhView.draw(); });
    const btn = li.querySelector('.del');
    if (btn) btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`清空节点「${b.name}」的记录（含演员打点）？`)) {
        m.actual_time = null;
        R.actor_marks = R.actor_marks.filter((q) => q.beat_id !== b.id);
        renderRhAll(); scheduleRhSave();
      }
    });
    ul.appendChild(li);
  });

  renderRhActorList(workBeat);
  renderRhNotes(workBeat);

  // 控制按钮状态
  const finished = R.status === 'finished';
  r$('#rhRecordBtn').disabled = finished || curIdx >= beats.length;
  r$('#rhPauseBtn').disabled = finished;
  r$('#rhPauseBtn').textContent = R.clock_running ? '⏸ 暂停' : '▶ 继续';
  r$('#rhClock').classList.toggle('paused', !R.clock_running);
  r$('#rhFinishBtn').textContent = finished ? '✓ 已结束（可继续复盘）' : '⏹ 结束排练';
}

function renderRhActorList(workBeat) {
  const ul = r$('#rhActorList');
  ul.innerHTML = '';
  const noteSel = r$('#rhNoteActor');
  const noteVal = noteSel.value;
  noteSel.innerHTML = '';
  if (!workBeat) { ul.innerHTML = '<li class="muted">无工作节点</li>'; return; }
  const planned = rhPlannedActors(workBeat.id);
  if (!planned.length) { ul.innerHTML = '<li class="muted">该节点快照中无演员走位</li>'; }
  planned.forEach((a, i) => {
    const m = actorMark(workBeat.id, a.id);
    const li = document.createElement('li');
    if (m && m.actual_time !== null) li.classList.add('done');
    if (m && m.absent) li.classList.add('absent');
    const plan = planPlacement(R.snapshot, workBeat.id, a.id);
    const delta = m && m.actual_time !== null ? m.actual_time - (workBeat.time - R.origin) : null;
    let posTxt = '';
    if (m && m.x !== null) {
      const d = dist(m.x, m.y, plan.x, plan.y);
      posTxt = ` · 位置Δ${d.toFixed(2)}m`;
    }
    li.innerHTML = `<span class="swatch" style="background:${a.color}"></span>
      <span class="nm">${i + 1}. ${escapeHtml(a.name)}</span>
      <span class="tm">${m && m.actual_time !== null ? `${m.actual_time.toFixed(1)} ${fmtSigned(delta)}${posTxt}`
        : (m && m.absent ? '缺席' : '未到位')}</span>
      <button class="abs" title="标记缺席/到场">${m && m.absent ? '到场' : '缺席'}</button>
      <button class="clr" title="清除该演员打点">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      tapActor(workBeat.id, a.id);
    });
    li.querySelector('.abs').addEventListener('click', (e) => {
      e.stopPropagation(); toggleActorAbsent(workBeat.id, a.id);
    });
    li.querySelector('.clr').addEventListener('click', (e) => {
      e.stopPropagation(); deleteActorMark(workBeat.id, a.id);
    });
    ul.appendChild(li);
    noteSel.innerHTML += `<option value="${a.id}">${escapeHtml(a.name)}</option>`;
  });
  noteSel.value = planned.some((a) => a.id === noteVal) ? noteVal : (planned[0] ? planned[0].id : '');
  // 演员备注
  const am = noteSel.value ? actorMark(workBeat.id, noteSel.value) : null;
  r$('#rhActorNote').value = am ? am.note : '';
  // 节点备注
  const bm = beatMark(workBeat.id);
  r$('#rhBeatNote').value = bm ? bm.note : '';
}

function renderRhNotes(workBeat) {
  r$('#rhNotes').value = R.notes || '';
  if (!workBeat) return;
}

function renderRhCanvas() {
  if (!rhView || !R) return;
  rhView.customDraw = (v) => {
    const f = v.startFrame();
    if (!f) return;
    const beat = rhWorkingBeat();
    if (!beat) { f.end(); return; }
    const { ctx } = f;
    const beats = rhBeats();
    const i = beats.findIndex((b) => b.id === beat.id);
    const prev = i > 0 ? beats[i - 1] : null;

    // 计划路径
    if (prev) {
      for (const a of R.snapshot.actors) {
        const pts = fullPathSnap(R.snapshot, prev, beat, a.id);
        if (!pts) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.strokeStyle = a.color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1.6 / v.view.scale;
        ctx.setLineDash([0.25, 0.15]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    // 计划点（空心）+ 实测点（实心）+ 偏差连线 + 缺席叉
    R.snapshot.actors.forEach((a, idx) => {
      const pl = planPlacement(R.snapshot, beat.id, a.id);
      if (!pl) return;
      const m = actorMark(beat.id, a.id);
      v.marker(pl.x, pl.y, a, { ghost: true, facing: pl.facing || 0,
        label: `${idx + 1} ${a.name}`, labelColor: 'rgba(35,48,61,.85)' });
      if (m && m.absent) {
        // 缺席：在计划点打叉
        v.marker(pl.x, pl.y, { color: '#777' }, { ghost: true, facing: pl.facing || 0, absent: true });
      } else if (m && m.actual_time !== null) {
        if (m.x !== null && m.y !== null) {
          v.connector(pl.x, pl.y, m.x, m.y, '#d05b93', true);
          v.marker(m.x, m.y, { color: '#46a063' }, { facing: pl.facing || 0, sel: true });
        } else {
          // 已打点但未拖动：按计划位置显示绿色实心小点
          v.marker(pl.x, pl.y, { color: '#46a063' }, { facing: pl.facing || 0, radius: 0.18 });
        }
      }
    });
    // 标题
    ctx.fillStyle = 'rgba(20,28,40,.85)';
    ctx.fillRect(0.15, 0.12, Math.max(2.2, beat.name.length * 0.42 + 0.5), 0.5);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${0.3}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`${beat.name} · 计划 ${(beat.time - R.origin).toFixed(1)}s`, 0.3, 0.46);
    f.end();
  };
  rhView.draw();
}

function flashRhStatus(msg) {
  const el = r$('#rhStatus');
  el.textContent = msg;
  clearTimeout(flashRhStatus._t);
  flashRhStatus._t = setTimeout(() => { el.textContent = ''; }, 2600);
}

// -------------------------------------------------- 保存 / 时钟
function buildRhPayload() {
  return {
    name: R.name, notes: R.notes || '', status: R.status,
    clock_elapsed: +rhClockNow().toFixed(2),
    clock_running: R.clock_running,
    clock_at: R.clock_running ? nowIso() : null,
    beat_marks: R.beat_marks.map((m) => ({ id: m.id, beat_id: m.beat_id,
      actual_time: m.actual_time, note: m.note || '' })),
    actor_marks: R.actor_marks.map((m) => ({ id: m.id, beat_id: m.beat_id,
      actor_id: m.actor_id, actual_time: m.actual_time,
      x: m.x, y: m.y, absent: !!m.absent, note: m.note || '' })),
  };
}
function scheduleRhSave() {
  rhLocalRev++;          // 本地有新改动，任何在途的保存响应都已过期
  rhSaveQueued = true;   // 若有 PUT 正在飞行，结束后立即补发一次
  rhSave();
}
async function saveRehearsal() {
  if (!R) return;
  if (rhSaving) { rhSaveQueued = true; return; }
  rhSaving = true;
  const rev = rhLocalRev;
  const rid = R.id;
  try {
    const payload = buildRhPayload();
    // 本地时钟基准在等待期间继续走
    R.clock_elapsed = payload.clock_elapsed;
    R.clock_at = payload.clock_running ? nowIso() : null;
    const saved = await api(`/api/rehearsals/${rid}`, { method: 'PUT', body: JSON.stringify(payload) });
    // 仅当请求期间本地打点没有再变化、且仍停留在同一条排练时，才用回包同步；
    // 否则在途期间新增/删除的打点会被旧响应覆盖（排队补发会携带最新数据）。
    if (R && R.id === rid && rev === rhLocalRev) {
      R.beat_marks = saved.beat_marks;
      R.actor_marks = saved.actor_marks;
    }
  } catch (e) {
    flashRhStatus('保存失败：' + e.message);
  } finally {
    rhSaving = false;
    if (rhSaveQueued && R && R.id === rid) {
      rhSaveQueued = false;
      saveRehearsal();     // 立即用最新本地状态补发，不再等 800ms 防抖
    }
  }
}

r$('#rhRecordBtn').addEventListener('click', recordCurrentBeat);
r$('#rhBackBtn').addEventListener('click', rollbackBeat);
r$('#rhMakeupBtn').addEventListener('click', makeupBeat);
r$('#rhPauseBtn').addEventListener('click', () => {
  if (!R) return;
  if (R.clock_running) {
    R.clock_elapsed = rhClockNow();
    R.clock_running = false;
    R.clock_at = null;
  } else {
    R.clock_running = true;
    R.clock_at = nowIso();
  }
  renderRhPanels();
  scheduleRhSave();
});
r$('#rhFinishBtn').addEventListener('click', async () => {
  if (!R) return;
  if (R.status !== 'finished') {
    if (!confirm('结束本次排练？结束后记录将锁定（复盘仍可查看）。')) return;
    R.status = 'finished';
    R.clock_elapsed = rhClockNow();
    R.clock_running = false;
    R.clock_at = null;
    await saveRehearsal();
    await loadRehearsalList();
  }
  setMode('review');
});
r$('#rhGoReviewBtn').addEventListener('click', async () => {
  scheduleRhSave();
  await new Promise((r) => setTimeout(r, 350));
  setMode('review');
});
r$('#rhBeatJump').addEventListener('change', () => { renderRhPanels(); rhView.draw(); });
r$('#rhBeatNote').addEventListener('input', (e) => {
  const b = rhWorkingBeat();
  if (!b) return;
  let m = beatMark(b.id);
  if (!m) { m = { id: uid('bm'), beat_id: b.id, actual_time: null, note: '' }; R.beat_marks.push(m); }
  m.note = e.target.value;
  scheduleRhSave();
});
r$('#rhNoteActor').addEventListener('change', () => {
  const b = rhWorkingBeat();
  const m = b && r$('#rhNoteActor').value ? actorMark(b.id, r$('#rhNoteActor').value) : null;
  r$('#rhActorNote').value = m ? m.note : '';
});
r$('#rhActorNote').addEventListener('input', (e) => {
  const b = rhWorkingBeat();
  if (!b || !r$('#rhNoteActor').value) return;
  const aid = r$('#rhNoteActor').value;
  let m = actorMark(b.id, aid);
  if (!m) {
    m = { id: uid('am'), beat_id: b.id, actor_id: aid, actual_time: null, x: null, y: null, absent: false, note: '' };
    R.actor_marks.push(m);
  }
  m.note = e.target.value;
  scheduleRhSave();
});
r$('#rhNotes').addEventListener('input', (e) => { R.notes = e.target.value; scheduleRhSave(); });

// 排练模式快捷键：空格记录节点
const rhKeys = {};
window.addEventListener('keydown', (e) => {
  if (mode !== 'rehearse' || !R) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  rhKeys[e.key === ' ' ? ' ' : e.key.toLowerCase()] = true;
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); recordCurrentBeat(); }
  if (e.key === 'Escape' && !r$('#rhOverlay').classList.contains('hidden')) {
    r$('#rhOverlay').classList.add('hidden');
  }
});
window.addEventListener('keyup', (e) => {
  rhKeys[e.key === ' ' ? ' ' : e.key.toLowerCase()] = false;
});
window.addEventListener('beforeunload', () => {
  if (mode === 'rehearse' && R) {
    // 尽力同步一次时钟（keepalive，避免关闭后时钟空走）
    try {
      const payload = buildRhPayload();
      fetch(`/api/rehearsals/${R.id}`, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }
});

// ################################################################
// #                                                              #
// #                         复盘模式                             #
// #                                                              #
// ################################################################
let V = null;                   // { a:{rec,review,view}, b:null|{...}, curBeatId, play:{...}, compare }
let rvViewA = null, rvViewB = null;
let promoteSel = { times: new Set(), positions: new Set() };

async function enterReviewMode() {
  if (!requireDoc()) return;
  if (!rvViewA) {
    rvViewA = makeStageView(r$('#rvCanvasA'), {
      hitTest: (w) => rvHitTest('a', w),
      onPointerDown: (info, w) => rvPointerDown('a', info, w),
      onDragMove: () => {}, onDragEnd: () => {},
    });
    rvViewB = makeStageView(r$('#rvCanvasB'), {
      hitTest: (w) => rvHitTest('b', w),
      onPointerDown: (info, w) => rvPointerDown('b', info, w),
      onDragMove: () => {}, onDragEnd: () => {},
    });
    wireReviewControls();
  }
  const list = await api(`/api/stages/${doc.stage.id}/rehearsals`);
  fillRvSelects(list);
  requestAnimationFrame(() => {
    rvViewA.resize();
    if (!r$('#rvPaneB').classList.contains('hidden')) rvViewB.resize();
  });
  await loadReview();
}

function fillRvSelects(list) {
  const opts = list.length
    ? list.map((r0) => `<option value="${r0.id}">${escapeHtml(r0.name)}（${r0.scene_name} · ${r0.status === 'finished' ? '已完成' : '进行中'}）</option>`).join('')
    : '<option value="">（尚无排练记录）</option>';
  r$('#rvSelectA').innerHTML = opts;
  r$('#rvSelectB').innerHTML = opts;
  if (V && list.some((r0) => r0.id === V.a?.rec.id)) {
    r$('#rvSelectA').value = V.a.rec.id;
  } else {
    r$('#rvSelectA').value = list[0] ? list[0].id : '';
  }
  if (r$('#rvCompareChk').checked) {
    if (V?.b && list.some((r0) => r0.id === V.b.rec.id)) {
      r$('#rvSelectB').value = V.b.rec.id;
    } else {
      const bId = list.find((r0) => r0.id !== r$('#rvSelectA').value)?.id;
      r$('#rvSelectB').value = bId || '';
    }
  }
}

function wireReviewControls() {
  r$('#rvSelectA').addEventListener('change', () => loadReview());
  r$('#rvSelectB').addEventListener('change', () => loadReview());
  r$('#rvCompareChk').addEventListener('change', (e) => {
    r$('#rvSelectBWrap').classList.toggle('hidden', !e.target.checked);
    r$('#rvPaneB').classList.toggle('hidden', !e.target.checked);
    loadReview();
  });
  r$('#rvReloadBtn').addEventListener('click', () => enterReviewMode());
  r$('#rvDeleteBtn').addEventListener('click', deleteRehearsalA);
  r$('#rvPlayBtn').addEventListener('click', toggleRvPlay);
  r$('#rvBeatJump').addEventListener('change', (e) => locateBeat(e.target.value));
  r$('#rvTimeline').addEventListener('click', rvTimelineClick);
  r$('#rvNotes').addEventListener('input', debounce(saveRvNotes, 600));
  r$('#rvPromoteTimes').addEventListener('click', () => selectAllPromote('times'));
  r$('#rvPromotePos').addEventListener('click', () => selectAllPromote('positions'));
  r$('#rvPromoteClear').addEventListener('click', () => {
    promoteSel.times.clear(); promoteSel.positions.clear(); renderPromoteList();
  });
  r$('#rvPromoteBtn').addEventListener('click', doPromote);
  r$('#printReviewBtn').addEventListener('click', openReviewPrint);
}

async function loadReview() {
  stopRvPlay();
  const aId = r$('#rvSelectA').value;
  if (!aId) { V = null; renderReviewEmpty(); return; }
  const recA = await api(`/api/rehearsals/${aId}`);
  const reviewA = await api(`/api/rehearsals/${aId}/review`);
  V = {
    a: { rec: recA, review: reviewA, view: rvViewA },
    b: null, curBeatId: null, play: { active: false, playing: false, t: 0, raf: null, last: null },
  };
  rvViewA.snap = recA.snapshot; rvViewA.fit();
  if (r$('#rvCompareChk').checked) {
    const bId = r$('#rvSelectB').value;
    if (bId && bId !== aId) {
      const recB = await api(`/api/rehearsals/${bId}`);
      const reviewB = await api(`/api/rehearsals/${bId}/review`);
      V.b = { rec: recB, review: reviewB, view: rvViewB };
      rvViewB.snap = recB.snapshot; rvViewB.fit();
    }
  }
  const first = reviewA.beats[0];
  V.curBeatId = first ? first.beat_id : null;
  r$('#rvTitleA').textContent = recA.name;
  if (V.b) r$('#rvTitleB').textContent = V.b.rec.name;
  fillRvBeatJump();
  renderReviewAll();
  requestAnimationFrame(() => { rvViewA.resize(); if (V.b) rvViewB.resize(); });
}

function renderReviewEmpty() {
  r$('#rvBeatSummary').innerHTML = '<li class="muted">尚无排练记录</li>';
  r$('#rvActorSummary').innerHTML = '';
  r$('#rvDiffList').innerHTML = '';
  r$('#rvPromoteList').innerHTML = '';
  r$('#rvRecurring').innerHTML = '<span class="muted">—</span>';
  r$('#rvTimeline').innerHTML = '';
  r$('#rvNotes').value = '';
}

function fillRvBeatJump() {
  const sel = r$('#rvBeatJump');
  sel.innerHTML = V.a.review.beats
    .map((b) => `<option value="${b.beat_id}">${escapeHtml(b.name)}（计划 ${b.planned.toFixed(1)}s）</option>`).join('');
  sel.value = V.curBeatId;
}

function rvBeats() { return V.a.review.beats; }
function rvBeat(id) { return rvBeats().find((b) => b.beat_id === id); }

// -------------------------------------------------- 定位 / 回放
// locateBeat：切换节点并显示静态的计划/实测叠加；playAt：进入按时间回放
function locateBeat(beatId) {
  stopRvPlay();
  const b = rvBeat(beatId);
  if (!b) return;
  V.curBeatId = beatId;
  V.play.active = false;
  r$('#rvBeatJump').value = beatId;
  renderReviewCanvas();
  renderDiffList();
  renderBeatSummary();
}
function playAt(beatId, t) {
  const b = rvBeat(beatId);
  if (!b) return;
  V.curBeatId = beatId;
  V.play.active = true;
  V.play.t = (t === undefined || t === null) ? b.planned : t;
  r$('#rvBeatJump').value = beatId;
  renderReviewCanvas();
  renderDiffList();
  renderBeatSummary();
  updatePlayhead();
}
function seekToBeat(beatId, t) {
  if (t === undefined) locateBeat(beatId);
  else playAt(beatId, t);
}

function rvTimeRange() {
  // 范围必须同时覆盖计划时刻与实测时刻（实测可能大幅晚于末节点计划时间）
  const ts = [];
  for (const b of rvBeats()) {
    ts.push(b.planned);
    if (b.actual !== null && b.actual !== undefined) ts.push(b.actual);
    for (const a of b.actors) {
      if (a.actual_time !== null && a.actual_time !== undefined) ts.push(a.actual_time);
    }
  }
  if (!ts.length) return [0, 1];
  return [Math.min(0, ...ts), Math.max(...ts, 1)];
}

function toggleRvPlay() {
  if (!V) return;
  const p = V.play;
  if (p.playing) { p.playing = false; r$('#rvPlayBtn').textContent = '▶'; return; }
  if (!p.active || !V.curBeatId) {
    const first = rvBeats()[0];
    if (first) playAt(first.beat_id, first.planned);
  } else {
    p.active = true; // 由定位暂停后继续
  }
  p.playing = true; p.last = performance.now();
  r$('#rvPlayBtn').textContent = '⏸';
  const tick = (now) => {
    if (!V || !V.play.playing) return;
    const dt = (now - V.play.last) / 1000;
    V.play.last = now;
    const [, t1] = rvTimeRange();
    V.play.t += dt;
    if (V.play.t >= t1) { V.play.t = t1; V.play.playing = false; r$('#rvPlayBtn').textContent = '▶'; }
    // 最近节点高亮跟随
    let near = null;
    for (const b of rvBeats()) if (b.planned <= V.play.t + 0.4) near = b;
    if (near && near.beat_id !== V.curBeatId) { V.curBeatId = near.beat_id; r$('#rvBeatJump').value = near.beat_id; renderDiffList(); renderBeatSummary(); }
    renderReviewCanvas();
    updatePlayhead();
    if (V.play.playing) p.raf = requestAnimationFrame(tick);
  };
  p.raf = requestAnimationFrame(tick);
}
function stopRvPlay() {
  if (!V) return;
  V.play.playing = false;
  if (V.play.raf) cancelAnimationFrame(V.play.raf);
  const btn = r$('#rvPlayBtn');
  if (btn) btn.textContent = '▶';
}

// 时间轴坐标：左侧 56px 标签列
function tlGeometry() {
  const el = r$('#rvTimeline');
  const w = el.clientWidth - 56 - 14;
  const [t0, t1] = rvTimeRange();
  return { x0: 56, width: Math.max(50, w), t0, t1,
    x: (t) => 56 + ((t - t0) / (t1 - t0 || 1)) * Math.max(50, w) };
}
function rvTimelineClick(e) {
  if (!V) return;
  stopRvPlay();
  const rect = e.currentTarget.getBoundingClientRect();
  const g = tlGeometry();
  const t = clamp(g.t0 + ((e.clientX - rect.left - g.x0) / g.width) * (g.t1 - g.t0), g.t0, g.t1);
  let near = rvBeats()[0];
  for (const b of rvBeats()) if (Math.abs(b.planned - t) < Math.abs(near.planned - t)) near = b;
  if (near) V.curBeatId = near.beat_id;
  V.play.active = true;
  V.play.t = t;
  r$('#rvBeatJump').value = V.curBeatId;
  renderReviewCanvas(); renderDiffList(); renderBeatSummary(); updatePlayhead();
}
function updatePlayhead() {
  if (!V) return;
  const g = tlGeometry();
  let ph = r$('#rvPlayhead');
  if (!ph) {
    ph = document.createElement('div');
    ph.id = 'rvPlayhead'; ph.className = 'rv-playhead';
    r$('#rvTimeline').appendChild(ph);
  }
  ph.style.left = g.x(V.play.t) + 'px';
  r$('#rvTimeLabel').textContent = V.play.t.toFixed(1) + 's';
}

// -------------------------------------------------- Canvas 绘制
function rvBeatEntry(which, beatId) {
  const slot = which === 'a' ? V.a : V.b;
  return slot ? slot.review.beats.find((b) => b.beat_id === beatId) : null;
}
function rvHitTest(which, w) {
  if (!V) return null;
  const slot = which === 'a' ? V.a : V.b;
  if (!slot) return null;
  const e = slot.review.beats.find((b) => b.beat_id === V.curBeatId);
  if (!e) return null;
  for (const a of e.actors) {
    if (a.x !== null && a.y !== null && dist(w.x, w.y, a.x, a.y) <= 0.38)
      return { kind: 'actual', actorId: a.actor_id };
    if (dist(w.x, w.y, a.plan_x, a.plan_y) <= 0.38)
      return { kind: 'plan', actorId: a.actor_id };
  }
  return null;
}
function rvPointerDown(which, info) {
  if (info) locateActor(which, V.curBeatId, info.actorId);
}

function drawReviewSlot(slot, which) {
  const v = slot.view;
  v.customDraw = (vv) => {
    const f = vv.startFrame();
    if (!f) return;
    const { ctx } = f;
    const snap = slot.rec.snapshot;
    const review = slot.review;
    const playing = V.play.active;
    const t = V.play.t;

    if (playing) {
      // 回放：计划轨迹（空心浅色）+ 实测分段线性插值（实心绿）
      for (const a of snap.actors) {
        const plan = planPositionAt(snap, slot.rec.scene_id, a.id, t + slot.rec.origin);
        if (plan) vv.marker(plan[0], plan[1], a, { ghost: true, facing: plan[2] });
        const ap = actualPositionAt(slot, a.id, t);
        if (ap) vv.marker(ap[0], ap[1], { color: '#46a063' }, { facing: ap[2], sel: true, label: a.name, labelColor: '#1f6e41' });
      }
    } else {
      const e = review.beats.find((b) => b.beat_id === V.curBeatId);
      if (e) {
        const beatSnap = snapBeat(snap, e.beat_id);
        const idxBeat = snap.beats
          .filter((b) => b.scene_id === slot.rec.scene_id)
          .sort((x, y) => x.position - y.position || x.name.localeCompare(y.name));
        const i = idxBeat.findIndex((b) => b.id === e.beat_id);
        const prev = i > 0 ? idxBeat[i - 1] : null;
        if (prev) {
          for (const a of snap.actors) {
            const pts = fullPathSnap(snap, prev, beatSnap, a.id);
            if (!pts) continue;
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
            ctx.strokeStyle = a.color; ctx.globalAlpha = 0.3;
            ctx.lineWidth = 1.6 / vv.view.scale; ctx.setLineDash([0.25, 0.15]);
            ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
          }
        }
        e.actors.forEach((a, i0) => {
          const actor = snapActor(snap, a.actor_id) || { name: a.actor_name, color: a.color };
          vv.marker(a.plan_x, a.plan_y, actor, { ghost: true, facing: a.plan_facing,
            label: `${i0 + 1} ${actor.name}`, labelColor: 'rgba(35,48,61,.85)' });
          if (a.absent) {
            vv.marker(a.plan_x, a.plan_y, actor, { ghost: true, facing: a.plan_facing, absent: true });
          } else if (a.x !== null && a.y !== null) {
            vv.connector(a.plan_x, a.plan_y, a.x, a.y,
              a.pos_dev >= 0.5 ? '#d9534f' : '#d05b93', true);
            vv.marker(a.x, a.y, { color: '#46a063' }, { facing: a.plan_facing, sel: true });
          }
        });
        // 节点标题
        ctx.fillStyle = 'rgba(20,28,40,.85)';
        ctx.fillRect(0.15, 0.12, Math.max(3.4, e.name.length * 0.4 + 2.2), 0.5);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${0.3}px sans-serif`;
        ctx.textAlign = 'left';
        const dTxt = e.delta === null ? '漏记' : fmtSigned(e.delta);
        ctx.fillText(`${e.name} · 计划 ${e.planned.toFixed(1)}s / 实测 ${e.actual === null ? '—' : e.actual.toFixed(1) + 's'}（${dTxt}）`, 0.3, 0.46);
      }
    }
    f.end();
  };
  v.draw();
}

// 实测位置随回放时间插值：优先该演员已记录 x/y 的相邻打点行
function actualPositionAt(slot, actorId, t) {
  const rows = slot.review.beats
    .map((b) => b.actors.find((a) => a.actor_id === actorId))
    .filter((a) => a && a.actual_time !== null && !a.absent)
    .sort((x, y) => x.actual_time - y.actual_time);
  if (!rows.length) return null;
  if (t <= rows[0].actual_time) {
    const r0 = rows[0];
    return r0.x !== null ? [r0.x, r0.y, r0.plan_facing] : null;
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.actual_time <= t && t <= b.actual_time) {
      const ax = a.x !== null ? a.x : a.plan_x, ay = a.y !== null ? a.y : a.plan_y;
      const bx = b.x !== null ? b.x : b.plan_x, by = b.y !== null ? b.y : b.plan_y;
      const dt = b.actual_time - a.actual_time;
      const r = dt > 0 ? (t - a.actual_time) / dt : 0;
      return [ax + (bx - ax) * r, ay + (by - ay) * r, a.plan_facing];
    }
  }
  const last = rows[rows.length - 1];
  return last.x !== null ? [last.x, last.y, last.plan_facing] : null;
}

function renderReviewCanvas() {
  if (!V) return;
  drawReviewSlot(V.a, 'a');
  if (V.b) drawReviewSlot(V.b, 'b');
}

// -------------------------------------------------- 汇总面板
function renderReviewAll() {
  renderBeatSummary();
  renderActorSummary();
  renderDiffList();
  renderTimeline();
  renderRecurring();
  renderPromoteList();
  r$('#rvNotes').value = V.a.rec.notes || '';
  r$('#rvCurBeatName').textContent = '';
  renderReviewCanvas();
  updatePlayhead();
}

function renderBeatSummary() {
  const ul = r$('#rvBeatSummary');
  ul.innerHTML = '';
  for (const b of rvBeats()) {
    const li = document.createElement('li');
    if (b.beat_id === V.curBeatId) li.classList.add('sel');
    if (b.status === 'late') li.classList.add('late');
    else if (b.status === 'early') li.classList.add('early');
    else if (b.status === 'missing') li.classList.add('miss');
    const missN = b.actors.filter((a) => a.status === 'missed').length;
    const absN = b.actors.filter((a) => a.status === 'absent').length;
    li.innerHTML = `<span class="nm">${escapeHtml(b.name)}</span>
      <span class="v">${b.actual === null ? '漏记' : fmtSigned(b.delta)}</span>
      ${missN ? `<span class="miss">漏${missN}</span>` : ''}${absN ? `<span class="absent">缺${absN}</span>` : ''}`;
    li.addEventListener('click', () => locateBeat(b.beat_id));
    ul.appendChild(li);
  }
}

function renderActorSummary() {
  const ul = r$('#rvActorSummary');
  ul.innerHTML = '';
  for (const a of V.a.review.actors) {
    const li = document.createElement('li');
    const parts = [];
    if (a.late) parts.push(`<span class="bad">晚 ${a.late}</span>`);
    if (a.early) parts.push(`<span>早 ${a.early}</span>`);
    if (a.missed) parts.push(`<span class="miss">漏 ${a.missed}</span>`);
    if (a.absent) parts.push(`<span class="absent">缺席 ${a.absent}</span>`);
    if (a.pos_bad) parts.push(`<span class="bad">走位偏 ${a.pos_bad}</span>`);
    li.innerHTML = `<div class="nm"><span style="color:${a.color}">●</span> ${escapeHtml(a.actor_name)}</div>
      <div>${parts.join(' · ') || '无偏差'}</div>
      <div class="muted">平均时差 ${a.avg_delta === null ? '—' : fmtSigned(a.avg_delta)} · 平均偏差 ${a.avg_pos === null ? '—' : a.avg_pos.toFixed(2) + 'm'}</div>`;
    li.addEventListener('click', () => {
      const first = V.a.review.beats.find((b) => b.actors.some((x) => x.actor_id === a.actor_id &&
        (x.status !== 'ok' || (x.pos_dev !== null && x.pos_dev >= 0.5))));
      if (first) locateActor('a', first.beat_id, a.actor_id);
      else if (V.a.review.beats[0]) locateActor('a', V.a.review.beats[0].beat_id, a.actor_id);
    });
    ul.appendChild(li);
  }
}

function renderDiffList() {
  const ul = r$('#rvDiffList');
  ul.innerHTML = '';
  const e = rvBeat(V.curBeatId);
  r$('#rvCurBeatName').textContent = e ? `· ${e.name}` : '';
  if (!e) return;
  // 节点时刻行
  const bli = document.createElement('li');
  bli.className = e.status === 'missing' ? 'miss' : (e.delta > 1 ? 'late' : (e.delta < -1 ? 'early' : ''));
  const tKey = `t:${e.beat_id}`;
  bli.innerHTML = `<div class="row1"><span class="nm">📍 节点时刻</span>
    <span class="v">${e.actual === null ? '漏记' : `${e.actual.toFixed(1)}s（${fmtSigned(e.delta)}）`}</span>
    <input type="checkbox" title="复制实测时间到副本" ${promoteSel.times.has(tKey) ? 'checked' : ''}></div>
    ${e.note ? `<div class="muted">备注：${escapeHtml(e.note)}</div>` : ''}`;
  bli.querySelector('input').addEventListener('change', (ev) => {
    if (ev.target.checked) promoteSel.times.add(tKey); else promoteSel.times.delete(tKey);
    renderPromoteList();
  });
  bli.addEventListener('click', (ev) => { if (ev.target.tagName !== 'INPUT') playAt(e.beat_id, e.actual ?? e.planned); });
  ul.appendChild(bli);

  for (const a of e.actors) {
    const li = document.createElement('li');
    let cls = a.status === 'missed' ? 'miss' : a.status === 'absent' ? 'absent'
      : a.delta > 1 ? 'late' : a.delta < -1 ? 'early' : '';
    if (a.pos_dev !== null && a.pos_dev >= 0.5) cls = (cls ? cls + ' ' : '') + 'pos';
    li.className = cls;
    const tAKey = `ta:${e.beat_id}:${a.actor_id}`;   // 演员时间不支持单独回写（节点统一），保留展示
    const pKey = `p:${e.beat_id}:${a.actor_id}`;
    let b2 = '';
    if (V.b) {
      const be = V.b.review.beats.find((x) => x.beat_id === e.beat_id);
      const ba = be && be.actors.find((x) => x.actor_id === a.actor_id);
      if (ba) b2 = `<span class="b2">B: ${ba.actual_time === null ? (ba.absent ? '缺席' : '漏') : fmtSigned(ba.delta)}${ba.pos_dev !== null ? ' Δ' + ba.pos_dev.toFixed(2) + 'm' : ''}</span>`;
    }
    li.innerHTML = `<div class="row1">
        <span class="swatch" style="background:${a.color}"></span>
        <span class="nm">${escapeHtml(a.actor_name)}</span>
        ${b2}
      </div>
      <div class="v">打点 ${a.actual_time === null ? (a.absent ? '缺席' : '未打点') : `${a.actual_time.toFixed(1)}s（${fmtSigned(a.delta)}）`}
        ${a.pos_dev === null ? '' : ` · 位置偏差 ${a.pos_dev.toFixed(2)}m`}</div>
      <div><input type="checkbox" ${promoteSel.positions.has(pKey) ? 'checked' : ''}> 复制实测位置
        <button class="locate">定位</button></div>
      ${a.note ? `<div class="muted">备注：${escapeHtml(a.note)}</div>` : ''}`;
    li.querySelector('.locate').addEventListener('click', () => locateActor('a', e.beat_id, a.actor_id));
    li.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) promoteSel.positions.add(pKey); else promoteSel.positions.delete(pKey);
      renderPromoteList();
    });
    ul.appendChild(li);
  }
}

function locateActor(which, beatId, actorId) {
  stopRvPlay();
  locateBeat(beatId);
  const slot = which === 'a' ? V.a : V.b;
  const e = slot.review.beats.find((b) => b.beat_id === beatId);
  const a = e && e.actors.find((x) => x.actor_id === actorId);
  if (!a) return;
  const x = a.x !== null ? a.x : a.plan_x, y = a.y !== null ? a.y : a.plan_y;
  const v = slot.view;
  const wrap = v.canvas.parentElement.getBoundingClientRect();
  v.view.ox = wrap.width / 2 - x * v.view.scale;
  v.view.oy = wrap.height / 2 - y * v.view.scale;
  v.draw();
  // 闪烁圈
  flashOn(v, x, y);
}
function flashOn(v, x, y) {
  const until = performance.now() + 1400;
  const anim = () => {
    const k = (until - performance.now()) / 1400;
    if (k <= 0) { v.draw(); return; }
    v.draw();
    const ctx = v.ctx;
    ctx.save();
    const sx = x * v.view.scale + v.view.ox, sy = y * v.view.scale + v.view.oy;
    ctx.strokeStyle = `rgba(217,83,79,${0.4 + k * 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, 14 + (1 - k) * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    requestAnimationFrame(anim);
  };
  requestAnimationFrame(anim);
}

// -------------------------------------------------- 时间轴
function renderTimeline() {
  const el = r$('#rvTimeline');
  el.innerHTML = '';
  if (!V) return;
  const g = tlGeometry();
  // 秒刻度
  for (let t = Math.ceil(g.t0); t <= g.t1; t++) {
    const tk = document.createElement('div');
    tk.className = 'rv-tick';
    tk.style.left = g.x(t) + 'px';
    el.appendChild(tk);
    const lb = document.createElement('div');
    lb.className = 'rv-tick-label';
    lb.style.left = g.x(t) + 'px';
    lb.textContent = t + 's';
    el.appendChild(lb);
  }
  drawTimelineTrack(el, g, V.a, '#46a063', 18, 'A');
  if (V.b) drawTimelineTrack(el, g, V.b, '#9b6dd3', 56, 'B');
  updatePlayhead();
}
function drawTimelineTrack(el, g, slot, color, top, tag) {
  const track = document.createElement('div');
  track.className = 'rv-track';
  track.style.top = (top + 6) + 'px';
  el.appendChild(track);
  slot.review.beats.forEach((b) => {
    // 计划点
    const plan = document.createElement('div');
    plan.className = 'rv-bt-mark';
    plan.style.left = g.x(b.planned) + 'px';
    plan.style.top = top + 'px';
    plan.title = `${b.name} 计划 ${b.planned.toFixed(1)}s`;
    el.appendChild(plan);
    // 实测点（在下方一行）+ 连线
    if (b.actual !== null && b.actual !== undefined) {
      const line = document.createElement('div');
      line.className = 'rv-bt-line';
      const xa = g.x(b.planned), xb = g.x(b.actual);
      line.style.left = Math.min(xa, xb) + 'px';
      line.style.width = Math.abs(xb - xa) + 'px';
      line.style.top = (top + 7) + 'px';
      line.style.background = b.delta > 1 ? '#d9534f' : b.delta < -1 ? '#2f6fb3' : color;
      el.appendChild(line);
      const act = document.createElement('div');
      act.className = `rv-bt-mark actual ${b.status}`;
      act.style.left = xb + 'px';
      act.style.top = (top + 2) + 'px';
      act.style.background = b.delta > 1 ? '#d9534f' : b.delta < -1 ? '#2f6fb3' : color;
      act.title = `${b.name} 实测 ${b.actual.toFixed(1)}s（${fmtSigned(b.delta)}）`;
      act.addEventListener('click', (e) => { e.stopPropagation(); seekToBeat(b.beat_id, b.actual); });
      el.appendChild(act);
    }
    const lb = document.createElement('div');
    lb.className = 'rv-bt-label';
    lb.style.left = g.x(b.planned) + 'px';
    lb.style.top = (top - 13) + 'px';
    lb.textContent = `${tag} ${b.name}`;
    el.appendChild(lb);
  });
}

// -------------------------------------------------- 反复问题 / 备注
async function renderRecurring() {
  const box = r$('#rvRecurring');
  if (!V.b) {
    // 单场：列出本场最突出的迟到/偏移
    const late = V.a.review.beats.filter((b) => b.status === 'late')
      .sort((x, y) => y.delta - x.delta).slice(0, 5);
    const pos = [];
    for (const b of V.a.review.beats) for (const a of b.actors)
      if (a.pos_dev !== null && a.pos_dev >= 0.5) pos.push({ b, a });
    pos.sort((x, y) => y.a.pos_dev - x.a.pos_dev);
    box.innerHTML = `<div class="grp"><b>节点延后：</b>${late.map((b) => `<span class="late">${escapeHtml(b.name)} ${fmtSigned(b.delta)}</span>`).join('；') || '<span class="muted">无</span>'}</div>
      <div class="grp"><b>走位偏移：</b>${pos.slice(0, 6).map((x) => `<span class="pos">${escapeHtml(x.a.actor_name)}@${escapeHtml(x.b.name)} ${x.a.pos_dev.toFixed(2)}m</span>`).join('；') || '<span class="muted">无</span>'}</div>`;
    return;
  }
  const cmp = await api(`/api/stages/${doc.stage.id}/rehearsals/compare?a=${V.a.rec.id}&b=${V.b.rec.id}`);
  const rt = cmp.recurring_time;
  const rp = cmp.recurring_pos;
  box.innerHTML = `<div class="grp"><b>反复迟到节点：</b>${rt.map((r) => `<span class="late">${escapeHtml(r.name)}（${fmtSigned(r.d1)} / ${fmtSigned(r.d2)}）</span>`).join('；') || '<span class="muted">无</span>'}</div>
    <div class="grp"><b>反复走位偏移：</b>${rp.map((r) => `<span class="pos">${escapeHtml(r.actor_name)}@${escapeHtml(r.beat_name)}（${r.p1.toFixed(2)}m / ${r.p2.toFixed(2)}m）</span>`).join('；') || '<span class="muted">无</span>'}</div>`;
}

async function saveRvNotes() {
  if (!V) return;
  await api(`/api/rehearsals/${V.a.rec.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: V.a.rec.name, notes: r$('#rvNotes').value, status: V.a.rec.status,
      clock_elapsed: V.a.rec.clock_elapsed || 0,
      clock_running: false, clock_at: null,
      beat_marks: V.a.rec.beat_marks.map((m) => ({ id: m.id, beat_id: m.beat_id, actual_time: m.actual_time, note: m.note || '' })),
      actor_marks: V.a.rec.actor_marks.map((m) => ({ id: m.id, beat_id: m.beat_id, actor_id: m.actor_id,
        actual_time: m.actual_time, x: m.x, y: m.y, absent: !!m.absent, note: m.note || '' })),
    }),
  });
  V.a.rec.notes = r$('#rvNotes').value;
}

// -------------------------------------------------- 删除 / 打印
async function deleteRehearsalA() {
  if (!V) { alert('请先选择排练'); return; }
  if (!confirm(`确定删除排练「${V.a.rec.name}」？此操作不可恢复。`)) return;
  await api(`/api/rehearsals/${V.a.rec.id}`, { method: 'DELETE' });
  V = null;
  await enterReviewMode();
}
function openReviewPrint() {
  if (!V) { alert('请先选择排练'); return; }
  const cmp = V.b ? `?compare=${V.b.rec.id}` : '';
  window.open(`/print/rehearsals/${V.a.rec.id}/review${cmp}`, '_blank');
}

// -------------------------------------------------- 复制到编排副本
function selectAllPromote(kind) {
  promoteSel.times.clear();
  promoteSel.positions.clear();
  if (kind === 'times') {
    for (const b of V.a.review.beats) if (b.actual !== null) promoteSel.times.add(`t:${b.beat_id}`);
  } else {
    for (const b of V.a.review.beats)
      for (const a of b.actors)
        if (a.x !== null && a.y !== null) promoteSel.positions.add(`p:${b.beat_id}:${a.actor_id}`);
  }
  renderPromoteList();
  renderDiffList();
}
function renderPromoteList() {
  const ul = r$('#rvPromoteList');
  ul.innerHTML = '';
  for (const b of V.a.review.beats) {
    const tOn = promoteSel.times.has(`t:${b.beat_id}`);
    const ps = b.actors.filter((a) => promoteSel.positions.has(`p:${b.beat_id}:${a.actor_id}`));
    if (!tOn && !ps.length) continue;
    const li = document.createElement('li');
    li.className = 'beat';
    li.innerHTML = `<span class="nm">${escapeHtml(b.name)}</span>` +
      (tOn ? `<span class="v">时间 → ${b.actual.toFixed(1)}s</span>` : '');
    ul.appendChild(li);
    for (const a of ps) {
      const ai = document.createElement('li');
      ai.className = 'actor';
      ai.innerHTML = `<span class="nm" style="color:${a.color}">${escapeHtml(a.actor_name)}</span>
        <span class="v">位置 → (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) Δ${a.pos_dev.toFixed(2)}m</span>`;
      ul.appendChild(ai);
    }
  }
  if (!ul.children.length) ul.innerHTML = '<li class="muted">在偏差明细中勾选要复制的实测时间/位置</li>';
}
async function doPromote() {
  if (!V) return;
  const times = [], positions = [];
  for (const k of promoteSel.times) {
    const bid = k.slice(2);
    const b = rvBeat(bid);
    if (b && b.actual !== null) times.push([bid, null, b.actual]);
  }
  for (const k of promoteSel.positions) {
    const [, bid, aid] = k.split(':');
    const e = rvBeat(bid);
    const a = e && e.actors.find((x) => x.actor_id === aid);
    if (a && a.x !== null) positions.push([bid, aid, a.x, a.y]);
  }
  if (!times.length && !positions.length) { alert('请先在偏差明细中勾选要复制的项目'); return; }
  const created = await api(`/api/rehearsals/${V.a.rec.id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ name: (r$('#rvPromoteName').value || '').trim(), times, positions }),
  });
  r$('#rvPromoteResult').textContent = `已生成副本「${created.stage.name}」，正在切换…`;
  // 切换到新舞台的编排页（整页跳转，确保新文档完整载入）
  window.location.href = `/stages/${created.stage.id}`;
}

// 暴露给模式切换初始化（防止首帧尺寸为 0）
window.addEventListener('resize', () => {
  if (mode === 'rehearse' && rhView) rhView.resize();
  if (mode === 'review' && rvViewA) {
    rvViewA.resize();
    if (V && V.b) rvViewB.resize();
  }
});
