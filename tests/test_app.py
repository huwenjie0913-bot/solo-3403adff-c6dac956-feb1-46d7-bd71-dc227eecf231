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
