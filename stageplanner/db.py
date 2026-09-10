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
-- 排练实录：一次排练对应一份不可变编排快照（snapshot 为开排时整文档 JSON）
CREATE TABLE IF NOT EXISTS rehearsals (
    id             TEXT PRIMARY KEY,
    stage_id       TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
    scene_id       TEXT,                          -- 快照场景 id（场景删除后保留冗余名称）
    scene_name     TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL,
    snapshot       TEXT NOT NULL,                 -- JSON 编排快照（不回写原方案）
    notes          TEXT NOT NULL DEFAULT '',      -- 排练总备注
    status         TEXT NOT NULL DEFAULT 'running', -- running | finished
    origin         REAL NOT NULL DEFAULT 0,       -- 场景时钟原点（首节点计划时间）
    clock_elapsed  REAL NOT NULL DEFAULT 0,       -- 排练时钟已走秒数
    clock_running  INTEGER NOT NULL DEFAULT 0,
    clock_at       TEXT,                          -- 时钟基准（客户端 ISO 时间，刷新后续跑）
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rehearsal_beat_marks (
    id            TEXT PRIMARY KEY,
    rehearsal_id  TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
    beat_id       TEXT NOT NULL,
    actual_time   REAL,                           -- 实测节点时刻（排练时钟秒），NULL=漏记
    note          TEXT NOT NULL DEFAULT '',
    UNIQUE(rehearsal_id, beat_id)
);
CREATE TABLE IF NOT EXISTS rehearsal_actor_marks (
    id            TEXT PRIMARY KEY,
    rehearsal_id  TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
    beat_id       TEXT NOT NULL,
    actor_id      TEXT NOT NULL,
    actual_time   REAL,                           -- 演员到位打点时刻，NULL=未打点
    x             REAL,                           -- 实测位置（拖动修正）
    y             REAL,
    absent        INTEGER NOT NULL DEFAULT 0,     -- 缺席标记
    note          TEXT NOT NULL DEFAULT '',       -- 逐条处理备注
    UNIQUE(rehearsal_id, beat_id, actor_id)
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


# ---------------------------------------------------------------- 排练实录
def list_rehearsals(stage_id):
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT id, stage_id, scene_id, scene_name, name, notes, status,
                      origin, clock_elapsed, clock_running, clock_at,
                      created_at, updated_at
               FROM rehearsals WHERE stage_id=? ORDER BY created_at DESC, rowid DESC""",
            (stage_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_rehearsal(rehearsal_id):
    conn = get_conn()
    try:
        r = conn.execute("SELECT * FROM rehearsals WHERE id=?", (rehearsal_id,)).fetchone()
        if not r:
            return None
        rec = dict(r)
        rec["beat_marks"] = [dict(x) for x in conn.execute(
            "SELECT * FROM rehearsal_beat_marks WHERE rehearsal_id=? ORDER BY rowid",
            (rehearsal_id,))]
        rec["actor_marks"] = [dict(x) for x in conn.execute(
            "SELECT * FROM rehearsal_actor_marks WHERE rehearsal_id=? ORDER BY rowid",
            (rehearsal_id,))]
        return rec
    finally:
        conn.close()


def insert_rehearsal(rec):
    import json
    conn = get_conn()
    try:
        with transaction(conn):
            conn.execute(
                """INSERT INTO rehearsals(id, stage_id, scene_id, scene_name, name,
                       snapshot, notes, status, origin, clock_elapsed, clock_running,
                       clock_at, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                (rec["id"], rec["stage_id"], rec.get("scene_id"), rec.get("scene_name", ""),
                 rec["name"], json.dumps(rec["snapshot"], ensure_ascii=False),
                 rec.get("notes", ""), rec.get("status", "running"),
                 float(rec.get("origin", 0)), float(rec.get("clock_elapsed", 0)),
                 1 if rec.get("clock_running") else 0, rec.get("clock_at")),
            )
        return get_rehearsal(rec["id"])
    finally:
        conn.close()


def save_rehearsal(rec):
    """整份排练 upsert：排练元数据 + 全量打点（以客户端为准）。"""
    import json
    conn = get_conn()
    try:
        with transaction(conn):
            conn.execute(
                """UPDATE rehearsals SET scene_id=?, scene_name=?, name=?, notes=?,
                       status=?, origin=?, clock_elapsed=?, clock_running=?, clock_at=?,
                       updated_at=datetime('now') WHERE id=?""",
                (rec.get("scene_id"), rec.get("scene_name", ""), rec["name"],
                 rec.get("notes", ""), rec.get("status", "running"),
                 float(rec.get("origin", 0)), float(rec.get("clock_elapsed", 0)),
                 1 if rec.get("clock_running") else 0, rec.get("clock_at"), rec["id"]),
            )
            conn.execute("DELETE FROM rehearsal_beat_marks WHERE rehearsal_id=?", (rec["id"],))
            conn.execute("DELETE FROM rehearsal_actor_marks WHERE rehearsal_id=?", (rec["id"],))
            conn.executemany(
                """INSERT INTO rehearsal_beat_marks(id, rehearsal_id, beat_id, actual_time, note)
                   VALUES(?,?,?,?,?)""",
                [(m["id"], rec["id"], m["beat_id"],
                  None if m.get("actual_time") is None else float(m["actual_time"]),
                  m.get("note", ""))
                 for m in rec.get("beat_marks", [])],
            )
            conn.executemany(
                """INSERT INTO rehearsal_actor_marks(id, rehearsal_id, beat_id, actor_id,
                       actual_time, x, y, absent, note)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                [(m["id"], rec["id"], m["beat_id"], m["actor_id"],
                  None if m.get("actual_time") is None else float(m["actual_time"]),
                  None if m.get("x") is None else float(m["x"]),
                  None if m.get("y") is None else float(m["y"]),
                  1 if m.get("absent") else 0, m.get("note", ""))
                 for m in rec.get("actor_marks", [])],
            )
        return get_rehearsal(rec["id"])
    finally:
        conn.close()


def delete_rehearsal(rehearsal_id):
    conn = get_conn()
    try:
        with transaction(conn):
            cur = conn.execute("DELETE FROM rehearsals WHERE id=?", (rehearsal_id,))
        return cur.rowcount > 0
    finally:
        conn.close()
