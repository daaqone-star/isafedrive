"""
iSafedrive — start the app.

    python run.py

Then open http://127.0.0.1:5000 in your browser. On hosting (Render) the
PORT env var and 0.0.0.0 binding are used automatically.
"""
import os
import sys

from server import db
from server.app import app


def main():
    try:
        reset = "--reset" in sys.argv
        db.init_db(reset=reset)
        port = int(os.environ.get("PORT", "5000"))
        print("=" * 56)
        print(f"  iSafedrive running -> http://127.0.0.1:{port}")
        print("  Admin bootstrap: 07000000000 / admin123")
        print("  Passengers & drivers: register in-app (no demo data)")
        print("=" * 56)
        app.run(host="0.0.0.0", port=port, use_reloader=False)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
