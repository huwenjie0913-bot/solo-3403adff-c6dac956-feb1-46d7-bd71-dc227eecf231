"""端到端冒烟测试：应用工厂、首页、文档保存、问题分析、打印路由。"""
import glob
import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from stageplanner.app import create_app
from stageplanner.analysis import analyze_document, facing_text
from stageplanner import geometry as geo


def make_doc():
    return {
        "stage": {"id": "s1", "name": "测试舞台", "width": 12.0, "height": 8.0},
        "regions": [
            {"id": "r1", "stage_id": "s1", "name": "主表演区", "kind": "area",
             "points": [[2, 2], [10, 2], [10, 6], [2, 6]], "color": "#8ab4f8"},
            {"id": "o1", "stage_id": "s1", "name": "大道具", "kind": "obstacle",
             "points": [[5, 3], [7, 3], [7, 5], [5, 5]], "color": "#d9534f"},
        ],
        "actors": [
            {"id": "a1", "stage_id": "s1", "name": "甲", "speed": 1.2, "color": "#e8734a"},
            {"id": "a2", "stage_id": "s1", "name": "乙", "speed": 1.2, "color": "#3f8fdd"},
        ],
        "scenes": [{"id": "sc1", "stage_id": "s1", "name": "第一幕", "position": 0}],
        "beats": [
            {"id": "b1", "stage_id": "s1", "scene_id": "sc1", "name": "节点1", "position": 1, "time": 0.0},
            {"id": "b2", "stage_id": "s1", "scene_id": "sc1", "name": "节点2", "position": 2, "time": 1.0},
        ],
        "placements": [
            {"id": "p1", "stage_id": "s1", "beat_id": "b1", "actor_id": "a1", "x": 1.0, "y": 4.0, "facing": 0},
            {"id": "p2", "stage_id": "s1", "beat_id": "b2", "actor_id": "a1", "x": 11.0, "y": 4.0, "facing": 90},
            {"id": "p3", "stage_id": "s1", "beat_id": "b1", "actor_id": "a2", "x": 3.0, "y": 4.0, "facing": 0},
            {"id": "p4", "stage_id": "s1", "beat_id": "b2", "actor_id": "a2", "x": 4.0, "y": 4.0, "facing": 0},
        ],
        "paths": [],
    }


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "test.db"), testing=True)
    return app.test_client()


def test_create_app_and_import():
    app = create_app(db_path=":memory:")
    assert app.name == "stageplanner.app"


def test_index_empty(tmp_path):
    app = create_app(db_path=str(tmp_path / "empty.db"))
    rv = app.test_client().get("/")
    assert rv.status_code == 200
    assert "舞台走位编排".encode() in rv.data


def test_create_stage_api(client):
    rv = client.post("/api/stages", json={"name": "新台", "width": 10, "height": 6})
    assert rv.status_code == 201
    data = rv.get_json()
    assert data["stage"]["name"] == "新台"
    assert client.get(f"/stages/{data['stage']['id']}").status_code == 200


def test_invalid_stage_size(client):
    rv = client.post("/api/stages", json={"name": "坏", "width": 0, "height": 8})
    assert rv.status_code == 400


def test_full_workflow(client):
    # 建台 -> 保存文档 -> 读回一致
    sid = client.post("/api/stages", json={"name": "w"}).get_json()["stage"]["id"]
    doc = make_doc()
    doc["stage"]["id"] = sid
    rv = client.put(f"/api/stages/{sid}", json=doc)
    assert rv.status_code == 200
    got = client.get(f"/api/stages/{sid}").get_json()
    assert len(got["placements"]) == 4
    assert got["regions"][1]["points"] == [[5, 3], [7, 3], [7, 5], [5, 5]]

    # 分析接口：10m 直线 1s、速度 1.2 -> 超时；穿过 [5,3]-[7,5] 障碍 -> 穿越
    res = client.get(f"/api/stages/{sid}/analyze").get_json()
    types = {(p["type"], p["actor_id"]) for p in res["problems"]}
    assert ("timing", "a1") in types
    assert ("obstacle", "a1") in types
    # 提示单与总览可渲染
    assert client.get(f"/print/stages/{sid}/cues").status_code == 200
    ov = client.get(f"/print/stages/{sid}/overview")
    assert ov.status_code == 200
    assert b"svg" in ov.data.lower()

    # 整文档更新的删除同步：删掉障碍与一个节点（连带其走位）
    doc["regions"] = [r for r in doc["regions"] if r["id"] != "o1"]
    doc["beats"] = [b for b in doc["beats"] if b["id"] != "b2"]
    doc["placements"] = [p for p in doc["placements"] if p["beat_id"] != "b2"]
    client.put(f"/api/stages/{sid}", json=doc)
    got2 = client.get(f"/api/stages/{sid}").get_json()
    assert all(r["kind"] == "area" for r in got2["regions"])
    assert len(got2["beats"]) == 1

    client.delete(f"/api/stages/{sid}")
    assert client.get(f"/api/stages/{sid}").status_code == 404


def test_analysis_units():
    doc = make_doc()
    result = analyze_document(doc)
    timing = [p for p in result["problems"] if p["type"] == "timing"]
    assert timing and timing[0]["x"] == 11 and timing[0]["beat_id"] == "b2"
    assert any(p["type"] == "obstacle" and "穿越" in p["message"] for p in result["problems"])
    # 同点的两个演员（甲 b2 在 11,4 之外；构造碰撞）
    doc["placements"][2]["x"], doc["placements"][2]["y"] = 1.0, 4.0
    doc["placements"][3]["x"], doc["placements"][3]["y"] = 11.0, 4.0
    result2 = analyze_document(doc)
    assert any(p["type"] == "collision" for p in result2["problems"])


def test_geometry():
    assert geo.segments_intersect((0, 0), (10, 10), (0, 10), (10, 0))
    assert not geo.segments_intersect((0, 0), (1, 1), (2, 2), (3, 3))
    assert geo.point_in_polygon(6, 4, [[5, 3], [7, 3], [7, 5], [5, 5]])
    assert not geo.point_in_polygon(0, 0, [[5, 3], [7, 3], [7, 5], [5, 5]])
    assert geo.polyline_length([[0, 0], [3, 4]]) == 5
    # 端点正好落在障碍顶点不算穿越
    assert not geo.segment_intersects_polygon((5, 3), (5, 5), [[5, 3], [7, 3], [7, 5], [5, 5]])


def test_facing_text():
    assert facing_text(0) == "正观众"
    assert facing_text(90) == "舞台右"
    assert facing_text(180) == "正后台"


# ------------------------------------------------------------- 排练实录 / 复盘
def _rehearsal_doc(sid="s9"):
    doc = make_doc()
    doc["stage"]["id"] = sid
    return doc


def test_rehearsal_full_flow(client):
    sid = client.post("/api/stages", json={"name": "排练台"}).get_json()["stage"]["id"]
    doc = _rehearsal_doc(sid)
    client.put(f"/api/stages/{sid}", json=doc)

    # 未选场景应被拒绝
    rv = client.post(f"/api/stages/{sid}/rehearsals", json={})
    assert rv.status_code == 400

    rv = client.post(f"/api/stages/{sid}/rehearsals", json={"scene_id": "sc1", "name": "首排"})
    assert rv.status_code == 201
    rec = rv.get_json()
    rid = rec["id"]
    assert rec["scene_name"] == "第一幕"
    assert rec["origin"] == 0.0
    assert rec["snapshot"]["stage"]["id"] == sid   # 快照随排练冻结
    assert client.get(f"/api/stages/{sid}/rehearsals").get_json()[0]["id"] == rid

    # b1 甲晚到 1.5s 且位置偏移 1m；乙完全未打点；b2 整节点漏记；甲 b2 缺席
    payload = {
        "name": "首排", "notes": "整体偏慢", "status": "running",
        "clock_elapsed": 9.0, "clock_running": False, "clock_at": None,
        "beat_marks": [
            {"id": "bm1", "beat_id": "b1", "actual_time": 1.5, "note": ""},
            {"id": "bm2", "beat_id": "b2", "actual_time": None, "note": "节点漏记"},
        ],
        "actor_marks": [
            {"id": "am1", "beat_id": "b1", "actor_id": "a1",
             "actual_time": 1.6, "x": 2.0, "y": 4.0, "absent": 0, "note": "慢"},
            {"id": "am3", "beat_id": "b2", "actor_id": "a1",
             "actual_time": None, "x": None, "y": None, "absent": 1, "note": ""},
        ],
    }
    assert client.put(f"/api/rehearsals/{rid}", json=payload).status_code == 200

    review = client.get(f"/api/rehearsals/{rid}/review").get_json()
    b1 = next(b for b in review["beats"] if b["beat_id"] == "b1")
    b2 = next(b for b in review["beats"] if b["beat_id"] == "b2")
    assert b1["status"] == "late" and b1["delta"] == 1.5
    assert b2["status"] == "missing"
    a2_b1 = next(a for a in b1["actors"] if a["actor_id"] == "a2")
    assert a2_b1["status"] == "missed"
    assert a2_b1["pos_dev"] is None and a2_b1["actual_time"] is None
    a1_b1 = next(a for a in b1["actors"] if a["actor_id"] == "a1")
    assert a1_b1["pos_dev"] == 1.0
    assert review["stats"]["beat_missing"] == 1
    assert review["stats"]["absent"] >= 1

    # 关键回归：含漏打点（pos_dev=None）时打印复盘单不得 500
    rv = client.get(f"/print/rehearsals/{rid}/review")
    assert rv.status_code == 200
    assert "排练复盘单".encode() in rv.data

    # 选择性回写：b1 节点时间 + 甲 b1 实测位置 -> 新副本，不改原舞台
    rv = client.post(f"/api/rehearsals/{rid}/promote", json={
        "name": "修订副本",
        "times": [["b1", None, 1.5]],
        "positions": [["b1", "a1", 2.0, 4.0]],
    })
    assert rv.status_code == 201
    new_doc = rv.get_json()
    assert new_doc["stage"]["id"] != sid
    assert new_doc["stage"]["name"] == "修订副本"
    new_b1 = next(b for b in new_doc["beats"] if b["name"] == "节点1")
    assert new_b1["time"] == 1.5
    new_a1 = next(a for a in new_doc["actors"] if a["name"] == "甲")
    new_pl = next(p for p in new_doc["placements"]
                  if p["beat_id"] == new_b1["id"] and p["actor_id"] == new_a1["id"])
    assert (new_pl["x"], new_pl["y"]) == (2.0, 4.0)
    # 原方案时间未被改动
    orig = client.get(f"/api/stages/{sid}").get_json()
    assert next(b for b in orig["beats"] if b["id"] == "b1")["time"] == 0.0

    assert client.delete(f"/api/rehearsals/{rid}").status_code == 200
    assert client.get(f"/api/rehearsals/{rid}/review").status_code == 404


def test_rehearsal_compare(client):
    sid = client.post("/api/stages", json={"name": "比较台"}).get_json()["stage"]["id"]
    doc = _rehearsal_doc(sid)
    client.put(f"/api/stages/{sid}", json=doc)

    def make_run(name, t1, t2, x1):
        rid = client.post(f"/api/stages/{sid}/rehearsals",
                          json={"scene_id": "sc1", "name": name}).get_json()["id"]
        marks = []
        marks.append({"id": f"{rid}-bm1", "beat_id": "b1", "actual_time": t1, "note": ""})
        marks.append({"id": f"{rid}-bm2", "beat_id": "b2", "actual_time": t2, "note": ""})
        am = []
        for aid, t, x in (("a1", t1, x1), ("a2", t1, None)):
            am.append({"id": f"{rid}-{aid}1", "beat_id": "b1", "actor_id": aid,
                       "actual_time": t, "x": x, "y": 4.0 if x is not None else None,
                       "absent": 0, "note": ""})
        client.put(f"/api/rehearsals/{rid}", json={
            "name": name, "notes": "", "status": "finished",
            "clock_elapsed": 5, "clock_running": False, "clock_at": None,
            "beat_marks": marks, "actor_marks": am})
        return rid

    r1 = make_run("第一次", 1.5, 2.0, 2.0)   # 甲连续迟到、走位偏移 1m
    r2 = make_run("第二次", 1.8, 2.2, 2.1)
    cmp_ = client.get(f"/api/stages/{sid}/rehearsals/compare?a={r1}&b={r2}").get_json()
    assert any(x["name"] == "节点1" for x in cmp_["recurring_time"])
    assert any(x["actor_name"] == "甲" and x["beat_name"] == "节点1"
               for x in cmp_["recurring_pos"])
    # 比较复盘单也可打印
    assert client.get(f"/print/rehearsals/{r1}/review?compare={r2}").status_code == 200


def test_rehearsal_snapshot_independent(client):
    """排练创建后修改原方案不影响快照。"""
    sid = client.post("/api/stages", json={"name": "快照台"}).get_json()["stage"]["id"]
    doc = _rehearsal_doc(sid)
    client.put(f"/api/stages/{sid}", json=doc)
    rid = client.post(f"/api/stages/{sid}/rehearsals",
                      json={"scene_id": "sc1"}).get_json()["id"]
    # 原方案改名、改节点时间（保留完整子表避免外键约束）
    doc["stage"]["name"] = "改名后的舞台"
    next(b for b in doc["beats"] if b["id"] == "b1")["time"] = 42.0
    client.put(f"/api/stages/{sid}", json=doc)
    rec = client.get(f"/api/rehearsals/{rid}").get_json()
    assert rec["snapshot"]["stage"]["name"] == "测试舞台"
    assert next(b for b in rec["snapshot"]["beats"] if b["id"] == "b1")["time"] == 0.0


# ---------------------------------------------------------------- 换景调度
def _changeover_doc(sid="s1"):
    return {
        "stage": {"id": sid, "name": "换景台", "width": 12.0, "height": 8.0},
        "regions": [], "actors": [],
        "scenes": [{"id": "sc1", "stage_id": sid, "name": "一幕", "position": 0},
                   {"id": "sc2", "stage_id": sid, "name": "二幕", "position": 1}],
        "beats": [], "placements": [], "paths": [],
        "crews": [{"id": "c1", "stage_id": sid, "name": "搬运组", "members": 3,
                   "win_start": 0, "win_end": 600, "color": "#3f8fdd", "position": 0}],
        "gates": [{"id": "g1", "stage_id": sid, "name": "左台口", "x": 0.0, "y": 4.0, "position": 0}],
        "props": [
            {"id": "p1", "stage_id": sid, "name": "重台", "w": 2.0, "h": 1.0, "weight": 120,
             "min_crew": 3, "speed": 1.0, "storage": "SL", "gates": ["g1"],
             "color": "#c98a3a", "position": 0},
            {"id": "p2", "stage_id": sid, "name": "小凳", "w": 0.6, "h": 0.6, "weight": 5,
             "min_crew": 1, "speed": 1.0, "storage": "SL", "gates": ["g1"],
             "color": "#9b6dd3", "position": 1},
        ],
        "set_positions": [
            {"id": "q1", "stage_id": sid, "prop_id": "p1", "scene_id": "sc1", "kind": "close", "x": 4.0, "y": 4.0},
            {"id": "q2", "stage_id": sid, "prop_id": "p1", "scene_id": "sc2", "kind": "open", "x": None, "y": None},
            {"id": "q3", "stage_id": sid, "prop_id": "p2", "scene_id": "sc1", "kind": "close", "x": 8.0, "y": 2.0},
            {"id": "q4", "stage_id": sid, "prop_id": "p2", "scene_id": "sc2", "kind": "open", "x": None, "y": None},
        ],
        "shifts": [{"id": "sh1", "stage_id": sid, "from_scene_id": "sc1", "to_scene_id": "sc2",
                    "name": "一二幕之间", "deadline": 120, "position": 0}],
        "shift_ops": [
            {"id": "o1", "stage_id": sid, "shift_id": "sh1", "prop_id": "p1", "kind": "strike",
             "crew_id": "c1", "handover_crew": None, "demands": None, "locked_start": None,
             "order_hint": 0, "route": [], "position": 0},
            {"id": "o2", "stage_id": sid, "shift_id": "sh1", "prop_id": "p2", "kind": "strike",
             "crew_id": "c1", "handover_crew": None, "demands": None, "locked_start": None,
             "order_hint": 1, "route": [], "position": 1},
        ],
        "shift_deps": [],
    }


def _op(sh, prop_name):
    return next(o for o in sh["ops"] if o["prop_name"] == prop_name)


def _save_co_doc(client, doc):
    # POST 生成舞台（随机 id），随后把文档中的固定 id 替换为新建 id
    sid = client.post("/api/stages", json={"name": doc["stage"]["name"],
                                           "width": doc["stage"]["width"],
                                           "height": doc["stage"]["height"]}).get_json()["stage"]["id"]
    old = doc["stage"]["id"]
    if old != sid:
        for row in doc.get("scenes", []):
            row["stage_id"] = sid
        for row in doc.get("crews", []):
            row["stage_id"] = sid
        for row in doc.get("gates", []):
            row["stage_id"] = sid
        for row in doc.get("props", []):
            row["stage_id"] = sid
        for row in doc.get("set_positions", []):
            row["stage_id"] = sid
        for row in doc.get("shifts", []):
            row["stage_id"] = sid
        for row in doc.get("shift_ops", []):
            row["stage_id"] = sid
        for row in doc.get("shift_deps", []):
            row["stage_id"] = sid
    doc["stage"]["id"] = sid
    rv = client.put(f"/api/stages/{sid}", json=doc)
    assert rv.status_code == 200, rv.data
    return client.get(f"/api/stages/{sid}/changeover").get_json()


def test_changeover_crew_demand_accumulates(client):
    """重台(3人)与小凳(1人)同组时不得重叠 0–10s，时间线须可串行执行。"""
    from stageplanner.changeover import analyze_changeover
    doc = _changeover_doc()
    sh = analyze_changeover(doc)["shifts"][0]
    table, stool = _op(sh, "重台"), _op(sh, "小凳")
    assert table["demand"] == 3 and stool["demand"] == 1
    assert table["start"] == 0.0
    assert stool["start"] >= table["finish"] - 0.02, (table["finish"], stool["start"])
    assert stool["finish"] > table["finish"]
    assert not [p for p in sh["problems"] if p["type"] in ("overlap", "manpower")]

    # 2+1=3 不超过容量时允许并行
    doc["props"][0]["min_crew"] = 2
    sh2 = analyze_changeover(doc)["shifts"][0]
    assert _op(sh2, "小凳")["start"] == 0.0
    assert not [p for p in sh2["problems"] if p["type"] == "overlap"]


def test_changeover_win_start_and_future_locked(client):
    """排程须遵守 win_start 下限并避让未来的锁定区间。"""
    from stageplanner.changeover import analyze_changeover
    doc = _changeover_doc()
    doc["crews"][0]["win_start"] = 10
    doc["shift_ops"][0]["locked_start"] = 20     # 重台锁定 20–25.5
    sh = analyze_changeover(doc)["shifts"][0]
    table, stool = _op(sh, "重台"), _op(sh, "小凳")
    assert table["start"] == 20.0 and table["locked"]
    assert stool["start"] >= 10.0 - 1e-9
    assert stool["finish"] <= 20.0 + 0.02, (stool["start"], stool["finish"])
    assert not [p for p in sh["problems"] if p["type"] in ("overlap", "window")]


def test_changeover_persistence_and_print(client):
    """换景数据整文档往返保存；打印路由 200 且含物件/换景名。"""
    doc = _changeover_doc()
    got = _save_co_doc(client, doc)
    sid = doc["stage"]["id"]
    sh = got["shifts"][0]
    assert _op(sh, "小凳")["start"] >= _op(sh, "重台")["finish"] - 0.02
    stored = client.get(f"/api/stages/{sid}").get_json()
    assert stored["props"][0]["gates"] == ["g1"]
    assert stored["shift_ops"][0]["route"] == []
    page = client.get(f"/print/stages/{sid}/changeover")
    assert page.status_code == 200
    assert "重台".encode() in page.data and "一二幕之间".encode() in page.data


@pytest.mark.skipif(shutil.which("node") is None, reason="环境中没有 Node")
@pytest.mark.parametrize("script", sorted(glob.glob(
    os.path.join(os.path.dirname(__file__), "js", "*.js"))))
def test_rehearsal_js_regression(script):
    """tests/js 下的无界面回归：排练异步保存、复盘时间范围、换景占用与出入口等。"""
    rv = subprocess.run(["node", script], capture_output=True, text=True)
    assert rv.returncode == 0, rv.stdout + rv.stderr
