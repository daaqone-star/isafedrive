"""Live HTTP smoke test: boots the real server and exercises the browser-facing surface."""
import json
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, ".")
from server import db
from server.app import app
from werkzeug.serving import make_server

# IMPORTANT: tests use an isolated temp DB so they never wipe the live app's data.
db.DB_PATH = Path(tempfile.gettempdir()) / "isafedrive_test_http.db"
db.init_db(reset=True)

server = make_server("127.0.0.1", 5099, app, threaded=True)
t = threading.Thread(target=server.serve_forever, daemon=True)
t.start()
BASE = "http://127.0.0.1:5099"

def req(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

ok = True

# 1. index.html serves
st, html = req("GET", "/")
assert st == 200 and "iSafedrive" in html, (st, html[:200])
print("GET / -> 200, index.html OK")

# 2. static assets serve
for asset in ["/css/styles.css", "/js/app.js", "/js/passenger.js", "/js/driver.js", "/js/admin.js", "/js/sim.js", "/js/api.js", "/js/map.js", "/js/util.js"]:
    st, body = req("GET", asset)
    assert st == 200 and len(body) > 200, (asset, st)
print("static assets all serve OK")

# 3. full ride flow over HTTP (fresh registration — no demo data)
st, body = req("POST", "/api/auth/register", {"name": "HTTP User", "phone": "08139999999", "password": "pw", "role": "passenger"})
pass_user = json.loads(body)
h_pass = {"X-User-Id": str(pass_user["user"]["id"])}

st, body = req("POST", "/api/auth/register", {"name": "HTTP Driver", "phone": "08139999998", "password": "pw", "role": "driver", "vehicle_type": "Sedan", "vehicle_reg": "HTTP 123 LAG"})
drv_user = json.loads(body)
h_drv = {"X-User-Id": str(drv_user["user"]["id"])}
print("driver registered OK, driver record:", bool(drv_user.get("driver")))

st, body = req("POST", "/api/rides", {
    "pickup": {"lat": 6.5244, "lng": 3.3792, "address": "Lekki Phase 1"},
    "dropoff": {"lat": 6.4551, "lng": 3.3925, "address": "Ikoyi"},
    "vehicle_type": "Sedan", "payment_method": "card",
}, h_pass)
ride = json.loads(body)
assert st == 201, (st, body)
print(f"ride #{ride['id']} created: {ride['status']}, fare={ride['fare']}")

st, body = req("GET", "/api/rides/pending?lat=6.5244&lng=3.3792&radius=8", headers=h_drv)
pending = json.loads(body)
assert any(p["id"] == ride["id"] for p in pending), body
print(f"driver sees {len(pending)} pending request(s)")

st, body = req("POST", f"/api/rides/{ride['id']}/accept", headers=h_drv)
assert json.loads(body)["status"] == "assigned", body
print("driver accepted ride")

st, body = req("POST", f"/api/rides/{ride['id']}/status", {"status": "in_transit"}, h_drv)
assert json.loads(body)["status"] == "in_transit", body
st, body = req("POST", f"/api/rides/{ride['id']}/complete", headers=h_drv)
assert json.loads(body)["status"] == "completed", body
print("ride completed")

st, body = req("POST", f"/api/rides/{ride['id']}/rate", {"rating": 5, "comment": "Great ride!"}, h_pass)
assert st == 200, body
print("ride rated")

st, body = req("POST", "/api/auth/login", {"phone": "07000000000", "password": "admin123"})
admin_user = json.loads(body)
assert st == 200, body
st, body = req("GET", "/api/admin/stats", headers={"X-User-Id": str(admin_user["token"])})
stats = json.loads(body)
assert st == 200, body
print("admin stats:", stats["completed_rides"], "completed,", stats["revenue"], "revenue")

st, body = req("GET", "/api/rides", headers=h_pass)
assert st == 200, body
print("passenger history:", len(json.loads(body)), "rides")

server.shutdown()
print("\nALL HTTP SMOKE TESTS PASSED")
