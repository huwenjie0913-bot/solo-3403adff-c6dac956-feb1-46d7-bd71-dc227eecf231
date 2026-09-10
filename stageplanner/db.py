"""SQLite 持久化层。整份排练文档按舞台整文档读写：
保存时在单个事务内 upsert 舞台/区域/演员/场景/节点/走位，
删除服务端多出的记录，保证客户端即真相来源。"""
import sqlite3
from contextlib import contextmanager

DB_PATH = "stageplanner.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS stages (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    width       REAL NOT NULL,
    height      REAL NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS regions (
    id        TEXT PRIMARY KEY,
    stage_id  TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'area',     -- area | obstacle
    points    TEXT NOT NULL,                    -- JSON [[x,y],...]
    color     TEXT NOT NULL DEFAULT '#8ab4f8'
);
CREATE TABLE IF NOT EXISTS actors (
    id        TEXT PRIMARY KEY,
    stage_id  TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    speed     REAL NOT NULL DEFAULT 1.2,        -- 常用步速 m/s
    color     TEXT NOT NULL DEFAULT '#e8734a'
);
CREATE TABLE IF NOT EXISTS scenes (
    id        TEXT PRIMARY KEY,
    stage_id  TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS beats (
    id        TEXT PRIMARY KEY,
    stage_id  TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    scene_id  TEXT REFERENCES scenes(id) ON DELETE SET NULL,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0,
    time      REAL NOT NULL DEFAULT 0           -- 到位时间（秒）
);
CREATE TABLE IF NOT EXISTS placements (
    id          TEXT PRIMARY KEY,
    stage_id    TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    beat_id     TEXT NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
    actor_id    TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    facing      REAL NOT NULL DEFAULT 0,        -- 朝向（度，0=朝观众）
    UNIQUE(beat_id, actor_id)
);
CREATE TABLE IF NOT EXISTS paths (
    id                    TEXT PRIMARY KEY,
    stage_id              TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    from_beat_id          TEXT NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
    to_beat_id            TEXT NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
    actor_id              TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    points                TEXT NOT NULL         -- JSON [[x,y],...] 折线锚点
);
"""

TABLES = ["paths", "placements", "beats", "scenes", "actors", "regions", "stages"]


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def transaction(conn):
    try:
        yield
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db(path=None):
    global DB_PATH
    if path:
        DB_PATH = path
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def list_stages():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, width, height, updated_at FROM stages ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_stage(stage_id):
    conn = get_conn()
    try:
        st = conn.execute("SELECT * FROM stages WHERE id = ?", (stage_id,)).fetchone()
        if not st:
            return None
        doc = {
            "stage": dict(st),
            "regions": [dict(r) for r in conn.execute(
                "SELECT * FROM regions WHERE stage_id=? ORDER BY rowid", (stage_id,))],
            "actors": [dict(r) for r in conn.execute(
                "SELECT * FROM actors WHERE stage_id=? ORDER BY rowid", (stage_id,))],
            "scenes": [dict(r) for r in conn.execute(
                "SELECT * FROM scenes WHERE stage_id=? ORDER BY position, rowid", (stage_id,))],
            "beats": [dict(r) for r in conn.execute(
                "SELECT * FROM beats WHERE stage_id=? ORDER BY position, rowid", (stage_id,))],
            "placements": [dict(r) for r in conn.execute(
                "SELECT * FROM placements WHERE stage_id=? ORDER BY rowid", (stage_id,))],
            "paths": [dict(r) for r in conn.execute(
                "SELECT * FROM paths WHERE stage_id=? ORDER BY rowid", (stage_id,))],
        }
        return doc
    finally:
        conn.close()


def save_document(doc):
    """整文档 upsert。doc 结构与 get_stage 输出一致（stage 含 id/name/width/height）。"""
    import json
    st = doc["stage"]
    sid = st["id"]
    conn = get_conn()
    try:
        with transaction(conn):
            conn.execute(
                """INSERT INTO stages(id, name, width, height)
                   VALUES(?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, width=excluded.width,
                     height=excluded.height, updated_at=datetime('now')""",
                (sid, st["name"], float(st["width"]), float(st["height"])),
            )
            # 子表：以客户端 id 集合为准，先删后插（同一事务内）
            child_specs = [
                ("regions", doc.get("regions", []),
                 """INSERT INTO regions(id, stage_id, name, kind, points, color)
                    VALUES(?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      name=excluded.name, kind=excluded.kind,
                      points=excluded.points, color=excluded.color,
                      stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r["name"], r.get("kind", "area"),
                            json.dumps(r["points"]), r.get("color", "#8ab4f8"))),
                ("actors", doc.get("actors", []),
                 """INSERT INTO actors(id, stage_id, name, speed, color)
                    VALUES(?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      name=excluded.name, speed=excluded.speed,
                      color=excluded.color, stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r["name"], float(r["speed"]),
                            r.get("color", "#e8734a"))),
                ("scenes", doc.get("scenes", []),
                 """INSERT INTO scenes(id, stage_id, name, position)
                    VALUES(?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      name=excluded.name, position=excluded.position,
                      stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r["name"], int(r["position"]))),
                ("beats", doc.get("beats", []),
                 """INSERT INTO beats(id, stage_id, scene_id, name, position, time)
                    VALUES(?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      scene_id=excluded.scene_id, name=excluded.name,
                      position=excluded.position, time=excluded.time,
                      stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r.get("scene_id"), r["name"],
                            int(r["position"]), float(r["time"]))),
                ("placements", doc.get("placements", []),
                 """INSERT INTO placements(id, stage_id, beat_id, actor_id, x, y, facing)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      beat_id=excluded.beat_id, actor_id=excluded.actor_id,
                      x=excluded.x, y=excluded.y, facing=excluded.facing,
                      stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r["beat_id"], r["actor_id"],
                            float(r["x"]), float(r["y"]), float(r.get("facing", 0)))),
                ("paths", doc.get("paths", []),
                 """INSERT INTO paths(id, stage_id, from_beat_id, to_beat_id, actor_id, points)
                    VALUES(?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                      from_beat_id=excluded.from_beat_id,
                      to_beat_id=excluded.to_beat_id, actor_id=excluded.actor_id,
                      points=excluded.points, stage_id=excluded.stage_id""",
                 lambda r: (r["id"], sid, r["from_beat_id"], r["to_beat_id"],
                            r["actor_id"], json.dumps(r["points"]))),
            ]
            keep_ids = {sid}
            for table, rows, sql, make in child_specs:
                ids = {r["id"] for r in rows}
                placeholders = ",".join("?" * len(ids)) if ids else ""
                if ids:
                    conn.execute(
                        f"DELETE FROM {table} WHERE stage_id=? AND id NOT IN ({placeholders})",
                        [sid, *ids],
                    )
                else:
                    conn.execute(f"DELETE FROM {table} WHERE stage_id=?", (sid,))
                conn.executemany(sql, [make(r) for r in rows])
                keep_ids |= ids
        return get_stage(sid)
    finally:
        conn.close()
