"""Quick smoke test of the iSafedrive API using Flask's test client."""
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, ".")
from server import db
from server.app import app

# IMPORTANT: tests use an isolated temp DB so they never wipe the live app's data.
db.DB_PATH = Path(tempfile.gettempdir()) / "isafedrive_test_api.db"
db.init_db(reset=True)
client = app.test_client()

def req(method, path, **kw):
    r = getattr(client, method)(path, **kw)
    try:
        body = r.get_json()
    except Exception:
        body = r.data.decode()
    print(f"{method.upper():5} {path} -> {r.status_code}")
    return r, body

# Register a fresh passenger (no demo data shipped)
r, body = req("post", "/api/auth/register", json={"name": "Test User", "phone": "08129999999", "password": "pw", "role": "passenger"})
assert r.status_code == 201, body
H_PASS = {"X-User-Id": str(body["user"]["id"])}

# Login as admin (bootstrap account)
r, body = req("post", "/api/auth/login", json={"phone": "07000000000", "password": "admin123"})
assert r.status_code == 200, body
H_ADMIN = {"X-User-Id": str(body["token"])}

# Register a fresh driver
r, body = req("post", "/api/auth/register", json={"name": "Test Driver", "phone": "08129999998", "password": "pw", "role": "driver", "vehicle_type": "Sedan", "vehicle_reg": "TES 123 LAG"})
assert r.status_code == 201, body
H_DRV = {"X-User-Id": str(body["user"]["id"])}
driver = body.get("driver", {})

# Admin accounts cannot self-register
r, body = req("post", "/api/auth/register", json={"name": "Fake Admin", "phone": "08120000000", "password": "pw", "role": "admin"})
assert r.status_code == 403, body
print("   -> admin self-registration blocked")

# Nearby drivers
r, body = req("get", "/api/drivers/nearby?lat=6.5244&lng=3.3792&radius=10")
assert r.status_code == 200 and isinstance(body, list), body
print(f"   -> {len(body)} nearby drivers")

# Create a ride
r, body = req("post", "/api/rides", headers=H_PASS, json={
    "pickup": {"lat": 6.5244, "lng": 3.3792, "address": "Lekki Phase 1"},
    "dropoff": {"lat": 6.4551, "lng": 3.3925, "address": "Ikoyi"},
    "vehicle_type": "Sedan",
    "payment_method": "card",
})
assert r.status_code == 201, body
ride_id = body["id"]
print(f"   -> ride #{ride_id} created, fare = NGN {body['fare']}, dist = {round(body['distance_km'],2)} km")

# Driver demo polls pending requests and accepts (tests the real two-app flow)
r, body = req("get", "/api/rides/pending?lat=6.5244&lng=3.3792", headers=H_DRV)
assert r.status_code == 200 and isinstance(body, list), body
print(f"   -> {len(body)} pending request(s) for driver")
pending = [p for p in body if p["id"] == ride_id]
assert pending, body
driver_id = pending[0].get("driver", {}).get("id")
r, body = req("post", f"/api/rides/{ride_id}/accept", headers=H_DRV)
assert r.status_code == 200 and body["status"] == "assigned", body
driver_id = body["driver_id"]
print(f"   -> driver #{driver_id} accepted the ride")

# Driver advances the ride
req("post", f"/api/rides/{ride_id}/status", headers=H_DRV, json={"status": "driver_arriving"})
req("post", f"/api/rides/{ride_id}/status", headers=H_DRV, json={"status": "arrived"})
r, body = req("post", f"/api/rides/{ride_id}/status", headers=H_DRV, json={"status": "in_transit"})
assert body["status"] == "in_transit", body

# Complete
r, body = req("post", f"/api/rides/{ride_id}/complete", headers=H_DRV)
assert body["status"] == "completed", body

# Rate
r, body = req("post", f"/api/rides/{ride_id}/rate", headers=H_PASS, json={"rating": 5, "comment": "Excellent"})
assert r.status_code == 200, body

# Driver earnings
r, body = req("get", "/api/driver/earnings", headers=H_DRV)
assert r.status_code == 200, body
print(f"   -> driver earnings: total={body['total_earned']} trips={body['trips']}")

# Admin stats
r, body = req("get", "/api/admin/stats", headers=H_ADMIN)
assert r.status_code == 200, body
print(f"   -> admin stats: completed={body['completed_rides']} revenue={body['revenue']}")

# Admin analytics
r, body = req("get", "/api/admin/analytics", headers=H_ADMIN)
assert r.status_code == 200, body
print(f"   -> analytics: by_day={len(body['by_day'])} by_vehicle={body['by_vehicle']}")

# Ride list for passenger
r, body = req("get", "/api/rides", headers=H_PASS)
assert r.status_code == 200, body
print(f"   -> passenger ride history: {len(body)} rides")

# Driver toggle
r, body = req("post", "/api/driver/toggle", headers=H_DRV, json={"online": False})
assert r.status_code == 200, body

print("\nALL BACKEND TESTS PASSED")
