"""Flask 应用入口：应用工厂 + REST/页面路由。"""
import json
import math
import os
import uuid

from flask import Flask, abort, jsonify, render_template, request

from . import db
from .analysis import analyze_document, build_print_data
from .changeover import analyze_changeover, build_changeover_print
from .review import (
    build_review, build_review_print, compare_reviews, promote_to_document,
    snapshot_doc,
)
from .sightline import (
    analyze_sightlines, compare_results, sight_map_bounds, summarize_results,
)


def create_app(db_path=None, testing=False):
    app = Flask(__name__)
    app.config["TESTING"] = testing
    app.jinja_env.filters["sin"] = math.sin
    app.jinja_env.filters["cos"] = math.cos
    if db_path is None:
        db_path = os.environ.get("STAGEPLANNER_DB", "stageplanner.db")
    db.init_db(db_path)

    # ------------------------------------------------------------------ pages
    @app.route("/")
    def index():
        stages = db.list_stages()
        current = stages[0] if stages else None
        return render_template("index.html", stages=stages, current=current)

    @app.route("/stages/<stage_id>")
    def stage_page(stage_id):
        stages = db.list_stages()
        current = db.get_stage(stage_id)
        if current is None:
            abort(404)
        return render_template("index.html", stages=stages, current=current["stage"])

    # ------------------------------------------------------------------- API
    @app.get("/api/stages")
    def list_stages_api():
        return jsonify(db.list_stages())

    @app.post("/api/stages")
    def create_stage():
        data = request.get_json(force=True) or {}
        name = (data.get("name") or "未命名舞台").strip()
        try:
            width = float(data.get("width", 12))
            height = float(data.get("height", 8))
        except (TypeError, ValueError):
            return jsonify(error="宽高必须是数字"), 400
        if not (0.5 < width <= 100 and 0.5 < height <= 100):
            return jsonify(error="舞台尺寸应在 0.5 ~ 100 米之间"), 400
        doc = {
            "stage": {"id": uuid.uuid4().hex, "name": name,
                      "width": width, "height": height},
            "regions": [], "actors": [], "scenes": [],
            "beats": [], "placements": [], "paths": [],
            "crews": [], "props": [], "gates": [], "set_positions": [],
            "shifts": [], "shift_ops": [], "shift_deps": [],
            "audience_zones": [], "focus_points": [], "sight_targets": [],
        }
        saved = db.save_document(doc)
        return jsonify(_serialize(saved)), 201

    @app.get("/api/stages/<stage_id>")
    def get_stage(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        return jsonify(_serialize(doc))

    @app.put("/api/stages/<stage_id>")
    def update_stage(stage_id):
        existing = db.get_stage(stage_id)
        if existing is None:
            return jsonify(error="舞台不存在"), 404
        data = request.get_json(force=True) or {}
        if not _valid_document(data, stage_id):
            return jsonify(error="文档数据不完整或结构有误"), 400
        saved = db.save_document(data)
        return jsonify(_serialize(saved))

    @app.delete("/api/stages/<stage_id>")
    def delete_stage(stage_id):
        conn = db.get_conn()
        try:
            cur = conn.execute("DELETE FROM stages WHERE id=?", (stage_id,))
            conn.commit()
        finally:
            conn.close()
        if cur.rowcount == 0:
            return jsonify(error="舞台不存在"), 404
        return jsonify(ok=True)

    @app.get("/api/stages/<stage_id>/analyze")
    def stage_analyze(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        return jsonify(analyze_document(_serialize(doc)))

    @app.get("/api/stages/<stage_id>/changeover")
    def stage_changeover(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        return jsonify(analyze_changeover(_serialize(doc)))

    @app.get("/print/stages/<stage_id>/changeover")
    def print_changeover(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            abort(404)
        payload = _serialize(doc)
        cp = build_changeover_print(payload)
        return render_template("print_changeover.html", d=payload, cp=cp)

    # ----------------------------------------------------- 观众视线校核
    @app.get("/api/stages/<stage_id>/sightlines")
    def stage_sightlines(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        return jsonify(analyze_sightlines(_serialize(doc)))

    @app.get("/api/stages/<stage_id>/sight_checks")
    def list_sight_checks_api(stage_id):
        if db.get_stage(stage_id) is None:
            return jsonify(error="舞台不存在"), 404
        out = []
        for rec in db.list_sight_checks(stage_id):
            results = json.loads(rec["results"])
            out.append({"id": rec["id"], "name": rec["name"],
                        "created_at": rec["created_at"],
                        "summary": summarize_results(results)})
        return jsonify(out)

    @app.post("/api/stages/<stage_id>/sight_checks")
    def create_sight_check(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        data = request.get_json(force=True) or {}
        results = analyze_sightlines(_serialize(doc))
        name = (data.get("name") or "").strip()[:80]
        if not name:
            from datetime import datetime
            name = "校核 " + datetime.now().strftime("%m-%d %H:%M")
        rec = db.insert_sight_check({
            "id": uuid.uuid4().hex, "stage_id": stage_id,
            "name": name, "results": results,
        })
        return jsonify(_sight_check_json(rec)), 201

    @app.get("/api/sight_checks/<check_id>")
    def get_sight_check_api(check_id):
        rec = db.get_sight_check(check_id)
        if rec is None:
            return jsonify(error="校核版本不存在"), 404
        return jsonify(_sight_check_json(rec))

    @app.delete("/api/sight_checks/<check_id>")
    def delete_sight_check_api(check_id):
        if not db.delete_sight_check(check_id):
            return jsonify(error="校核版本不存在"), 404
        return jsonify(ok=True)

    @app.get("/api/stages/<stage_id>/sight_checks/compare")
    def sight_checks_compare(stage_id):
        """比较两个校核结果；a/b 为版本 id 或 current（当前文档即时计算）。"""
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404

        def load(which):
            if which == "current":
                return {"id": "current", "name": "当前编排",
                        "results": analyze_sightlines(_serialize(doc))}
            rec = db.get_sight_check(which or "")
            if rec is None or rec["stage_id"] != stage_id:
                return None
            return {"id": rec["id"], "name": rec["name"],
                    "results": json.loads(rec["results"])}

        a = load(request.args.get("a"))
        b = load(request.args.get("b"))
        if a is None or b is None:
            return jsonify(error="待比较的校核版本不存在"), 404
        cmp_ = compare_results(a["results"], b["results"])
        cmp_["a"] = {"id": a["id"], "name": a["name"]}
        cmp_["b"] = {"id": b["id"], "name": b["name"]}
        return jsonify(cmp_)

    @app.get("/print/stages/<stage_id>/sightlines")
    def print_sightlines(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            abort(404)
        payload = _serialize(doc)
        result = analyze_sightlines(payload)
        return render_template("print_sightlines.html", d=payload,
                               analysis=result,
                               bounds=sight_map_bounds(payload))

    # ----------------------------------------------------- 排练实录 / 复盘
    @app.get("/api/stages/<stage_id>/rehearsals")
    def list_rehearsals(stage_id):
        if db.get_stage(stage_id) is None:
            return jsonify(error="舞台不存在"), 404
        return jsonify(db.list_rehearsals(stage_id))

    @app.post("/api/stages/<stage_id>/rehearsals")
    def create_rehearsal(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            return jsonify(error="舞台不存在"), 404
        payload = _serialize(doc)
        data = request.get_json(force=True) or {}
        scene_id = data.get("scene_id")
        scene = next((s for s in payload["scenes"] if s["id"] == scene_id), None)
        if scene is None:
            return jsonify(error="请选择要排练的场景"), 400
        scene_beats = sorted(
            (b for b in payload["beats"] if b.get("scene_id") == scene_id),
            key=lambda b: (b["position"], b["name"]))
        if not scene_beats:
            return jsonify(error="该场景还没有节点"), 400
        origin = min(b["time"] for b in scene_beats)
        rec = {
            "id": uuid.uuid4().hex,
            "stage_id": stage_id,
            "scene_id": scene_id,
            "scene_name": scene["name"],
            "name": (data.get("name") or f"{scene['name']} 排练").strip()[:80],
            "snapshot": payload,
            "notes": "",
            "status": "running",
            "origin": origin,
            "clock_elapsed": 0,
            "clock_running": False,   # 倒计时结束、前端收到响应后才起算
            "clock_at": None,
            "beat_marks": [],
            "actor_marks": [],
        }
        return jsonify(_rehearsal_json(db.insert_rehearsal(rec))), 201

    @app.get("/api/rehearsals/<rehearsal_id>")
    def get_rehearsal(rehearsal_id):
        rec = db.get_rehearsal(rehearsal_id)
        if rec is None:
            return jsonify(error="排练不存在"), 404
        return jsonify(_rehearsal_json(rec))

    @app.put("/api/rehearsals/<rehearsal_id>")
    def update_rehearsal(rehearsal_id):
        rec = db.get_rehearsal(rehearsal_id)
        if rec is None:
            return jsonify(error="排练不存在"), 404
        data = request.get_json(force=True) or {}
        if not _valid_rehearsal_payload(data, rec):
            return jsonify(error="排练数据结构有误"), 400
        rec["name"] = (data.get("name") or rec["name"])[:80]
        rec["notes"] = data.get("notes", "")
        rec["status"] = data.get("status", rec["status"])
        if rec["status"] not in ("running", "finished"):
            return jsonify(error="状态值无效"), 400
        rec["clock_elapsed"] = float(data.get("clock_elapsed", rec["clock_elapsed"]))
        rec["clock_running"] = bool(data.get("clock_running"))
        rec["clock_at"] = data.get("clock_at")
        rec["beat_marks"] = data.get("beat_marks", [])
        rec["actor_marks"] = data.get("actor_marks", [])
        saved = db.save_rehearsal(rec)
        return jsonify(_rehearsal_json(saved))

    @app.delete("/api/rehearsals/<rehearsal_id>")
    def remove_rehearsal(rehearsal_id):
        if not db.delete_rehearsal(rehearsal_id):
            return jsonify(error="排练不存在"), 404
        return jsonify(ok=True)

    @app.get("/api/rehearsals/<rehearsal_id>/review")
    def rehearsal_review(rehearsal_id):
        rec = db.get_rehearsal(rehearsal_id)
        if rec is None:
            return jsonify(error="排练不存在"), 404
        return jsonify(build_review(rec))

    @app.get("/api/stages/<stage_id>/rehearsals/compare")
    def rehearsals_compare(stage_id):
        if db.get_stage(stage_id) is None:
            return jsonify(error="舞台不存在"), 404
        a = request.args.get("a"); b = request.args.get("b")
        r1, r2 = db.get_rehearsal(a), db.get_rehearsal(b)
        if r1 is None or r2 is None:
            return jsonify(error="待比较的排练不存在"), 404
        return jsonify(compare_reviews(build_review(r1), build_review(r2)))

    @app.post("/api/rehearsals/<rehearsal_id>/promote")
    def promote_rehearsal(rehearsal_id):
        rec = db.get_rehearsal(rehearsal_id)
        if rec is None:
            return jsonify(error="排练不存在"), 404
        data = request.get_json(force=True) or {}
        stage = db.get_stage(rec["stage_id"])
        try:
            times = [[str(t[0]), (None if t[1] is None else str(t[1])),
                      (None if t[2] is None else float(t[2]))]
                     for t in data.get("times", [])]
            positions = [[str(p[0]), str(p[1]), float(p[2]), float(p[3])]
                         for p in data.get("positions", [])]
        except (KeyError, IndexError, TypeError, ValueError):
            return jsonify(error="复制选项格式有误"), 400
        doc = promote_to_document(
            stage["stage"], snapshot_doc(rec), rec.get("scene_id"),
            {"name": data.get("name"), "origin": rec.get("origin", 0),
             "times": times, "positions": positions})
        saved = db.save_document(doc)
        return jsonify(_serialize(saved)), 201

    # 打印：可打印复盘单（可带第二次排练做对比）
    @app.get("/print/rehearsals/<rehearsal_id>/review")
    def print_rehearsal_review(rehearsal_id):
        rec = db.get_rehearsal(rehearsal_id)
        if rec is None:
            abort(404)
        review = build_review(rec)
        print_data = build_review_print(rec, review)
        other_id = request.args.get("compare")
        other = comparison = None
        if other_id:
            rec2 = db.get_rehearsal(other_id)
            if rec2 is not None:
                review2 = build_review(rec2)
                other = {"rec": rec2, "review": review2,
                         "print_data": build_review_print(rec2, review2)}
                comparison = compare_reviews(review, review2)
        return render_template(
            "print_review.html", rec=rec, review=review, print_data=print_data,
            other=other, comparison=comparison,
            late_threshold=1.0, pos_threshold=0.5)

    # 打印：演员提示单（按场景分组）与可打印总览
    @app.get("/print/stages/<stage_id>/cues")
    def print_cues(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            abort(404)
        payload = _serialize(doc)
        result = analyze_document(payload)
        print_data = build_print_data(payload, result)
        return render_template("print_cues.html", d=payload, analysis=result,
                               print_data=print_data)

    @app.get("/print/stages/<stage_id>/overview")
    def print_overview(stage_id):
        doc = db.get_stage(stage_id)
        if doc is None:
            abort(404)
        payload = _serialize(doc)
        result = analyze_document(payload)
        return render_template("print_overview.html", d=payload, analysis=result)

    return app


def _serialize(doc):
    """JSON 字段（points/paths）解析，updated_at 透出。"""
    out = dict(doc)
    stage = dict(out["stage"])
    out["stage"] = stage
    for key in ("regions",):
        out[key] = [{**r, "points": json.loads(r["points"])} for r in out[key]]
    out["paths"] = [{**p, "points": json.loads(p["points"])} for p in out["paths"]]
    out["props"] = [{**p, "gates": json.loads(p["gates"])} for p in out["props"]]
    out["shift_ops"] = [{**o, "route": json.loads(o["route"])} for o in out["shift_ops"]]
    out["audience_zones"] = [
        {**z, "points": json.loads(z["points"])} for z in out["audience_zones"]]
    return out


def _sight_check_json(rec):
    """校核版本序列化：results JSON 解析为对象。"""
    return {"id": rec["id"], "stage_id": rec["stage_id"], "name": rec["name"],
            "created_at": rec["created_at"],
            "results": json.loads(rec["results"]) if isinstance(rec.get("results"), str)
            else rec.get("results")}


def _rehearsal_json(rec):
    """排练记录序列化：snapshot JSON 解析为文档对象。"""
    out = dict(rec)
    out["snapshot"] = snapshot_doc(rec)
    out["clock_running"] = bool(rec.get("clock_running"))
    return out


def datetime_now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _valid_rehearsal_payload(data, existing):
    if not isinstance(data, dict):
        return False
    snap_ids = {b["id"] for b in snapshot_doc(existing).get("beats", [])}
    actor_ids = {a["id"] for a in snapshot_doc(existing).get("actors", [])}
    for m in data.get("beat_marks", []):
        if not isinstance(m, dict) or m.get("beat_id") not in snap_ids:
            return False
        if m.get("actual_time") is not None:
            try:
                float(m["actual_time"])
            except (TypeError, ValueError):
                return False
    for m in data.get("actor_marks", []):
        if not isinstance(m, dict) or m.get("beat_id") not in snap_ids \
                or m.get("actor_id") not in actor_ids:
            return False
        for k in ("actual_time", "x", "y"):
            if m.get(k) is not None:
                try:
                    float(m[k])
                except (TypeError, ValueError):
                    return False
    return True


def _valid_document(data, stage_id):
    if not isinstance(data, dict) or "stage" not in data:
        return False
    st = data["stage"]
    if st.get("id") != stage_id:
        return False
    try:
        float(st["width"]); float(st["height"])
    except (KeyError, TypeError, ValueError):
        return False
    for key in ("regions", "actors", "scenes", "beats", "placements", "paths",
                "crews", "props", "gates", "set_positions", "shifts",
                "shift_ops", "shift_deps",
                "audience_zones", "focus_points", "sight_targets"):
        if not isinstance(data.get(key, []), list):
            return False
    return True
