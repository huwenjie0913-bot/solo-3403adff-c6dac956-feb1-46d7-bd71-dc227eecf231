"""排练复盘：计划 vs 实测的偏差计算、两次排练对比、编排副本生成。

核心约定
- 排练时钟相对场景原点：计划基准 = beat.time - origin（origin 为场景首节点计划时间）。
- 节点时刻差 delta = 节点实测时刻 - 计划基准；正值为延后，负值为提前。
- 演员到位差 = 演员实测打点时刻 - 计划基准；位置偏差 = 实测位置与计划走位的直线距离（米）。
- 漏记分三类：节点未记录（beat_missing）、演员未打点（missed）、演员缺席（absent）。
"""
import copy
import json
import uuid

from .geometry import dist

LATE_THRESHOLD = 1.0        # |delta| ≥ 1s 视为明显提前/延后
POSITION_THRESHOLD = 0.5    # 位置偏差 ≥ 0.5m 视为明显走位偏移


# ---------------------------------------------------------------- 工具
def snapshot_doc(rec):
    """排练记录内的编排快照 dict。"""
    if isinstance(rec.get("snapshot"), str):
        return json.loads(rec["snapshot"])
    return rec["snapshot"]


def _scene_beats(snap, scene_id):
    beats = [b for b in snap.get("beats", []) if b.get("scene_id") == scene_id]
    return sorted(beats, key=lambda b: (b["position"], b["name"]))


def _plans(snap, beats):
    placements = {}
    for p in snap.get("placements", []):
        placements.setdefault(p["beat_id"], {})[p["actor_id"]] = p
    return placements


# ---------------------------------------------------------------- 单次复盘
def build_review(rec):
    """对一条排练记录计算逐节点、逐演员的复盘指标。返回结构见模块 docstring。"""
    snap = snapshot_doc(rec)
    scene_id = rec.get("scene_id")
    origin = float(rec.get("origin", 0))
    beats = _scene_beats(snap, scene_id)
    beat_plan = {b["id"]: b for b in beats}
    plans = _plans(snap, beats)
    actors = snap.get("actors", [])

    beat_marks = {m["beat_id"]: m for m in rec.get("beat_marks", [])}
    actor_marks = {}
    for m in rec.get("actor_marks", []):
        actor_marks.setdefault(m["beat_id"], {})[m["actor_id"]] = m

    beats_out = []
    stats = {"beat_total": 0, "beat_missing": 0, "beat_late": 0, "beat_early": 0,
             "actor_total": 0, "missed": 0, "absent": 0, "late": 0, "early": 0,
             "pos_bad": 0, "late_total": 0.0, "early_total": 0.0,
             "actor_late_total": 0.0, "actor_early_total": 0.0, "pos_total": 0.0,
             "pos_count": 0}

    for b in beats:
        planned = round(b["time"] - origin, 3)
        bm = beat_marks.get(b["id"])
        actual = bm.get("actual_time") if bm else None
        entry = {
            "beat_id": b["id"], "name": b["name"], "time": b["time"],
            "planned": planned, "actual": actual, "note": (bm or {}).get("note", ""),
            "delta": None, "status": "missing", "actors": [],
        }
        if actual is None:
            entry["status"] = "missing"
            stats["beat_missing"] += 1
        else:
            delta = round(actual - planned, 2)
            entry["delta"] = delta
            if delta > LATE_THRESHOLD:
                entry["status"] = "late"; stats["beat_late"] += 1
                stats["late_total"] += delta
            elif delta < -LATE_THRESHOLD:
                entry["status"] = "early"; stats["beat_early"] += 1
                stats["early_total"] += -delta
            else:
                entry["status"] = "ok"
        stats["beat_total"] += 1

        for actor in actors:
            pl = plans.get(b["id"], {}).get(actor["id"])
            if pl is None:
                continue  # 快照中该节点该演员无计划走位，不参与统计
            stats["actor_total"] += 1
            am = actor_marks.get(b["id"], {}).get(actor["id"])
            a = {
                "actor_id": actor["id"], "actor_name": actor["name"],
                "color": actor.get("color", "#e8734a"),
                "beat_id": b["id"], "beat_name": b["name"],
                "planned": planned,
                "plan_x": pl["x"], "plan_y": pl["y"], "plan_facing": pl.get("facing", 0),
                "actual_time": None, "delta": None, "x": None, "y": None,
                "pos_dev": None, "absent": False, "note": "", "status": "missed",
            }
            if am:
                a["actual_time"] = am.get("actual_time")
                a["x"] = am.get("x"); a["y"] = am.get("y")
                a["absent"] = bool(am.get("absent"))
                a["note"] = am.get("note", "")
                if a["actual_time"] is not None:
                    d = round(a["actual_time"] - planned, 2)
                    a["delta"] = d
                if a["x"] is not None:
                    pv = dist(a["x"], a["y"], pl["x"], pl["y"])
                    a["pos_dev"] = round(pv, 2)
                    stats["pos_total"] += pv; stats["pos_count"] += 1
                    if pv >= POSITION_THRESHOLD:
                        stats["pos_bad"] += 1
            if a["absent"]:
                a["status"] = "absent"; stats["absent"] += 1
            elif a["actual_time"] is None:
                a["status"] = "missed"; stats["missed"] += 1
            elif a["delta"] is not None and a["delta"] > LATE_THRESHOLD:
                a["status"] = "late"; stats["late"] += 1
                stats["actor_late_total"] += a["delta"]
            elif a["delta"] is not None and a["delta"] < -LATE_THRESHOLD:
                a["status"] = "early"; stats["early"] += 1
                stats["actor_early_total"] += -a["delta"]
            else:
                a["status"] = "ok"
            entry["actors"].append(a)
        beats_out.append(entry)

    # 按演员汇总
    actors_out = []
    for actor in actors:
        rows = [a for e in beats_out for a in e["actors"] if a["actor_id"] == actor["id"]]
        if not rows:
            continue
        timed = [r for r in rows if r["delta"] is not None]
        poss = [r for r in rows if r["pos_dev"] is not None]
        actors_out.append({
            "actor_id": actor["id"], "actor_name": actor["name"],
            "color": actor.get("color", "#e8734a"),
            "count": len(rows),
            "late": sum(1 for r in rows if r["status"] == "late"),
            "early": sum(1 for r in rows if r["status"] == "early"),
            "missed": sum(1 for r in rows if r["status"] == "missed"),
            "absent": sum(1 for r in rows if r["status"] == "absent"),
            "pos_bad": sum(1 for r in rows if r["pos_dev"] is not None and r["pos_dev"] >= POSITION_THRESHOLD),
            "avg_delta": round(sum(r["delta"] for r in timed) / len(timed), 2) if timed else None,
            "max_abs_delta": round(max((abs(r["delta"]) for r in timed), default=0), 2),
            "avg_pos": round(sum(r["pos_dev"] for r in poss) / len(poss), 2) if poss else None,
            "max_pos": round(max((r["pos_dev"] for r in poss), default=0), 2),
            "rows": rows,
        })

    n_timed = stats["beat_late"] + stats["beat_early"]
    n_actor_timed = stats["late"] + stats["early"]
    stats["avg_beat_delta"] = round(
        (stats["late_total"] - stats["early_total"]) / n_timed, 2) if n_timed else None
    stats["avg_actor_delta"] = round(
        (stats["actor_late_total"] - stats["actor_early_total"]) / n_actor_timed, 2) if n_actor_timed else None
    stats["avg_pos"] = round(stats["pos_total"] / stats["pos_count"], 2) if stats["pos_count"] else None
    stats["late_total"] = round(stats["late_total"], 2)
    stats["early_total"] = round(stats["early_total"], 2)
    stats["pos_total"] = round(stats["pos_total"], 2)

    return {
        "rehearsal_id": rec["id"], "name": rec.get("name", ""),
        "notes": rec.get("notes", ""), "status": rec.get("status", "running"),
        "origin": origin, "scene_id": scene_id,
        "scene_name": rec.get("scene_name", ""),
        "beats": beats_out, "actors": actors_out, "stats": stats,
    }


# ---------------------------------------------------------------- 两次排练对比
def compare_reviews(r1, r2):
    """并排比较两次同场景排练，找出反复出现的迟到与走位偏移。"""
    bmap1 = {b["beat_id"]: b for b in r1["beats"]}
    bmap2 = {b["beat_id"]: b for b in r2["beats"]}

    # 以计划节点顺序并集（同快照场景一般一致）
    order = []
    for b in r1["beats"]:
        order.append(b["beat_id"])
    for b in r2["beats"]:
        if b["beat_id"] not in order:
            order.append(b["beat_id"])

    rows = []
    recurring_time = []
    recurring_pos = []
    for bid in order:
        e1, e2 = bmap1.get(bid), bmap2.get(bid)
        base = e1 or e2
        row = {"beat_id": bid, "name": base["name"], "planned": base["planned"],
               "d1": e1["delta"] if e1 else None, "d2": e2["delta"] if e2 else None,
               "actors": []}
        if row["d1"] is not None and row["d2"] is not None:
            if row["d1"] > LATE_THRESHOLD and row["d2"] > LATE_THRESHOLD:
                row["recurring"] = "late"
                recurring_time.append(row)
            elif row["d1"] < -LATE_THRESHOLD and row["d2"] < -LATE_THRESHOLD:
                row["recurring"] = "early"
                recurring_time.append(row)
        amap1 = {a["actor_id"]: a for a in (e1["actors"] if e1 else [])}
        amap2 = {a["actor_id"]: a for a in (e2["actors"] if e2 else [])}
        for aid in sorted(set(amap1) | set(amap2)):
            a1, a2 = amap1.get(aid), amap2.get(aid)
            ab = a1 or a2
            ar = {"actor_id": aid, "actor_name": ab["actor_name"], "color": ab.get("color"),
                  "d1": a1["delta"] if a1 else None, "d2": a2["delta"] if a2 else None,
                  "p1": a1["pos_dev"] if a1 else None, "p2": a2["pos_dev"] if a2 else None,
                  "x1": a1["x"] if a1 else None, "y1": a1["y"] if a1 else None,
                  "x2": a2["x"] if a2 else None, "y2": a2["y"] if a2 else None,
                  "plan_x": ab["plan_x"], "plan_y": ab["plan_y"],
                  "s1": a1["status"] if a1 else "missing",
                  "s2": a2["status"] if a2 else "missing",
                  "note1": a1["note"] if a1 else "", "note2": a2["note"] if a2 else ""}
            if ar["d1"] is not None and ar["d2"] is not None and \
                    ar["d1"] > LATE_THRESHOLD and ar["d2"] > LATE_THRESHOLD:
                ar["recurring_time"] = "late"
            elif ar["d1"] is not None and ar["d2"] is not None and \
                    ar["d1"] < -LATE_THRESHOLD and ar["d2"] < -LATE_THRESHOLD:
                ar["recurring_time"] = "early"
            if ar["p1"] is not None and ar["p2"] is not None and \
                    ar["p1"] >= POSITION_THRESHOLD and ar["p2"] >= POSITION_THRESHOLD:
                ar["recurring_pos"] = True
                recurring_pos.append({"beat_id": bid, "beat_name": base["name"], **ar})
            row["actors"].append(ar)
        rows.append(row)

    return {
        "r1": {"id": r1["rehearsal_id"], "name": r1["name"], "stats": r1["stats"]},
        "r2": {"id": r2["rehearsal_id"], "name": r2["name"], "stats": r2["stats"]},
        "rows": rows,
        "recurring_time": [
            {"beat_id": r["beat_id"], "name": r["name"], "d1": r["d1"], "d2": r["d2"]}
            for r in recurring_time],
        "recurring_pos": recurring_pos,
    }


# ---------------------------------------------------------------- 生成编排副本
def promote_to_document(stage, snap, scene_id, selections):
    """把选中的实测时间/位置复制到新的编排文档副本（不改原方案）。

    selections: {"name": 新舞台名, "times": [[beat_id, actor_id]...] 节点级用 beat_id,
                 "positions": [[beat_id, actor_id]...]}
    - times 中 actor_id 为 None 表示采用节点实测时刻。
    """
    doc = copy.deepcopy(snap)
    new_id = uuid.uuid4().hex
    idmap = {}
    for table in ("regions", "actors", "scenes", "beats", "placements", "paths"):
        for row in doc.get(table, []):
            idmap[row["id"]] = uuid.uuid4().hex
            row["id"] = idmap[row["id"]]
            row["stage_id"] = new_id
    doc["stage"] = {
        "id": new_id,
        "name": selections.get("name") or (stage["name"] + " · 排练修订副本"),
        "width": stage["width"], "height": stage["height"],
    }
    # 重映射外键
    for b in doc.get("beats", []):
        if b.get("scene_id"):
            b["scene_id"] = idmap.get(b["scene_id"], b["scene_id"])
    for p in doc.get("placements", []):
        p["beat_id"] = idmap.get(p["beat_id"], p["beat_id"])
        p["actor_id"] = idmap.get(p["actor_id"], p["actor_id"])
    for p in doc.get("paths", []):
        p["from_beat_id"] = idmap.get(p["from_beat_id"], p["from_beat_id"])
        p["to_beat_id"] = idmap.get(p["to_beat_id"], p["to_beat_id"])
        p["actor_id"] = idmap.get(p["actor_id"], p["actor_id"])

    # selections 中的 id 是快照 id
    origin = float(selections.get("origin", 0))
    for bid, aid, t in selections.get("times", []):
        if aid is None:
            beat = next((b for b in doc["beats"] if b["id"] == idmap.get(bid)), None)
            if beat is not None and t is not None:
                beat["time"] = round(origin + float(t), 2)
    for bid, aid, x, y in selections.get("positions", []):
        pl = next((p for p in doc["placements"]
                   if p["beat_id"] == idmap.get(bid) and p["actor_id"] == idmap.get(aid)), None)
        if pl is not None and x is not None and y is not None:
            pl["x"], pl["y"] = round(float(x), 3), round(float(y), 3)
    return doc


# ---------------------------------------------------------------- 打印派生
def build_review_print(rec, review):
    """打印复盘单派生：按场景（排练即单场景）→ 演员 → 节点行。"""
    actors_out = []
    for agg in review["actors"]:
        rows = []
        for e in review["beats"]:
            a = next((x for x in e["actors"] if x["actor_id"] == agg["actor_id"]), None)
            if a:
                rows.append({"beat_name": e["name"], "planned": e["planned"], **a})
        actors_out.append({"actor": {"name": agg["actor_name"], "color": agg["color"]},
                           "agg": agg, "rows": rows})
    return {"actors": actors_out}


def offset_direction(dx, dy):
    """实测相对计划位置偏移的中文方位（观众视角：x 右为舞台右，y 下为观众侧）。"""
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        return ""
    ns = "观众侧" if dy > 0 else "后台侧"
    ew = "舞台右" if dx > 0 else "舞台左"
    if abs(dx) < 0.35 * max(abs(dy), 1e-9):
        return ns
    if abs(dy) < 0.35 * max(abs(dx), 1e-9):
        return ew
    return ew + ns
