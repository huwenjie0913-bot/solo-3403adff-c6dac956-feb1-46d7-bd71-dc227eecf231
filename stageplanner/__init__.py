"""舞台走位编排（Stage Planner）。

用法：
    python -m stageplanner              # 本机启动 http://127.0.0.1:5000
    flask --app stageplanner run
"""
from .app import create_app

__all__ = ["create_app"]
