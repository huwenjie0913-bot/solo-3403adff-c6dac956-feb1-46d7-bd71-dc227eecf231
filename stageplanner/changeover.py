"""换景调度引擎：换景操作排程与冲突检测（前端 changeover.js 内有等价实现）。

输入：序列化后的整文档 doc（含 crews/props/gates/set_positions/shifts/shift_ops/shift_deps）。
输出 analyze_changeover(doc):
{
  "shifts": [ {shift_id, name, from_scene, to_scene, deadline, makespan,
               problems: [...], ops: [ {op_id, start, finish, duration, demand, ...} ]} ],
  "problems": [ ...全部问题，带定位字段... ]
}

坐标约定与 geometry 模块一致：舞台矩形 (0,0)-(width,height)，y 向下为观众侧；
侧台 SL（舞台左，x<0）与 SR（舞台右，x>width）在台下，其出入段不做障碍检测。
"""
import math

from .geometry import dist, polyline_length, segment_intersects_polygon

TIMING_TOLERANCE = 0.02          # 时限误差 20ms
TIMESTEP = 0.5                   # 移动物碰撞采样步长（秒）
PROP_GAP = 0.15                  # 两物件占位矩形间距阈值（米），小于则判占位重叠
HANDOVER_PAUSE = 5.0             # 交接操作的停顿交接秒数（在路径中点）
STORAGE_INSET = 1.5              # 侧台存放点距台边距离


# ================================================================ 基础解析
def _index(doc):
    stage = doc["stage"]
    return {
        "stage": stage,
        "W": float(stage["width"]), "H": float(stage["height"]),
        "obstacles": [r for r in doc.get("regions", []) if r.get("kind") == "obstacle"],
        "crews": {c["id"]: c for c in doc.get("crews", [])},
        "props": {p["id"]: p for p in doc.get("props", [])},
        "gates": {g["id"]: g for g in doc.get("gates", [])},
        "scenes": {s["id"]: s for s in doc.get("scenes", [])},
        "pos": {(q["prop_id"], q["scene_id"], q["kind"]): q
                for q in doc.get("set_positions", [])},
    }


def storage_point(idx, prop):
    """物件存放侧台点：SL=x 负侧，SR=x 超宽侧。"""
    W, H = idx["W"], idx["H"]
    side = prop.get("storage") or "SL"
    y = H / 2
    if side == "SR":
        return (W + STORAGE_INSET, y)
    return (-STORAGE_INSET, y)


def gate_point(idx, prop, prefer_to=None):
    """选择物件使用的出入口：允许列表中最靠近 prefer_to（或存放点）的一个。
    返回 (gate_dict_or_None, point)。物件不允许任何 gate 时返回 (None, None)。"""
    gates = [idx["gates"][g] for g in (prop.get("gates") or []) if g in idx["gates"]]
    if not gates:
        return None, None
    target = prefer_to if prefer_to is not None else storage_point(idx, prop)
    g = min(gates, key=lambda q: dist(q["x"], q["y"], target[0], target[1]))
    return g, (g["x"], g["y"])


def position_point(idx, prop_id, scene_id, kind):
    q = idx["pos"].get((prop_id, scene_id, kind))
    if q is None or q.get("x") is None or q.get("y") is None:
        return None
    return (float(q["x"]), float(q["y"]))


def prop_rect(idx, prop_id, pt):
    """物件在 pt（中心）处的轴对齐占位矩形 (x0,y0,x1,y1)。"""
    p = idx["props"][prop_id]
    hw, hh = float(p["w"]) / 2, float(p["h"]) / 2
    return (pt[0] - hw, pt[1] - hh, pt[0] + hw, pt[1] + hh)


def rects_overlap(r1, r2, gap=PROP_GAP):
    """两个轴对齐矩形外扩 gap 后是否相交。"""
    return not (r1[2] + gap <= r2[0] or r2[2] + gap <= r1[0]
                or r1[3] + gap <= r2[1] or r2[3] + gap <= r1[1])


def _on_stage(idx, pt):
    return -1e-9 <= pt[0] <= idx["W"] + 1e-9 and -1e-9 <= pt[1] <= idx["H"] + 1e-9


# ================================================================ 操作路径
def op_endpoints(idx, shift, op):
    """解析操作的起讫点与完整折线（含台下段与出入口）。
    返回 dict(start, end, pts, gate, missing:[(角色,场景名)])。"""
    prop = idx["props"].get(op["prop_id"])
    missing = []
    if prop is None:
        return {"start": None, "end": None, "pts": [], "gate": None,
                "missing": [("物件已删除", "")]}
    anchors = [tuple(a) for a in (op.get("route") or [])]
    kind = op["kind"]
    store = storage_point(idx, prop)

    if kind == "strike":
        start = position_point(idx, prop["id"], shift["from_scene_id"], "close")
        if start is None:
            missing.append(("收场位", _scene_name(idx, shift.get("from_scene_id"))))
        g, gp = gate_point(idx, prop, prefer_to=start)
        if gp is None:
            missing.append(("允许出入口", ""))
            end, pts = store, ([start] if start else []) + anchors + [store]
        else:
            end = store
            mid = [p for p in [start, *anchors, gp] if p is not None]
            pts = mid + [store]
        gate = g
    elif kind == "preset":
        end = position_point(idx, prop["id"], shift["to_scene_id"], "open")
        if end is None:
            missing.append(("开场位", _scene_name(idx, shift.get("to_scene_id"))))
        g, gp = gate_point(idx, prop, prefer_to=end)
        if gp is None:
            missing.append(("允许出入口", ""))
            start, pts = store, [store] + anchors + ([end] if end else [])
        else:
            start = store
            pts = [store, gp] + anchors + [p for p in [end] if p is not None]
        gate = g
    elif kind == "move":
        start = position_point(idx, prop["id"], shift["from_scene_id"], "close")
        end = position_point(idx, prop["id"], shift["to_scene_id"], "open")
        if start is None:
            missing.append(("收场位", _scene_name(idx, shift.get("from_scene_id"))))
        if end is None:
            missing.append(("开场位", _scene_name(idx, shift.get("to_scene_id"))))
        pts = [p for p in [start] if p is not None] + anchors + \
              [p for p in [end] if p is not None]
        gate = None
    else:  # handover：交出组把物件从收场位搬到开场位，中点交接给接收组
        start = position_point(idx, prop["id"], shift["from_scene_id"], "close")
        end = position_point(idx, prop["id"], shift["to_scene_id"], "open")
        if start is None:
            missing.append(("收场位", _scene_name(idx, shift.get("from_scene_id"))))
        if end is None:
            missing.append(("开场位", _scene_name(idx, shift.get("to_scene_id"))))
        pts = [p for p in [start] if p is not None] + anchors + \
              [p for p in [end] if p is not None]
        gate = None

    return {"start": start, "end": end, "pts": pts, "gate": gate, "missing": missing}


def _scene_name(idx, sid):
    s = idx["scenes"].get(sid or "")
    return s["name"] if s else "（已删场景）"


def op_duration(idx, op, eps):
    """操作耗时：路径长度 ÷ 物件速度（交接额外加交接停顿）。"""
    prop = idx["props"].get(op["prop_id"])
    if prop is None or len(eps["pts"]) < 2:
        return 0.0
    length = polyline_length(eps["pts"])
    speed = max(0.01, float(prop.get("speed", 0.8)))
    d = length / speed
    if op["kind"] == "handover":
        d += HANDOVER_PAUSE
    return d


def op_demand(idx, op):
    """投用人数：显式 demands 优先，否则按物件最低搬运人数。"""
    if op.get("demands"):
        return max(1, int(op["demands"]))
    prop = idx["props"].get(op["prop_id"])
    return max(1, int(prop["min_crew"])) if prop else 1


def handover_point(eps, duration):
    """交接点：沿折线弧长中点（停顿位置）。无有效路径时取终点。"""
    pts = eps["pts"]
    if not pts:
        return None
    if len(pts) < 2:
        return pts[-1]
    move_time = max(1e-9, duration - HANDOVER_PAUSE)
    target_frac = 0.5
    total = polyline_length(pts)
    if total < 1e-9:
        return pts[-1]
    target = total * target_frac
    acc = 0
    for i in range(len(pts) - 1):
        seg = dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        if acc + seg >= target:
            r = 0 if seg == 0 else (target - acc) / seg
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
                    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r)
        acc += seg
    return pts[-1]


def position_at(eps, frac):
    """沿操作折线弧长比例位置（播放/碰撞采样用）。"""
    pts = eps["pts"]
    if not pts:
        return None
    if len(pts) < 2:
        return pts[-1]
    f = max(0.0, min(1.0, frac))
    total = polyline_length(pts)
    if total < 1e-9:
        return pts[-1]
    target = total * f
    acc = 0
    for i in range(len(pts) - 1):
        seg = dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        if acc + seg >= target:
            r = 0 if seg == 0 else (target - acc) / seg
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
                    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r)
        acc += seg
    return pts[-1]


# ================================================================ 静态先后关系
def _prop_chain_order(ops):
    """同一物件的操作：按用户顺序 order_hint/position 链式先后（先撤后搬再预置）。"""
    edges = set()
    by_prop = {}
    for op in ops:
        by_prop.setdefault(op["prop_id"], []).append(op)
    for group in by_prop.values():
        group.sort(key=lambda o: (o.get("order_hint", 0), o.get("position", 0), o["id"]))
        for a, b in zip(group, group[1:]):
            edges.add((b["id"], a["id"]))   # b 依赖 a
    return edges


def _initial_occupancy(idx, shift):
    """换景开始时台上各物件的位置（收场位；无收场位则视为在存放侧台）。"""
    occ = {}
    for pid, prop in idx["props"].items():
        pt = position_point(idx, pid, shift["from_scene_id"], "close")
        if pt is not None:
            occ[pid] = pt
    return occ


def _target_vacancy_edges(idx, shift, ops):
    """目标位腾空先后：操作终点矩形与开场时另一件仍在台上的物件占位相撞，
    而该物件在本换景中有操作（其最后一个操作把它移走/交接走）时，加静态先后边。"""
    edges = set()
    initial = _initial_occupancy(idx, shift)
    last_op_of_prop = {}
    for op in ops:
        prev = last_op_of_prop.get(op["prop_id"])
        if prev is None or (op.get("order_hint", 0), op.get("position", 0)) >= \
                (prev.get("order_hint", 0), prev.get("position", 0)):
            last_op_of_prop[op["prop_id"]] = op
    cache = {}

    def end_pt(op):
        if op["id"] not in cache:
            cache[op["id"]] = op_endpoints(idx, shift, op)
        return cache[op["id"]]

    for op in ops:
        eps = end_pt(op)
        if not eps["end"] or not _on_stage(idx, eps["end"]):
            continue
        rend = prop_rect(idx, op["prop_id"], eps["end"])
        for other_pid, other_pt in initial.items():
            if other_pid == op["prop_id"]:
                continue
            if not rects_overlap(rend, prop_rect(idx, other_pid, other_pt)):
                continue
            remover = last_op_of_prop.get(other_pid)
            if remover is not None and remover["id"] != op["id"]:
                edges.add((op["id"], remover["id"]))
    return edges


def _toposort(ops, pred_edges):
    """pred_edges: {(op, depends_on)}。返回 (order, cycle_nodes)。"""
    ids = [o["id"] for o in ops]
    preds = {i: set() for i in ids}
    succ = {i: set() for i in ids}
    for a, b in pred_edges:
        if a in preds and b in preds:
            preds[a].add(b)
            succ[b].add(a)
    indeg = {i: len(preds[i]) for i in ids}
    rank = {o["id"]: k for k, o in enumerate(
        sorted(ops, key=lambda o: (o.get("order_hint", 0), o.get("position", 0), o["id"])))}
    ready = sorted([i for i in ids if indeg[i] == 0], key=lambda i: rank[i])
    order = []
    while ready:
        n = ready.pop(0)
        order.append(n)
        for m in sorted(succ[n], key=lambda i: rank[i]):
            indeg[m] -= 1
            if indeg[m] == 0:
                ready.append(m)
        ready.sort(key=lambda i: rank[i])
    cycle = [i for i in ids if i not in set(order)]
    return order, cycle


# ================================================================ 排程
def _crew_intervals(idx, shift_id, schedules):
    """汇总某换景中各组已排操作的占用区间。
    handover 在交出组为 [s, mid_t]，接收组为 [mid_t, f]；其余为整段。"""
    out = {}
    for cid in idx["crews"]:
        out[cid] = []
    for row in schedules:
        if row["shift_id"] != shift_id:
            continue
        op = row["op"]
        s, f = row["start"], row["finish"]
        cid = op.get("crew_id")
        if cid in out and op["kind"] != "handover":
            out[cid].append((s, f))
        if op["kind"] == "handover":
            mid = s + row["move_time"] / 2
            if cid in out:
                out[cid].append((s, mid))
            hc = op.get("handover_crew")
            if hc in out:
                out[hc].append((mid, f))
    return out


def _crew_free_after(intervals, cid, demand, earliest, members):
    """组 cid 在 [earliest, …] 内可用人力始终 ≥ demand 的最早时刻。"""
    t = earliest
    ivs = sorted(intervals.get(cid, []))
    for _ in range(64):
        if members - sum(1 for a, b in ivs if a <= t + 1e-9 < b) >= demand:
            return t
        # 跳到当前正在进行的占用中最早的释放时刻
        ends = [b for a, b in ivs if a <= t + 1e-9 < b]
        nxt = min(ends) if ends else None
        if nxt is None or nxt <= t + 1e-9:
            return t
        t = nxt
    return t


def schedule_shift(idx, shift, ops_in, explicit_deps):
    """对单个换景排程。返回 (schedules dict op_id->row, unscheduled set, cycle set,
    endpoints dict op_id->eps, durations dict)。"""
    ops = sorted(ops_in, key=lambda o: (o.get("order_hint", 0), o.get("position", 0), o["id"]))
    endpoints = {op["id"]: op_endpoints(idx, shift, op) for op in ops}
    durations = {op["id"]: op_duration(idx, op, endpoints[op["id"]]) for op in ops}
    demands = {op["id"]: op_demand(idx, op) for op in ops}

    edges = set(explicit_deps)
    edges |= _prop_chain_order(ops)
    edges |= _target_vacancy_edges(idx, shift, ops)
    order, cycle = _toposort(ops, edges)
    preds = {i: set() for i in (o["id"] for o in ops)}
    for a, b in edges:
        if a in preds:
            preds[a].add(b)

    schedules = {}
    unscheduled = set(cycle)
    op_by_id = {op["id"]: op for op in ops}

    # 锁定操作先按锁定时刻放置（不做资源避让；重叠由检测阶段报告）
    locked = [op for op in ops if op["id"] not in unscheduled
              and op.get("locked_start") is not None]
    locked.sort(key=lambda o: (o["order_hint"], o["position"]))
    for op in locked:
        s = float(op["locked_start"])
        d = durations[op["id"]]
        schedules[op["id"]] = _row(shift, op, endpoints[op["id"]], s, s + d,
                                   durations[op["id"]], demands[op["id"]], locked=True)

    intervals = _crew_intervals(idx, shift["id"], list(schedules.values()))
    for op_id in order:
        op = op_by_id[op_id]
        if op_id in schedules:
            continue
        earliest = 0.0
        for dep in preds[op_id]:
            r = schedules.get(dep)
            if r is not None:
                earliest = max(earliest, r["finish"])
            elif dep in unscheduled:
                earliest = None
                break
        cid = op.get("crew_id")
        crew = idx["crews"].get(cid) if cid else None
        if crew is None:
            # 未指派负责组：仍给出理论时间线（只受依赖约束），人手问题另报
            s = earliest if earliest is not None else 0.0
            schedules[op_id] = _row(shift, op, endpoints[op_id], s, s + durations[op_id],
                                    durations[op_id], demands[op_id], locked=False)
            continue
        if earliest is None:
            unscheduled.add(op_id)
            continue
        if op["kind"] == "handover":
            hc = op.get("handover_crew")
            hcrew = idx["crews"].get(hc) if hc else None
            if hcrew is None:
                s = _crew_free_after(intervals, cid, demands[op_id], earliest, crew["members"])
            else:
                d = durations[op_id]
                move_time = max(1e-9, d - HANDOVER_PAUSE)
                # 交出组负责前半程 + 交接停顿，接收组负责后半程
                s = earliest
                for _ in range(48):
                    sa = _crew_free_after(intervals, cid, demands[op_id], s, crew["members"])
                    sb = _crew_free_after(intervals, hc, demands[op_id],
                                          sa + move_time / 2 + HANDOVER_PAUSE, hcrew["members"])
                    if abs(sb - (sa + move_time / 2 + HANDOVER_PAUSE)) < 1e-9:
                        s = sa
                        break
                    s = sb - move_time / 2 - HANDOVER_PAUSE
                    if s < earliest:
                        s = sa
                        break
        else:
            s = _crew_free_after(intervals, cid, demands[op_id], earliest, crew["members"])
        schedules[op_id] = _row(shift, op, endpoints[op_id], s, s + durations[op_id],
                                durations[op_id], demands[op_id], locked=False)
        intervals = _crew_intervals(idx, shift["id"], list(schedules.values()))

    return schedules, unscheduled, set(cycle), endpoints, durations, demands


def _row(shift, op, eps, start, finish, duration, demand, locked):
    row = {
        "shift_id": shift["id"], "op_id": op["id"], "op": op,
        "start": round(start, 2), "finish": round(finish, 2),
        "duration": round(duration, 2), "demand": demand,
        "locked": bool(locked), "pts": eps["pts"],
        "start_pt": eps["start"], "end_pt": eps["end"],
        "crew_id": op.get("crew_id"), "handover_crew": op.get("handover_crew"),
        "prop_id": op["prop_id"], "kind": op["kind"],
        "move_time": round(max(1e-9, duration - (HANDOVER_PAUSE if op["kind"] == "handover" else 0)), 3),
    }
    if op["kind"] == "handover":
        row["handover_pt"] = handover_point(eps, duration)
        row["handover_time"] = round(start + row["move_time"] / 2, 2)
    return row


# ================================================================ 检测
def _problem(ptype, severity, message, shift_id=None, op_id=None, xy=None, **extra):
    p = {"type": ptype, "severity": severity, "message": message,
         "shift_id": shift_id, "op_id": op_id,
         "x": round(xy[0], 3) if xy else None,
         "y": round(xy[1], 3) if xy else None}
    p.update(extra)
    return p


def _check_op_config(idx, shift, op, eps, problems):
    prop = idx["props"].get(op["prop_id"])
    label = f"「{op['kind']}」" + (f"（{prop['name']}）" if prop else "")
    if prop is None:
        problems.append(_problem("config", "error", f"操作{label}引用的物件已删除",
                                 shift["id"], op["id"]))
        return False
    for role, scene_name in eps["missing"]:
        problems.append(_problem("config", "error",
                                 f"{prop['name']} 的{label}缺少{role}{('（场景 ' + scene_name + '）') if scene_name else ''}",
                                 shift["id"], op["id"],
                                 xy=eps["end"] or eps["start"], prop_id=prop["id"]))
    if not op.get("crew_id") or op["crew_id"] not in idx["crews"]:
        problems.append(_problem("manpower", "error",
                                 f"{prop['name']} 的{label}未指派负责搬运组",
                                 shift["id"], op["id"], xy=eps["start"], prop_id=prop["id"]))
    if op["kind"] == "handover" and (
            not op.get("handover_crew") or op["handover_crew"] not in idx["crews"]):
        problems.append(_problem("manpower", "error",
                                 f"{prop['name']} 的交接操作{label}未指定接收组",
                                 shift["id"], op["id"], xy=eps["end"], prop_id=prop["id"]))
    # 出入口权限：strike/preset 必须使用物件允许的 gate
    if op["kind"] in ("strike", "preset") and not eps["missing"]:
        if eps["gate"] is None:
            problems.append(_problem("gate", "error",
                                     f"{prop['name']} 没有允许的出入口，{label}无法上下台",
                                     shift["id"], op["id"],
                                     xy=storage_point(idx, prop), prop_id=prop["id"]))
    return not eps["missing"]


def _check_obstacles(idx, shift, op, eps, problems):
    """折线上两个端点都在台内（含边界）的段做障碍穿越检测；台下段免检。"""
    prop = idx["props"][op["prop_id"]]
    pts = eps["pts"]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if not (_on_stage(idx, a) and _on_stage(idx, b)):
            continue
        for ob in idx["obstacles"]:
            if segment_intersects_polygon(a, b, ob["points"]):
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                problems.append(_problem("obstacle", "error",
                                         f"{prop['name']} 的路线穿越固定障碍「{ob['name']}」",
                                         shift["id"], op["id"], xy=mid,
                                         prop_id=prop["id"], obstacle_id=ob["id"]))
                break


def _build_timelines(idx, shift, rows):
    """每个物件在换景期间的完整时间线：
    [(t0, t1, payload), ...]，t1=None 表示静止段直到被后续段替换；
    payload 为 (x,y) 静止点，或排程行 row（移动段）。段按开始时间排序。"""
    timelines = {pid: [(0.0, None, pt)] for pid, pt in _initial_occupancy(idx, shift).items()}
    for row in sorted(rows, key=lambda r: (r["start"], r["op_id"])):
        pid = row["prop_id"]
        timelines.setdefault(pid, [])
        timelines[pid].append((row["start"], row["finish"], row))
        if row["end_pt"] is not None and _on_stage(idx, row["end_pt"]):
            timelines[pid].append((row["finish"], None, row["end_pt"]))
    return timelines


def _state_at(timelines, pid, t):
    """物件 pid 在 t 时刻的状态：('moving', row, frac) / ('still', pt) / None。"""
    cur_still = None
    for t0, t1, payload in timelines.get(pid, []):
        if t1 is None:
            if t >= t0 - 1e-9:
                cur_still = payload
            continue
        if t0 - 1e-9 <= t <= t1 + 1e-9:
            frac = 0 if t1 - t0 < 1e-9 else (t - t0) / (t1 - t0)
            return ("moving", payload, min(1.0, max(0.0, frac)))
        if t < t0:
            break
    if isinstance(cur_still, tuple):
        return ("still", cur_still)
    return None


def _check_target_vacancy(idx, shift, rows, timelines, problems):
    """操作到达终点的时刻，目标矩形不得与其他台上物件（静止或移动中）重叠。"""
    for row in sorted(rows, key=lambda r: (r["finish"], r["op_id"])):
        end = row["end_pt"]
        if end is None or not _on_stage(idx, end):
            continue
        rend = prop_rect(idx, row["prop_id"], end)
        t = row["finish"]
        for other in timelines:
            if other == row["prop_id"]:
                continue
            st = _state_at(timelines, other, t)
            if st is None:
                continue
            pt = st[1] if st[0] == "still" else position_at({"pts": st[1]["pts"]}, st[2])
            if pt is None or not _on_stage(idx, pt):
                continue
            if rects_overlap(rend, prop_rect(idx, other, pt)):
                name = idx["props"][row["prop_id"]]["name"]
                oname = idx["props"][other]["name"]
                problems.append(_problem(
                    "target", "error",
                    f"{t:.0f}s 时 {name} 的目标位置仍被 {oname} 占用，目标位未腾空",
                    shift["id"], row["op_id"], xy=end,
                    prop_id=row["prop_id"], other_prop_id=other))


def _check_collisions(idx, shift, rows, timelines, problems):
    """移动物之间、移动物与台上静止物件之间的矩形碰撞（时间采样）。
    换景开始就已重叠的一对（收场位互相压住）只报一次配置错误。"""
    if not timelines:
        return
    t_end = max((r["finish"] for r in rows), default=0.0)
    pids = list(timelines)

    # 初始重叠：配置错误，不计为移动碰撞
    init_boxes = {}
    for pid, pt in _initial_occupancy(idx, shift).items():
        init_boxes[pid] = prop_rect(idx, pid, pt)
    initial_overlap = set()
    init_ids = list(init_boxes)
    for i in range(len(init_ids)):
        for j in range(i + 1, len(init_ids)):
            a, b = init_ids[i], init_ids[j]
            if rects_overlap(init_boxes[a], init_boxes[b], gap=0.0):
                initial_overlap.add((a, b))
                problems.append(_problem(
                    "config", "error",
                    f"{idx['props'][a]['name']} 与 {idx['props'][b]['name']} 的收场位互相重叠",
                    shift["id"],
                    xy=((init_boxes[a][0] + init_boxes[b][2]) / 2,
                        (init_boxes[a][1] + init_boxes[b][3]) / 2),
                    prop_id=a, other_prop_id=b))

    t = TIMESTEP
    reported = set()
    while t <= t_end + 1e-9:
        boxes = {}
        for pid in pids:
            st = _state_at(timelines, pid, t)
            if st is None:
                continue
            pt = st[1] if st[0] == "still" else position_at({"pts": st[1]["pts"]}, st[2])
            if pt is None or not _on_stage(idx, pt):
                continue
            boxes[pid] = (prop_rect(idx, pid, pt), st)
        ids = list(boxes)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                if not rects_overlap(boxes[a][0], boxes[b][0], gap=0.0):
                    continue
                pair = tuple(sorted((a, b)))
                if pair in initial_overlap:
                    continue   # 开场重叠已作为配置问题报出
                sig = (a, b, round(t / TIMESTEP))
                if sig in reported:
                    continue
                # 同一对只在首次与解列后再次相撞时报，避免每 0.5s 刷屏
                if any((a == x[0] and b == x[1]) or (a == x[1] and b == x[0])
                       for x in reported):
                    continue
                reported.add(sig)
                cx = (boxes[a][0][0] + boxes[a][0][2] + boxes[b][0][0] + boxes[b][0][2]) / 4
                cy = (boxes[a][0][1] + boxes[a][0][3] + boxes[b][0][1] + boxes[b][0][3]) / 4
                moving = [pid for pid in (a, b) if boxes[pid][1][0] == "moving"]
                op_id = boxes[moving[0]][1][1]["op_id"] if moving else None
                an = idx["props"][a]["name"]
                bn = idx["props"][b]["name"]
                if len(moving) == 2:
                    msg = f"约 {t:.1f}s {an} 与 {bn} 同时移动并相撞"
                elif moving:
                    other_name = bn if moving[0] == a else an
                    msg = f"约 {t:.1f}s 移动的 {idx['props'][moving[0]]['name']} 与台上的 {other_name} 相撞"
                else:
                    continue
                problems.append(_problem("collision", "error", msg, shift["id"], op_id,
                                         xy=(cx, cy), prop_id=a, other_prop_id=b))
        t += TIMESTEP


def analyze_shift(idx, shift, all_ops, deps):
    ops = [o for o in all_ops if o["shift_id"] == shift["id"]]
    schedules, unscheduled, cycle, endpoints, durations, demands = \
        schedule_shift(idx, shift, ops, deps)
    problems = []

    # 依赖环
    if cycle:
        names = "、".join(idx["props"].get(o["prop_id"], {}).get("name", "?")
                          for o in ops if o["id"] in cycle)
        problems.append(_problem("cycle", "error",
                                 f"操作先后依赖存在环，无法排程（涉及：{names}）",
                                 shift["id"]))

    rows = [schedules[i] for i in sorted(schedules, key=lambda k: (schedules[k]["start"], k))]
    for op in ops:
        eps = endpoints[op["id"]]
        ok = _check_op_config(idx, shift, op, eps, problems)
        if ok and op["id"] not in unscheduled:
            _check_obstacles(idx, shift, op, eps, problems)

    # 人手不足（组人数 < 需求）
    for row in rows:
        cid = row["crew_id"]
        crew = idx["crews"].get(cid) if cid else None
        if crew and crew["members"] < row["demand"]:
            problems.append(_problem(
                "manpower", "error",
                f"{idx['props'][row['prop_id']]['name']} 需 {row['demand']} 人搬运，"
                f"「{crew['name']}」只有 {crew['members']} 人",
                shift["id"], row["op_id"], xy=row["start_pt"], prop_id=row["prop_id"]))
        if row["kind"] == "handover":
            hc = idx["crews"].get(row["handover_crew"]) if row["handover_crew"] else None
            if hc and hc["members"] < row["demand"]:
                problems.append(_problem(
                    "manpower", "error",
                    f"{idx['props'][row['prop_id']]['name']} 交接需 {row['demand']} 人，"
                    f"接收组「{hc['name']}」只有 {hc['members']} 人",
                    shift["id"], row["op_id"], xy=row["end_pt"], prop_id=row["prop_id"]))

    # 可用时段 + 同组重叠
    _check_windows_and_overlaps(idx, shift, rows, problems)

    # 目标位腾空 / 移动碰撞（仅对配置完整的行）
    valid_rows = [r for r in rows if r["pts"] and len(r["pts"]) >= 2
                  and not endpoints[r["op_id"]]["missing"]]
    timelines = _build_timelines(idx, shift, valid_rows)
    _check_target_vacancy(idx, shift, valid_rows, timelines, problems)
    _check_collisions(idx, shift, valid_rows, timelines, problems)

    # 超出时限
    makespan = max((r["finish"] for r in rows), default=0.0)
    deadline = float(shift.get("deadline", 0) or 0)
    if makespan > deadline + TIMING_TOLERANCE:
        late = [r for r in rows if r["finish"] > deadline + TIMING_TOLERANCE]
        problems.append(_problem(
            "deadline", "error",
            f"换景总用时 {makespan:.1f}s，超出 {deadline:.0f}s 时限 "
            f"（{len(late)} 个操作在时限后结束）",
            shift["id"], late[-1]["op_id"] if late else None,
            xy=late[-1]["end_pt"] if late else None))

    out_ops = []
    for op in ops:
        row = schedules.get(op["id"])
        entry = {
            "op_id": op["id"], "kind": op["kind"], "prop_id": op["prop_id"],
            "prop_name": idx["props"].get(op["prop_id"], {}).get("name", "?"),
            "crew_id": op.get("crew_id"),
            "crew_name": (idx["crews"].get(op.get("crew_id"), {}) or {}).get("name", ""),
            "handover_crew": op.get("handover_crew"),
            "handover_crew_name": (idx["crews"].get(op.get("handover_crew"), {}) or {}).get("name", ""),
            "locked": op.get("locked_start") is not None,
            "locked_start": op.get("locked_start"),
            "order_hint": op.get("order_hint", 0),
            "length": round(polyline_length(endpoints[op["id"]]["pts"]), 2),
            "missing": endpoints[op["id"]]["missing"],
        }
        if row:
            entry.update({"start": row["start"], "finish": row["finish"],
                          "duration": row["duration"], "demand": row["demand"],
                          "handover_time": row.get("handover_time")})
        else:
            entry.update({"start": None, "finish": None, "duration": None,
                          "demand": demands[op["id"]]})
        out_ops.append(entry)

    return {
        "shift_id": shift["id"],
        "name": shift.get("name") or "",
        "from_scene": _scene_name(idx, shift.get("from_scene_id")),
        "to_scene": _scene_name(idx, shift.get("to_scene_id")),
        "deadline": deadline, "makespan": round(makespan, 2),
        "problems": problems, "ops": out_ops,
    }


def _check_windows_and_overlaps(idx, shift, rows, problems):
    """可用时段越界 & 同组任务时间重叠（人力瞬时超出）。"""
    op_by_id = {r["op_id"]: r["op"] for r in rows}
    # 每组占用：[(start, finish, demand, row)]，handover 拆两段
    usage = {}

    def add(cid, s, f, demand, row):
        usage.setdefault(cid, []).append((s, f, demand, row))

    for row in rows:
        cid = row["crew_id"]
        if cid in idx["crews"] and row["kind"] != "handover":
            add(cid, row["start"], row["finish"], row["demand"], row)
        if row["kind"] == "handover":
            ht = row.get("handover_time", row["start"])
            if cid in idx["crews"]:
                add(cid, row["start"], ht + TIMING_TOLERANCE, row["demand"], row)
            hc = row["handover_crew"]
            if hc in idx["crews"]:
                add(hc, ht, row["finish"], row["demand"], row)

    for cid, ivs in usage.items():
        crew = idx["crews"][cid]
        win0, win1 = float(crew.get("win_start", 0)), float(crew.get("win_end", 1e9))
        for s, f, _, row in ivs:
            if s < win0 - TIMING_TOLERANCE or f > win1 + TIMING_TOLERANCE:
                problems.append(_problem(
                    "window", "error",
                    f"「{crew['name']}」的任务 {s:.1f}–{f:.1f}s 超出其可用时段 "
                    f"{win0:.0f}–{win1:.0f}s",
                    shift["id"], row["op_id"], xy=row["start_pt"], crew_id=cid))
        # 瞬时人力
        events = []
        for s, f, demand, row in ivs:
            events.append((s, demand, row))
            events.append((f, -demand, row))
        events.sort(key=lambda e: (e[0], e[1]))
        used = 0
        active = {}
        for t, delta, row in events:
            if delta > 0:
                active[row["op_id"]] = active.get(row["op_id"], 0) + delta
            used += delta
            if delta < 0:
                active[row["op_id"]] = active.get(row["op_id"], 0) + delta
            if used > crew["members"]:
                others = [idx["props"].get((op_by_id.get(oid) or {}).get("prop_id"), {}).get("name", "?")
                          for oid, n in active.items() if n > 0 and oid != row["op_id"]]
                problems.append(_problem(
                    "overlap", "error",
                    f"约 {t:.1f}s「{crew['name']}」同时承担 {used} 人任务（仅 {crew['members']} 人）"
                    + (f"：{idx['props'].get(row['prop_id'], {}).get('name', '?')}"
                       + (" 与 " + "、".join(others) if others else "") + " 时间重叠"),
                    shift["id"], row["op_id"],
                    xy=row["start_pt"], crew_id=cid))
                break  # 每组只报首个最严重重叠，避免刷屏


# ================================================================ 入口
def analyze_changeover(doc):
    idx = _index(doc)
    all_ops = doc.get("shift_ops", [])
    deps = {(d["op_id"], d["depends_on"]) for d in doc.get("shift_deps", [])}
    shifts_out = []
    problems = []
    scenes_ordered = sorted(doc.get("scenes", []), key=lambda s: (s.get("position", 0), s["name"]))
    shifts = sorted(doc.get("shifts", []), key=lambda s: (s.get("position", 0), s["id"]))
    for shift in shifts:
        res = analyze_shift(idx, shift, all_ops, deps)
        shifts_out.append(res)
        problems.extend(res["problems"])

    # 相邻场景但还没建换景的提示（不阻断）
    existing = {(s.get("from_scene_id"), s.get("to_scene_id")) for s in shifts}
    for a, b in zip(scenes_ordered, scenes_ordered[1:]):
        if (a["id"], b["id"]) not in existing:
            problems.append(_problem(
                "config", "warning",
                f"相邻场景「{a['name']}」→「{b['name']}」尚未创建换景调度",
                xy=None, from_scene_id=a["id"], to_scene_id=b["id"]))

    return {"shifts": shifts_out, "problems": problems,
            "shift_count": len(shifts)}


# ================================================================ 打印派生
def build_changeover_print(doc):
    """按负责组分列的可打印换景单数据：每个换景 -> 每组任务时间线 + 路线坐标。"""
    analysis = analyze_changeover(doc)
    idx = _index(doc)
    sheets = []
    for res in analysis["shifts"]:
        shift = next(s for s in doc["shifts"] if s["id"] == res["shift_id"])
        ops_by_crew = {}
        # 重算每行路径（含台下段），打印 SVG 使用
        eps_map = {}
        for op in doc.get("shift_ops", []):
            if op["shift_id"] != shift["id"]:
                continue
            eps = op_endpoints(idx, shift, op)
            eps_map[op["id"]] = eps
        for entry in res["ops"]:
            row_crew = entry.get("crew_id") or "_unassigned"
            ops_by_crew.setdefault(row_crew, []).append(entry)
            if entry["kind"] == "handover" and entry.get("handover_crew"):
                ops_by_crew.setdefault(entry["handover_crew"], []).append(entry)
        crews_out = []
        for cid, entries in ops_by_crew.items():
            crew = idx["crews"].get(cid)
            entries.sort(key=lambda e: (e["start"] is None, e["start"] or 0))
            crews_out.append({
                "crew_id": cid,
                "name": crew["name"] if crew else "（未指派）",
                "members": crew["members"] if crew else 0,
                "color": crew["color"] if crew else "#999",
                "win_start": crew.get("win_start", 0) if crew else None,
                "win_end": crew.get("win_end", 0) if crew else None,
                "entries": entries,
            })
        crews_out.sort(key=lambda c: (c["crew_id"] == "_unassigned", c["name"]))
        shift_problems = [p for p in res["problems"]]
        sheets.append({
            "shift": shift, "res": res, "crews": crews_out,
            "eps": eps_map, "problems": shift_problems,
        })
    return {"sheets": sheets, "analysis": analysis, "idx_summary": {
        "crews": list(idx["crews"].values()),
        "props": list(idx["props"].values()),
        "gates": list(idx["gates"].values()),
    }}
