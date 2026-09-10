import argparse

from .app import create_app

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="舞台走位编排 Web 应用")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--db", default=None, help="SQLite 文件路径")
    args = parser.parse_args()
    app = create_app(db_path=args.db)
    app.run(host=args.host, port=args.port, debug=False)
