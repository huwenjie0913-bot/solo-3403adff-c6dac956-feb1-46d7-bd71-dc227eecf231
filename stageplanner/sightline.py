"""观众视线校核：从抽样座位到目标的三维视线遮挡分析。

坐标约定与 geometry 模块一致：舞台平面 (0,0)-(W,H)，y 向下朝观众；
z 为离地高度（米），舞台地面与观众席地面同取 z=0。

- 观众区：舞台前方（y>H 侧）多边形，按排数/座位间距生成座位网格，
  眼高为视点 z，抽样密度=每 N 座取 1 座（座位编号不因抽样改变）。
- 目标：节点上指定的演员（其走位位置，目标点取演员身高）或舞台焦点（自带高度）。
- 遮挡物：高度>0 的区域/障碍（多边形柱体）、当前场景开场位的布景道具
  （矩形柱体）、同节点其他演员（半径 0.3m 圆柱，高=演员身高）。
- 判定：视线（座位→目标的线段）穿过遮挡物占位 footprint 的参数区间内，
  若遮挡物顶高 > 该区间内视线的最低高度，则视线被挡。
  被多个遮挡物挡时，报告离座位最近（进入参数 u 最小）的一个。

前端 static/sight.js 内有等价实现（SE 引擎），两边规则保持一致。
"""
import math

from .geometry import point_in_polygon

DEFAULT_ACTOR_HEIGHT = 1.7     # 演员默认身高（米）
DEFAULT_FOCUS_HEIGHT = 1.0     # 舞台焦点默认高度（米）
DEFAULT_EYE_HEIGHT = 1.2       # 观众默认眼高（坐姿，米）
ACTOR_RADIUS = 0.3             # 演员遮挡圆柱半径（米）
MIN_RUN = 2                    # 连续多少座被挡记为"连续盲区"（error 级）


# ---------------------------------------------------------------- 座位抽样
def compute_seats(zone):
    """按观众区多边形生成抽样座位。
    返回 [{row, col, x, y}]，row 从 1（前排，y 最小）起，col 从 1（左起）起。
    抽样密度 sample_step=N 表示每 N 个物理座位抽取 1 个（col 编号连续）。"""
    pts = zone.get("points") or []
    if len(pts) < 3:
        return []
    rows = max(1, int(zone.get("rows", 3) or 1))
    spacing = max(0.2, float(zone.get("seat_spacing", 0.55) or 0.55))
    step = max(1, int(zone.get("sample_step", 1) or 1))
    ys = [p[1] for p in pts]
    ymin, ymax = min(ys), max(ys)
    seats = []
    for ri in range(rows):
        # 排在观众区纵深上按带心分布（避免恰落在多边形边界上）
        y = ymin + (ymax - ymin) * (ri + 0.5) / rows
        col = 0
        for (x0, x1) in _row_intervals(pts, y):
            width = x1 - x0
            if width < 0.2:
                continue
            n = max(1, int(width / spacing))
            start = x0 + (width - (n - 1) * spacing) / 2
            for k in range(n):
                col += 1
                if (col - 1) % step != 0:
                    continue
                seats.append({"row": ri + 1, "col": col,
                              "x": round(start + k * spacing, 3), "y": round(y, 3)})
    return seats


def _row_intervals(poly, y):
    """水平线 y 与多边形的交集（x 区间列表，偶奇配对）。"""
    xs = []
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 <= y < y2) or (y2 <= y < y1):
            t = (y - y1) / (y2 - y1)
            xs.append(x1 + t * (x2 - x1))
    xs.sort()
    return [(xs[i], xs[i + 1]) for i in range(0, len(xs) - 1, 2)]


# ---------------------------------------------------------------- 视线求交
def _segment_poly_intervals(ax, ay, bx, by, poly):
    """线段 a→b 落在多边形内部的参数区间（u∈[0,1]，按中点内外判定）。"""
    us = [0.0, 1.0]
    dx, dy = bx - ax, by - ay
    n = len(poly)
    for i in range(n):
        cx, cy = poly[i]
        ex, ey = poly[(i + 1) % n]
        den = dx * (ey - cy) - dy * (ex - cx)
        if abs(den) < 1e-12:
            continue
        t = ((cx - ax) * (ey - cy) - (cy - ay) * (ex - cx)) / den
        s = ((cx - ax) * dy - (cy - ay) * dx) / den
        if 1e-9 < t < 1 - 1e-9 and -1e-9 <= s <= 1 + 1e-9:
            us.append(min(1.0, max(0.0, t)))
    us = sorted({round(u, 9) for u in us})
    out = []
    for i in range(len(us) - 1):
        u0, u1 = us[i], us[i + 1]
        if u1 - u0 < 1e-9:
            continue
        um = (u0 + u1) / 2
        if point_in_polygon(ax + dx * um, ay + dy * um, poly):
            out.append((u0, u1))
    return out


def _segment_circle_intervals(ax, ay, bx, by, cx, cy, r):
    """线段 a→b 与圆 (c,r) 相交的参数区间。"""
    dx, dy = bx - ax, by - ay
    fx, fy = ax - cx, ay - cy
    a = dx * dx + dy * dy
    if a < 1e-12:
        return [(0.0, 1.0)] if fx * fx + fy * fy <= r * r else []
    b = 2 * (fx * dx + fy * dy)
    c = fx * fx + fy * fy - r * r
    disc = b * b - 4 * a * c
    if disc <= 0:
        return []
    sq = math.sqrt(disc)
    u0 = max(0.0, (-b - sq) / (2 * a))
    u1 = min(1.0, (-b + sq) / (2 * a))
    return [(u0, u1)] if u1 > u0 + 1e-9 else []


def ray_blocker(seat, target, occluders, ignore_actor_id=None):
    """座位→目标视线的遮挡物。返回离座位最近的一个 {occluder, u, x, y} 或 None。
    seat/target 为 (x, y, z) 三元组。"""
    sx, sy, sz = seat
    tx, ty, tz = target
    best = None
    for oc in occluders:
        if oc["kind"] == "actor" and oc["ref_id"] == ignore_actor_id:
            continue
        if oc["footprint"] == "circle":
            ivs = _segment_circle_intervals(
                sx, sy, tx, ty, oc["x"], oc["y"], oc["radius"])
        else:
            ivs = _segment_poly_intervals(sx, sy, tx, ty, oc["points"])
        for (u0, u1) in ivs:
            z0 = sz + (tz - sz) * u0
            z1 = sz + (tz - sz) * u1
            if oc["height"] > min(z0, z1) + 1e-9:
                if best is None or u0 < best["u"]:
                    best = {"occluder": oc, "u": u0,
                            "x": round(sx + (tx - sx) * u0, 3),
                            "y": round(sy + (ty - sy) * u0, 3)}
                break
    return best


# ---------------------------------------------------------------- 目标与遮挡物
def beat_targets(doc, beat, placements):
    """节点上配置的视线目标（演员走位位置 / 舞台焦点）。"""
    out = []
    focuses = {f["id"]: f for f in doc.get("focus_points", [])}
    actors = {a["id"]: a for a in doc.get("actors", [])}
    targets = sorted(doc.get("sight_targets", []),
                     key=lambda q: (q.get("position", 0), q.get("id", "")))
    for t in targets:
        if t["beat_id"] != beat["id"]:
            continue
        if t["kind"] == "actor":
            a = actors.get(t["ref_id"])
            pl = placements.get(beat["id"], {}).get(t["ref_id"])
            if not a or not pl:
                continue
            out.append({"kind": "actor", "ref_id": a["id"], "name": a["name"],
                        "x": pl["x"], "y": pl["y"],
                        "z": float(a.get("height") or DEFAULT_ACTOR_HEIGHT)})
        else:
            f = focuses.get(t["ref_id"])
            if not f:
                continue
            out.append({"kind": "focus", "ref_id": f["id"], "name": f["name"],
                        "x": float(f["x"]), "y": float(f["y"]),
                        "z": float(f.get("height") or DEFAULT_FOCUS_HEIGHT)})
    return out


def beat_occluders(doc, beat, placements):
    """节点时刻的遮挡物集合：有高度的区域/障碍、当前场景开场位布景、同节点演员。"""
    occ = []
    for r in doc.get("regions", []):
        h = float(r.get("height") or 0)
        if h > 0 and len(r.get("points") or []) >= 3:
            occ.append({"kind": "region", "ref_id": r["id"], "name": r["name"],
                        "footprint": "poly", "points": r["points"], "height": h})
    scene_id = beat.get("scene_id")
    pos = {(q["prop_id"], q["scene_id"], q["kind"]): q
           for q in doc.get("set_positions", [])}
    for p in doc.get("props", []):
        h = float(p.get("height") or 0)
        if h <= 0:
            continue
        q = pos.get((p["id"], scene_id, "open"))
        if not q or q.get("x") is None or q.get("y") is None:
            continue
        hw, hh = float(p["w"]) / 2, float(p["h"]) / 2
        x, y = float(q["x"]), float(q["y"])
        rect = [[x - hw, y - hh], [x + hw, y - hh],
                [x + hw, y + hh], [x - hw, y + hh]]
        occ.append({"kind": "prop", "ref_id": p["id"], "name": p["name"],
                    "footprint": "poly", "points": rect, "height": h})
    actors = {a["id"]: a for a in doc.get("actors", [])}
    for pl in placements.get(beat["id"], {}).values():
        a = actors.get(pl["actor_id"])
        if not a:
            continue
        occ.append({"kind": "actor", "ref_id": a["id"], "name": a["name"],
                    "footprint": "circle", "x": pl["x"], "y": pl["y"],
                    "radius": ACTOR_RADIUS,
                    "height": float(a.get("height") or DEFAULT_ACTOR_HEIGHT)})
    return occ


# ---------------------------------------------------------------- 主分析
def analyze_sightlines(doc, beat_ids=None):
    """整文档视线校核。返回 {"beats": [...], "zone_count", "seat_count",
    "checked_beats"}；每个含目标的节点给出各观众区可见率、连续盲区与问题清单。"""
    beats = sorted(doc.get("beats", []), key=lambda b: (b["position"], b["name"]))
    if beat_ids is not None:
        keep = set(beat_ids)
        beats = [b for b in beats if b["id"] in keep]
    placements = {}
    for p in doc.get("placements", []):
        placements.setdefault(p["beat_id"], {})[p["actor_id"]] = p
    zones = sorted(doc.get("audience_zones", []),
                   key=lambda z: (z.get("position", 0), z["name"]))
    zone_seats = {z["id"]: compute_seats(z) for z in zones}
    scenes = {s["id"]: s for s in doc.get("scenes", [])}

    beats_out = []
    seat_total = 0
    for beat in beats:
        targets = beat_targets(doc, beat, placements)
        if not targets:
            continue
        occluders = beat_occluders(doc, beat, placements)
        zones_out = []
        problems = []
        for z in zones:
            eye = float(z.get("eye_height") or DEFAULT_EYE_HEIGHT)
            zres = _analyze_zone(z, zone_seats[z["id"]], eye, targets, occluders)
            zones_out.append(zres)
            seat_total += zres["total"]
            problems.extend(_zone_problems(beat, zres))
        beats_out.append({
            "beat_id": beat["id"], "beat_name": beat["name"],
            "scene_id": beat.get("scene_id"),
            "scene_name": (scenes.get(beat.get("scene_id")) or {}).get("name", ""),
            "targets": targets, "zones": zones_out, "problems": problems,
        })
    return {"beats": beats_out,
            "zone_count": len(zones),
            "seat_count": seat_total,
            "checked_beats": len(beats_out)}


def _analyze_zone(zone, seats, eye, targets, occluders):
    """单个观众区：逐座位逐目标判定，汇总可见率/连续盲区/遮挡来源。"""
    detail = []
    for seat in seats:
        blocked = []
        for t in targets:
            hit = ray_blocker(
                (seat["x"], seat["y"], eye), (t["x"], t["y"], t["z"]),
                occluders,
                ignore_actor_id=t["ref_id"] if t["kind"] == "actor" else None)
            if hit:
                blocked.append({
                    "target_kind": t["kind"], "target_ref": t["ref_id"],
                    "target_name": t["name"],
                    "occ_kind": hit["occluder"]["kind"],
                    "occ_ref": hit["occluder"]["ref_id"],
                    "occ_name": hit["occluder"]["name"],
                    "u": round(hit["u"], 4), "x": hit["x"], "y": hit["y"]})
        detail.append({"row": seat["row"], "col": seat["col"],
                       "x": seat["x"], "y": seat["y"],
                       "ok": not blocked, "blocked": blocked})

    total = len(detail)
    blocked_n = sum(1 for s in detail if not s["ok"])
    # 按排分组找连续被挡座位
    rows_out = []
    by_row = {}
    for s in detail:
        by_row.setdefault(s["row"], []).append(s)
    for ri in sorted(by_row):
        rseats = sorted(by_row[ri], key=lambda s: s["col"])
        runs = []
        cur = []
        for s in rseats:
            if not s["ok"]:
                cur.append(s)
            else:
                if cur:
                    runs.append(cur)
                    cur = []
        if cur:
            runs.append(cur)
        runs_out = []
        for run in runs:
            occ_name = _majority(run, lambda s: s["blocked"][0]["occ_name"]
                                 if s["blocked"] else "")
            tgt_names = sorted({b["target_name"] for s in run for b in s["blocked"]})
            runs_out.append({"c0": run[0]["col"], "c1": run[-1]["col"],
                             "count": len(run),
                             "seats": [{"row": s["row"], "col": s["col"],
                                        "x": s["x"], "y": s["y"]} for s in run],
                             "occluder": occ_name, "targets": tgt_names})
        rows_out.append({"row": ri, "total": len(rseats),
                         "blocked": sum(1 for s in rseats if not s["ok"]),
                         "runs": runs_out})
    # 遮挡来源：每个被挡座位归因于最近的遮挡物（u 最小）
    sources = {}
    for s in detail:
        if not s["blocked"]:
            continue
        primary = min(s["blocked"], key=lambda b: b["u"])
        key = (primary["occ_kind"], primary["occ_ref"])
        ent = sources.setdefault(key, {"kind": primary["occ_kind"],
                                       "ref_id": primary["occ_ref"],
                                       "name": primary["occ_name"], "seats": 0})
        ent["seats"] += 1
    return {"zone_id": zone["id"], "zone_name": zone["name"],
            "eye_height": eye, "total": total, "blocked": blocked_n,
            "visible_rate": round((total - blocked_n) / total, 4) if total else None,
            "rows": rows_out,
            "sources": sorted(sources.values(), key=lambda q: -q["seats"]),
            "seats": detail}


def _majority(items, key):
    counts = {}
    for it in items:
        k = key(it)
        counts[k] = counts.get(k, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0] if counts else ""


def _zone_problems(beat, zres):
    """连续被挡座位 → 问题清单条目（带座位/遮挡物/目标定位字段）。"""
    out = []
    for row in zres["rows"]:
        for run in row["runs"]:
            mid = run["seats"][len(run["seats"]) // 2]
            tgt = "、".join(run["targets"])
            rng = (f"{run['c0']}–{run['c1']} 号" if run["count"] > 1
                   else f"{run['c0']} 号")
            out.append({
                "type": "blind",
                "severity": "error" if run["count"] >= MIN_RUN else "warning",
                "message": (f"「{zres['zone_name']}」第 {row['row']} 排 {rng}"
                            f"（{run['count']} 座）看不清 {tgt}，"
                            f"主要遮挡：{run['occluder']}"),
                "beat_id": beat["id"], "zone_id": zres["zone_id"],
                "row": row["row"], "c0": run["c0"], "c1": run["c1"],
                "count": run["count"], "x": mid["x"], "y": mid["y"],
                "occluder": run["occluder"], "targets": run["targets"],
                "seats": run["seats"],
            })
    return out


# ---------------------------------------------------------------- 版本比较
def compare_results(res_a, res_b):
    """比较两份校核结果（按 节点×观众区 对齐可见率）。
    返回 {"rows": [...], "improved", "worsened", "unchanged"}。"""
    beats_a = {b["beat_id"]: b for b in res_a.get("beats", [])}
    beats_b = {b["beat_id"]: b for b in res_b.get("beats", [])}
    order = [b["beat_id"] for b in res_a.get("beats", [])]
    order += [bid for bid in beats_b if bid not in beats_a]
    rows = []
    improved = worsened = unchanged = 0
    for bid in order:
        ba, bb = beats_a.get(bid), beats_b.get(bid)
        name = (ba or bb)["beat_name"]
        scene = (ba or bb).get("scene_name", "")
        za = {z["zone_id"]: z for z in (ba["zones"] if ba else [])}
        zb = {z["zone_id"]: z for z in (bb["zones"] if bb else [])}
        for zid in list(za) + [z for z in zb if z not in za]:
            a, b = za.get(zid), zb.get(zid)
            ra = a["visible_rate"] if a else None
            rb = b["visible_rate"] if b else None
            delta = (round(rb - ra, 4) if ra is not None and rb is not None
                     else None)
            if delta is None or abs(delta) < 1e-9:
                unchanged += 1
            elif delta > 0:
                improved += 1
            else:
                worsened += 1
            rows.append({"beat_id": bid, "beat_name": name, "scene_name": scene,
                         "zone_id": zid,
                         "zone_name": (a or b)["zone_name"],
                         "rate_a": ra, "rate_b": rb, "delta": delta,
                         "blocked_a": a["blocked"] if a else None,
                         "blocked_b": b["blocked"] if b else None,
                         "total": (a or b)["total"]})
    return {"rows": rows, "improved": improved,
            "worsened": worsened, "unchanged": unchanged}


def summarize_results(res):
    """版本列表用的简要汇总：平均可见率与问题数。"""
    rates = [z["visible_rate"] for b in res.get("beats", [])
             for z in b["zones"] if z["visible_rate"] is not None]
    problems = sum(len(b["problems"]) for b in res.get("beats", []))
    return {"checked_beats": res.get("checked_beats", 0),
            "avg_rate": round(sum(rates) / len(rates), 4) if rates else None,
            "problems": problems}


# ---------------------------------------------------------------- 打印派生
def sight_map_bounds(doc):
    """舞台 + 观众区的外接矩形（打印 SVG viewBox 用）。"""
    W = float(doc["stage"]["width"])
    H = float(doc["stage"]["height"])
    x0, y0, x1, y1 = 0.0, 0.0, W, H
    for z in doc.get("audience_zones", []):
        for p in z.get("points") or []:
            x0 = min(x0, p[0]); x1 = max(x1, p[0])
            y0 = min(y0, p[1]); y1 = max(y1, p[1])
    pad = 0.6
    return (round(x0 - pad, 2), round(y0 - pad, 2),
            round(x1 + pad, 2), round(y1 + pad, 2))
