"""Flask 应用入口：应用工厂 + REST/页面路由。"""
import json
import math
import os
import uuid

from flask import Flask, abort, jsonify, render_template, request

from . import db
from .analysis import analyze_document, build_print_data


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
    return out


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
    for key in ("regions", "actors", "scenes", "beats", "placements", "paths"):
        if not isinstance(data.get(key, []), list):
            return False
    return True
