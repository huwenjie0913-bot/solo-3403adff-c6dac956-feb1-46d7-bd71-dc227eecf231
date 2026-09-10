"""走位分析：无法按时到位 / 穿越障碍 / 演员碰撞。

输入为序列化后的整文档 dict（points 已解析为列表），输出：
{
  "problems": [ {"type", "severity", "message", "actor_id",
                 "beat_id", "x", "y", ...定位字段} ],
  "moves":   { "<beatId>:<actorId>": {length, duration, available, ok, path_pts} }
}
"""
from .geometry import (
    dist, point_in_polygon, polyline_length, segment_intersects_polygon,
)

TIMING_TOLERANCE = 0.02  # 允许 20ms 误差
COLLISION_RADIUS = 0.35  # 两名演员位置距离小于此值视为碰撞（米）
TIMESTEP = 0.5           # 碰撞检测时间采样步长（秒）


def analyze_document(doc):
    stage = doc["stage"]
    obstacles = [r for r in doc.get("regions", []) if r.get("kind") == "obstacle"]
    actors = {a["id"]: a for a in doc.get("actors", [])}
    scenes = {s["id"]: s for s in doc.get("scenes", [])}
    beats = sorted(doc.get("beats", []), key=lambda b: (b["position"], b["name"]))
    beats_by_id = {b["id"]: b for b in beats}
    placements = {}
    for p in doc.get("placements", []):
        placements.setdefault(p["beat_id"], {})[p["actor_id"]] = p
    paths = {(p["from_beat_id"], p["to_beat_id"], p["actor_id"]): p["points"]
             for p in doc.get("paths", [])}

    problems = []
    moves = {}

    # ---- 每个演员在同场景相邻节点间的移动（跨场景轨迹断开）----
    for actor in doc.get("actors", []):
        aid = actor["id"]
        prev = None  # (beat, placement)
        prev_scene = None
        for beat in beats:
            if prev_scene is not None and beat.get("scene_id") != prev_scene:
                prev = None
            plist = placements.get(beat["id"], {})
            pl = plist.get(aid)
            if pl is None:
                prev = None
                prev_scene = beat.get("scene_id")
                continue
            here = (pl["x"], pl["y"])

            # 停在障碍内
            for ob in obstacles:
                if point_in_polygon(here[0], here[1], ob["points"]):
                    problems.append(_problem(
                        "obstacle", "error",
                        f"{actor['name']} 在节点「{beat['name']}」的位置位于障碍「{ob['name']}」内",
                        aid, beat["id"], here,
                        scene_id=beat.get("scene_id"),
                        scene_name=(scenes.get(beat.get("scene_id"), {}) or {}).get("name", "")))

            if prev is not None:
                pbeat, ppl, prev_pt = prev
                path_pts = paths.get((pbeat["id"], beat["id"], aid))
                if path_pts is None:
                    path_pts = [(ppl["x"], ppl["y"]), here]
                else:
                    path_pts = [(ppl["x"], ppl["y"]), *[tuple(q) for q in path_pts], here]
                length = polyline_length(path_pts)
                available = max(0.0, beat["time"] - pbeat["time"])
                speed = max(0.01, float(actor.get("speed", 1.2)))
                duration = length / speed
                key = f"{beat['id']}:{aid}"
                move = {
                    "length": round(length, 3),
                    "duration": round(duration, 2),
                    "available": round(available, 2),
                    "required_speed": round(length / available, 2) if available > 1e-9 else None,
                    "ok": duration <= available + TIMING_TOLERANCE,
                    "path_pts": path_pts,
                    "from_beat_id": pbeat["id"],
                    "to_beat_id": beat["id"],
                }
                moves[key] = move

                scene_name = (scenes.get(beat.get("scene_id"), {}) or {}).get("name", "")
                # 超时
                if duration > available + TIMING_TOLERANCE:
                    extra = ""
                    if available > 1e-9:
                        extra = f"（需 {move['required_speed']} m/s，常用 {speed} m/s）"
                    problems.append(_problem(
                        "timing", "error",
                        f"{actor['name']} 「{pbeat['name']}」→「{beat['name']}」："
                        f"{length:.1f}m 需 {duration:.1f}s，仅有 {available:.1f}s{extra}",
                        aid, beat["id"], here,
                        from_beat_id=pbeat["id"],
                        midpoint=_midpoint(path_pts),
                        scene_id=beat.get("scene_id"), scene_name=scene_name))

                # 穿越障碍
                for i in range(len(path_pts) - 1):
                    for ob in obstacles:
                        if segment_intersects_polygon(
                                path_pts[i], path_pts[i + 1], ob["points"]):
                            problems.append(_problem(
                                "obstacle", "error",
                                f"{actor['name']} 「{pbeat['name']}」→「{beat['name']}」"
                                f"的路径穿越障碍「{ob['name']}」",
                                aid, beat["id"], here,
                                from_beat_id=pbeat["id"],
                                midpoint=_seg_mid(path_pts[i], path_pts[i + 1]),
                                scene_id=beat.get("scene_id"), scene_name=scene_name))
                            break
            prev = (beat, pl, here)
            prev_scene = beat.get("scene_id")

    # ---- 碰撞：同一时刻采样路径，检测演员间距 ----
    timeline = _build_timeline(doc, beats, placements, actors, paths)
    actor_ids = [a["id"] for a in doc.get("actors", [])]
    if timeline and len(actor_ids) >= 2:
        t0 = min(b["time"] for b in beats)
        t1 = max(b["time"] for b in beats)
        t = t0
        seen = set()
        while t <= t1 + 1e-9:
            pos = {aid: _position_at(timeline, aid, t) for aid in actor_ids}
            for i in range(len(actor_ids)):
                for j in range(i + 1, len(actor_ids)):
                    a, b = actor_ids[i], actor_ids[j]
                    pa, pb = pos.get(a), pos.get(b)
                    if not pa or not pb:
                        continue
                    if dist(pa[0], pa[1], pb[0], pb[1]) < COLLISION_RADIUS * 2:
                        beat = _beat_for_time(beats, t)
                        sig = (a, b, beat["id"] if beat else None, round(t, 1))
                        if sig in seen:
                            continue
                        seen.add(sig)
                        an, bn = actors[a]["name"], actors[b]["name"]
                        problems.append(_problem(
                            "collision", "warning",
                            f"{an} 与 {bn} 在约 {t:.1f}s（节点「{beat['name'] if beat else '-'}」"
                            f"附近）距离过近，可能碰撞",
                            a, beat["id"] if beat else None,
                            ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2),
                            scene_id=beat.get("scene_id") if beat else None,
                            scene_name=(scenes.get(beat.get("scene_id"), {}) or {}).get("name", "") if beat else "",
                            other_actor_id=b))
            t += TIMESTEP

    return {"problems": problems, "moves": moves}


def facing_text(deg):
    """朝向角度转中文描述（0=朝观众，90=舞台右，180=台后，270=舞台左）。"""
    d = ((deg % 360) + 360) % 360
    dirs = [(22.5, "正观众"), (67.5, "台右偏观众"), (112.5, "舞台右"),
            (157.5, "台右偏后台"), (202.5, "正后台"), (247.5, "台左偏后台"),
            (292.5, "舞台左"), (337.5, "台左偏观众")]
    for limit, name in dirs:
        if d < limit:
            return name
    return "正观众"


def build_print_data(doc, analysis):
    """打印用派生数据：按场景 -> 演员 -> 节点行。"""
    beats = sorted(doc.get("beats", []), key=lambda b: (b["position"], b["name"]))
    placements = {}
    for p in doc.get("placements", []):
        placements.setdefault(p["beat_id"], {})[p["actor_id"]] = p
    obstacle_problems = {
        (p["beat_id"], p["actor_id"])
        for p in analysis["problems"] if p["type"] == "obstacle" and p.get("beat_id")
    }

    scenes_out = []
    for scene in doc.get("scenes", []):
        scene_beats = [b for b in beats if b.get("scene_id") == scene["id"]]
        actors_out = []
        for actor in doc.get("actors", []):
            rows = []
            last_pl = None
            for i, beat in enumerate(scene_beats):
                pl = placements.get(beat["id"], {}).get(actor["id"])
                if pl is None:
                    continue
                length = duration = available = None
                timing_bad = obs_bad = False
                if last_pl is not None:
                    m = analysis["moves"].get(f"{beat['id']}:{actor['id']}")
                    if m:
                        length, duration, available = m["length"], m["duration"], m["available"]
                        timing_bad = not m["ok"]
                    obs_bad = (beat["id"], actor["id"]) in obstacle_problems
                rows.append({
                    "beat": beat, "pl": pl, "first": last_pl is None,
                    "length": length, "duration": duration, "available": available,
                    "timing_bad": timing_bad, "obs_bad": obs_bad,
                    "facing_text": facing_text(pl.get("facing", 0)),
                })
                last_pl = pl
            if rows:
                actors_out.append({"actor": actor, "rows": rows})
        scenes_out.append({"scene": scene, "beats": scene_beats, "actors": actors_out})
    return {"scenes": scenes_out, "facing_text": facing_text}


def _problem(ptype, severity, message, actor_id, beat_id, xy, **extra):
    p = {"type": ptype, "severity": severity, "message": message,
         "actor_id": actor_id, "beat_id": beat_id,
         "x": round(xy[0], 3) if xy else None,
         "y": round(xy[1], 3) if xy else None}
    p.update(extra)
    return p


def _midpoint(pts):
    total = polyline_length(pts)
    target = total / 2
    acc = 0
    for i in range(len(pts) - 1):
        seg = dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
        if acc + seg >= target and seg > 0:
            r = (target - acc) / seg
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
                    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r)
        acc += seg
    return pts[-1]


def _seg_mid(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def _build_timeline(doc, beats, placements, actors, paths):
    """每个演员：[(t0,t1,[(x,y)...]), ...] 分段线性轨迹（跨场景断开）。"""
    timeline = {a["id"]: [] for a in doc.get("actors", [])}
    for actor in doc.get("actors", []):
        aid = actor["id"]
        prev = None
        prev_scene = None
        for beat in beats:
            if prev_scene is not None and beat.get("scene_id") != prev_scene:
                prev = None
            pl = placements.get(beat["id"], {}).get(aid)
            if pl is None:
                prev = None
                prev_scene = beat.get("scene_id")
                continue
            here = (pl["x"], pl["y"])
            if prev is not None:
                pbeat, ppl = prev
                pts = paths.get((pbeat["id"], beat["id"], aid))
                if pts:
                    pts = [(ppl["x"], ppl["y"]), *[tuple(q) for q in pts], here]
                else:
                    pts = [(ppl["x"], ppl["y"]), here]
                timeline[aid].append((pbeat["time"], beat["time"], pts))
            else:
                timeline[aid].append((None, beat["time"], [here]))
            prev = (beat, pl)
            prev_scene = beat.get("scene_id")
    return timeline


def _position_at(timeline, aid, t):
    for t0, t1, pts in timeline.get(aid, []):
        if t0 is None:
            if abs(t - t1) < 1e-9 or t <= t1:
                return pts[-1]
            continue
        if t0 - 1e-9 <= t <= t1 + 1e-9:
            if t1 - t0 < 1e-9:
                return pts[-1]
            total = polyline_length(pts)
            if total < 1e-9:
                return pts[-1]
            target = total * (t - t0) / (t1 - t0)
            acc = 0
            for i in range(len(pts) - 1):
                seg = dist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
                if acc + seg >= target:
                    r = 0 if seg == 0 else (target - acc) / seg
                    return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r,
                            pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r)
                acc += seg
            return pts[-1]
    return None


def _beat_for_time(beats, t):
    cand = [b for b in beats if abs(b["time"] - t) < TIMESTEP + 1e-6]
    if cand:
        return cand[0]
    future = [b for b in beats if b["time"] >= t]
    return future[0] if future else (beats[-1] if beats else None)
