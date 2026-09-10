"""端到端冒烟测试：应用工厂、首页、文档保存、问题分析、打印路由。"""
import json
import os
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
