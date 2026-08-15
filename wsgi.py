"""Production (gunicorn) entry point used by Render.

    gunicorn wsgi:app
"""
import os

from server import db
from server.app import app

db.init_db(reset=False)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
