"""
iSafedrive Flask API.

Serves the REST endpoints for the Passenger app, Driver app and Admin
dashboard. Stateless (demo auth = user id header) with a SQLite store.
"""
import json
import math
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory

from server import db

app = Flask(__name__, static_folder="../static", static_url_path="")


def _to_dict(row):
    return dict(row) if row is not None else None


def _user_dict(row):
    d = _to_dict(row)
    if d:
        d.pop("password", None)
    return d


def _auth_user():
    uid = request.headers.get("X-User-Id")
    if not uid:
        return None
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (int(uid),)).fetchone()
    conn.close()
    return row


def _json_body():
    return request.get_json(silent=True) or {}


import re
def _norm_phone(p):
    return re.sub(r'[\s\-()]', '', (p or "")).strip()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@app.post("/api/auth/register")
def api_register():
    body = _json_body()
    name = (body.get("name") or "").strip()
    phone = _norm_phone(body.get("phone"))
    password = body.get("password") or ""
    role = body.get("role") or "passenger"
    if not name or not phone or not password:
        return jsonify({"error": "Name, phone and password are required"}), 400
    if role == "admin":
        return jsonify({"error": "Admin accounts are provisioned by the platform"}), 403
    conn = db.get_conn()
    if conn.execute("SELECT id FROM users WHERE phone=?", (phone,)).fetchone():
        conn.close()
        return jsonify({"error": "Phone number already registered"}), 409
    cur = conn.execute(
        "INSERT INTO users(name, phone, password, role) VALUES(?,?,?,?)",
        (name, phone, password, role),
    )
    user_id = cur.lastrowid
    if role == "driver":
        conn.execute(
            """INSERT INTO drivers(user_id, name, phone, vehicle_type, vehicle_reg,
               lat, lng, approved, online, status)
               VALUES(?,?,?,?,?,?,?,0,0,'offline')""",
            (user_id, name, phone,
             body.get("vehicle_type", "Mini"), body.get("vehicle_reg", "---"),
             body.get("lat", db.LAGOS_CENTER[0]), body.get("lng", db.LAGOS_CENTER[1])),
        )
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    return jsonify({"token": user_id, "user": _user_dict(user)}), 201


@app.post("/api/auth/login")
def api_login():
    body = _json_body()
    phone = _norm_phone(body.get("phone"))
    password = body.get("password") or ""
    conn = db.get_conn()
    user = conn.execute(
        "SELECT * FROM users WHERE phone=? AND password=?",
        (phone, password),
    ).fetchone()
    conn.close()
    if not user:
        return jsonify({"error": "Invalid phone or password"}), 401
    return jsonify({"token": user["id"], "user": _user_dict(user)})


@app.get("/api/me")
def api_me():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    payload = _user_dict(user)
    if user["role"] == "driver":
        conn = db.get_conn()
        payload["driver"] = _to_dict(
            conn.execute("SELECT * FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
        )
        conn.close()
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

@app.get("/api/drivers")
def api_drivers():
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT * FROM drivers WHERE approved = 1 AND online = 1"
    ).fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.get("/api/drivers/nearby")
def api_drivers_nearby():
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat/lng required"}), 400
    vtype = request.args.get("vehicle_type") or "any"
    radius = float(request.args.get("radius", 5))
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT * FROM drivers WHERE approved = 1 AND online = 1 AND status = 'available'"
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = db.haversine(lat, lng, r["lat"], r["lng"])
        if d <= radius and (vtype == "any" or r["vehicle_type"] == vtype):
            r = _to_dict(r)
            r["distance_km"] = round(d, 2)
            out.append(r)
    out.sort(key=lambda x: x["distance_km"])
    return jsonify(out)


@app.put("/api/driver/location")
def api_driver_location():
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    conn = db.get_conn()
    conn.execute(
        "UPDATE drivers SET lat=?, lng=? WHERE user_id=?",
        (float(body.get("lat")), float(body.get("lng")), user["id"]),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/driver/toggle")
def api_driver_toggle():
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    online = 1 if body.get("online") else 0
    conn = db.get_conn()
    conn.execute(
        "UPDATE drivers SET online=?, status=? WHERE user_id=?",
        (online, "available" if online else "offline", user["id"]),
    )
    conn.commit()
    drv = conn.execute("SELECT * FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
    conn.close()
    return jsonify(_to_dict(drv))


# ---------------------------------------------------------------------------
# Rides
# ---------------------------------------------------------------------------

def _ride_with_driver(ride):
    r = _to_dict(ride)
    if r["driver_id"]:
        conn = db.get_conn()
        drv = conn.execute(
            "SELECT * FROM drivers WHERE id=?", (r["driver_id"],)
        ).fetchone()
        conn.close()
        if drv:
            r["driver"] = _to_dict(drv)
    return r


@app.post("/api/rides")
def api_create_ride():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    body = _json_body()
    try:
        pk_lat = float(body["pickup"]["lat"])
        pk_lng = float(body["pickup"]["lng"])
        do_lat = float(body["dropoff"]["lat"])
        do_lng = float(body["dropoff"]["lng"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "pickup and dropoff {lat,lng} required"}), 400

    vtype = body.get("vehicle_type", "Mini")
    pickup_addr = (body.get("pickup") or {}).get("address", "")
    dropoff_addr = (body.get("dropoff") or {}).get("address", "")
    distance_km = db.haversine(pk_lat, pk_lng, do_lat, do_lng)
    duration_min = max(3, int(distance_km * 5))
    fare = db.estimate_fare(vtype, distance_km, duration_min)
    final_fare, discount, promo_code = db.apply_promo(fare, body.get("promo_code"))

    conn = db.get_conn()
    cur = conn.execute(
        """INSERT INTO rides(user_id, pickup_lat, pickup_lng, pickup_address,
           dropoff_lat, dropoff_lng, dropoff_address, vehicle_type,
           distance_km, duration_min, fare, promo_code, discount,
           payment_method, status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'requesting')""",
        (
            user["id"], pk_lat, pk_lng, pickup_addr,
            do_lat, do_lng, dropoff_addr,
            vtype, distance_km, duration_min, final_fare, promo_code, discount,
            body.get("payment_method", "cash"),
        ),
    )
    ride_id = cur.lastrowid
    conn.commit()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    return jsonify(_ride_with_driver(ride)), 201


@app.get("/api/rides/<int:ride_id>")
def api_get_ride(ride_id):
    conn = db.get_conn()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    if not ride:
        return jsonify({"error": "Ride not found"}), 404
    return jsonify(_ride_with_driver(ride))


@app.get("/api/rides")
def api_list_rides():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    conn = db.get_conn()
    role = user["role"]
    if role == "driver":
        drv = conn.execute(
            "SELECT id FROM drivers WHERE user_id=?", (user["id"],)
        ).fetchone()
        if not drv:
            conn.close()
            return jsonify([])
        rows = conn.execute(
            "SELECT * FROM rides WHERE driver_id=? ORDER BY id DESC LIMIT 50",
            (drv["id"],),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM rides WHERE user_id=? ORDER BY id DESC LIMIT 50",
            (user["id"],),
        ).fetchall()
    conn.close()
    return jsonify([_ride_with_driver(r) for r in rows])


@app.get("/api/rides/pending")
def api_pending_rides():
    """Requesting rides near a driver (for the driver app's request inbox)."""
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        lat, lng = db.LAGOS_CENTER
    radius = float(request.args.get("radius", 8))
    conn = db.get_conn()
    drv = conn.execute(
        "SELECT * FROM drivers WHERE user_id=?", (user["id"],)
    ).fetchone()
    if not drv:
        conn.close()
        return jsonify([])
    rows = conn.execute(
        """SELECT r.*, u.name AS passenger_name
           FROM rides r JOIN users u ON u.id=r.user_id
           WHERE r.status='requesting'
             AND NOT EXISTS (SELECT 1 FROM ride_events e
                             WHERE e.ride_id=r.id AND e.action='declined'
                               AND e.driver_id=?)
           ORDER BY r.id DESC LIMIT 10""",
        (drv["id"],),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = db.haversine(lat, lng, r["pickup_lat"], r["pickup_lng"])
        if d <= radius:
            r = _to_dict(r)
            r["distance_to_pickup_km"] = round(d, 2)
            out.append(r)
    return jsonify(out)


@app.post("/api/rides/<int:ride_id>/decline")
def api_decline_ride(ride_id):
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    drv = conn.execute(
        "SELECT * FROM drivers WHERE user_id=?", (user["id"],)
    ).fetchone()
    if not drv:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    conn.execute(
        "INSERT INTO ride_events(ride_id, driver_id, action) VALUES(?,?, 'declined')",
        (ride_id, drv["id"]),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/rides/<int:ride_id>/accept")
def api_accept_ride(ride_id):
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    drv = conn.execute("SELECT * FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not drv or not ride:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    if ride["status"] != "requesting":
        conn.close()
        return jsonify({"error": "Ride no longer available"}), 409
    conn.execute(
        "UPDATE rides SET driver_id=?, status='assigned', accepted_at=datetime('now') WHERE id=?",
        (drv["id"], ride_id),
    )
    conn.execute("UPDATE drivers SET status='busy', trips=trips+1 WHERE id=?", (drv["id"],))
    import random
    trip_code = f"{random.randint(1000, 9999)}"
    conn.execute("UPDATE rides SET trip_code=? WHERE id=?", (trip_code, ride_id))
    conn.execute(
        "INSERT INTO ride_events(ride_id, driver_id, action) VALUES(?,?, 'accepted')",
        (ride_id, drv["id"]),
    )
    conn.commit()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    return jsonify(_ride_with_driver(ride))


@app.post("/api/rides/<int:ride_id>/status")
def api_ride_status(ride_id):
    """Advance a ride through driver_arriving -> arrived -> in_transit."""
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    new_status = body.get("status")
    allowed = {"driver_arriving": "driver_arriving", "arrived": "arrived", "in_transit": "in_transit"}
    if new_status not in allowed:
        return jsonify({"error": "Invalid status"}), 400
    conn = db.get_conn()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not ride:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    if ride["driver_id"] is None:
        conn.close()
        return jsonify({"error": "No driver assigned"}), 400
    if new_status == "in_transit":
        conn.execute("UPDATE rides SET status=?, started_at=datetime('now') WHERE id=?", (new_status, ride_id))
    else:
        conn.execute("UPDATE rides SET status=? WHERE id=?", (new_status, ride_id))
    conn.execute(
        "INSERT INTO ride_events(ride_id, driver_id, action) VALUES(?,?,?)",
        (ride_id, ride["driver_id"], new_status),
    )
    if new_status == "arrived":
        conn.execute("UPDATE rides SET trip_code=trip_code WHERE id=?", (ride_id,))
    conn.commit()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    return jsonify(_ride_with_driver(ride))


@app.post("/api/rides/<int:ride_id>/complete")
def api_complete_ride(ride_id):
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    drv = conn.execute("SELECT * FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not drv or not ride:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    fare = ride["fare"]
    conn.execute(
        "UPDATE rides SET status='completed', completed_at=datetime('now') WHERE id=?",
        (ride_id,),
    )
    conn.execute(
        "UPDATE drivers SET status='available', total_earned=total_earned+? WHERE id=?",
        (fare, drv["id"]),
    )
    conn.execute(
        "INSERT INTO ride_events(ride_id, driver_id, action) VALUES(?,?, 'completed')",
        (ride_id, drv["id"]),
    )
    conn.commit()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    return jsonify(_ride_with_driver(ride))


@app.post("/api/rides/<int:ride_id>/cancel")
def api_cancel_ride(ride_id):
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    body = _json_body()
    conn = db.get_conn()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not ride:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    if ride["status"] in ("completed", "cancelled"):
        conn.close()
        return jsonify({"error": "Ride already finished"}), 409
    conn.execute(
        "UPDATE rides SET status='cancelled', cancelled_at=datetime('now'), cancel_reason=? WHERE id=?",
        (body.get("reason", ""), ride_id),
    )
    if ride["driver_id"]:
        conn.execute(
            "UPDATE drivers SET status='available' WHERE id=?",
            (ride["driver_id"],),
        )
    conn.execute(
        "INSERT INTO ride_events(ride_id, driver_id, action) VALUES(?,?, 'cancelled')",
        (ride_id, ride["driver_id"]),
    )
    conn.commit()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    conn.close()
    return jsonify(_ride_with_driver(ride))


@app.post("/api/rides/<int:ride_id>/rate")
def api_rate_ride(ride_id):
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    body = _json_body()
    rating = int(body.get("rating", 5))
    comment = body.get("comment", "")
    conn = db.get_conn()
    ride = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not ride:
        conn.close()
        return jsonify({"error": "Not found"}), 404
    conn.execute(
        "UPDATE rides SET rating=?, comment=? WHERE id=?", (rating, comment, ride_id)
    )
    if ride["driver_id"]:
        row = conn.execute(
            "SELECT AVG(rating) AS avg_r FROM rides WHERE driver_id=? AND rating IS NOT NULL",
            (ride["driver_id"],),
        ).fetchone()
        new_avg = row["avg_r"] if row["avg_r"] else rating
        conn.execute(
            "UPDATE drivers SET rating=? WHERE id=?", (round(float(new_avg), 2), ride["driver_id"])
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/driver/earnings")
def api_driver_earnings():
    user = _auth_user()
    if not user or user["role"] != "driver":
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    drv = conn.execute("SELECT * FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
    if not drv:
        conn.close()
        return jsonify([])
    today = datetime.now().strftime("%Y-%m-%d")
    stats = conn.execute(
        """SELECT COUNT(*) AS total, COALESCE(SUM(fare),0) AS revenue,
                  COALESCE(SUM(CASE WHEN status='completed' AND date(completed_at)=date('now') THEN 1 ELSE 0 END),0) AS today_rides,
                  COALESCE(SUM(CASE WHEN status='completed' AND date(completed_at)=date('now') THEN fare ELSE 0 END),0) AS today_revenue,
                  COALESCE(AVG(rating),0) AS avg_rating
           FROM rides WHERE driver_id=?""",
        (drv["id"],),
    ).fetchone()
    conn.close()
    return jsonify({**dict(stats), "total_earned": drv["total_earned"], "trips": drv["trips"]})


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------

def _require_admin():
    user = _auth_user()
    if not user or user["role"] != "admin":
        return None
    return user


@app.get("/api/admin/stats")
def api_admin_stats():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    stats = {
        "total_users": conn.execute("SELECT COUNT(*) c FROM users WHERE role='passenger'").fetchone()["c"],
        "total_drivers": conn.execute("SELECT COUNT(*) c FROM drivers").fetchone()["c"],
        "online_drivers": conn.execute("SELECT COUNT(*) c FROM drivers WHERE online=1").fetchone()["c"],
        "active_rides": conn.execute("SELECT COUNT(*) c FROM rides WHERE status IN ('requesting','assigned','driver_arriving','arrived','in_transit')").fetchone()["c"],
        "completed_rides": conn.execute("SELECT COUNT(*) c FROM rides WHERE status='completed'").fetchone()["c"],
        "cancelled_rides": conn.execute("SELECT COUNT(*) c FROM rides WHERE status='cancelled'").fetchone()["c"],
        "revenue": conn.execute("SELECT COALESCE(SUM(fare),0) s FROM rides WHERE status='completed'").fetchone()["s"],
        "today_rides": conn.execute("SELECT COUNT(*) c FROM rides WHERE date(created_at)=date('now')").fetchone()["c"],
        "today_revenue": conn.execute("SELECT COALESCE(SUM(fare),0) s FROM rides WHERE status='completed' AND date(completed_at)=date('now')").fetchone()["s"],
    }
    conn.close()
    return jsonify(stats)


@app.get("/api/admin/rides")
def api_admin_rides():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    status = request.args.get("status") or ""
    conn = db.get_conn()
    q = """SELECT r.*, u.name AS passenger_name, d.name AS driver_name
           FROM rides r
           LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN drivers d ON d.id = r.driver_id"""
    if status:
        q += " WHERE r.status=?"
        rows = conn.execute(q, (status,)).fetchall()
    else:
        rows = conn.execute(q + " ORDER BY r.id DESC LIMIT 200").fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.get("/api/admin/rides/<int:ride_id>")
def api_admin_ride_detail(ride_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    row = conn.execute(
        """SELECT r.*, u.name AS passenger_name, u.phone AS passenger_phone,
                  d.name AS driver_name, d.phone AS driver_phone, d.vehicle_type, d.vehicle_reg, d.rating
           FROM rides r
           LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN drivers d ON d.id = r.driver_id
           WHERE r.id=?""",
        (ride_id,),
    ).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "Ride not found"}), 404
    return jsonify(_to_dict(row))


@app.post("/api/admin/rides/<int:ride_id>/cancel")
def api_admin_cancel_ride(ride_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM rides WHERE id=?", (ride_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Ride not found"}), 404
    if row["status"] in ("completed", "cancelled"):
        conn.close()
        return jsonify({"error": "Ride already finished"}), 400
    conn.execute(
        """UPDATE rides SET status='cancelled', cancelled_at=datetime('now'),
           cancel_reason=COALESCE(cancel_reason,'cancelled_by_admin')
           WHERE id=?""",
        (ride_id,),
    )
    conn.execute(
        "UPDATE drivers SET status='available' WHERE id=?",
        (row["driver_id"],),
    ) if row["driver_id"] else None
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/admin/drivers")
def api_admin_drivers():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    rows = conn.execute(
        """SELECT d.*, u.created_at AS joined,
           (SELECT COUNT(*) FROM rides r WHERE r.driver_id=d.id AND r.status='completed') AS completed_rides
           FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY d.id"""
    ).fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.get("/api/admin/users")
def api_admin_users():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    rows = conn.execute(
        """SELECT u.*, (SELECT COUNT(*) FROM rides r WHERE r.user_id=u.id) AS rides
           FROM users u WHERE u.role='passenger' ORDER BY u.id"""
    ).fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.put("/api/admin/drivers/<int:driver_id>/approve")
def api_admin_approve_driver(driver_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    conn = db.get_conn()
    conn.execute("UPDATE drivers SET approved=? WHERE id=?", (1 if body.get("approved") else 0, driver_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.put("/api/admin/drivers/<int:driver_id>/suspend")
def api_admin_suspend_driver(driver_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    conn = db.get_conn()
    conn.execute("UPDATE drivers SET online=0, status='offline' WHERE id=?", (driver_id,))
    conn.execute("UPDATE drivers SET approved=? WHERE id=?", (0 if body.get("suspend") else 1, driver_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/admin/analytics")
def api_admin_analytics():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    by_day = conn.execute(
        """SELECT date(created_at) AS day, COUNT(*) AS rides,
                  COALESCE(SUM(CASE WHEN status='completed' THEN fare END),0) AS revenue
           FROM rides GROUP BY date(created_at) ORDER BY day DESC LIMIT 7"""
    ).fetchall()
    by_vehicle = conn.execute(
        """SELECT vehicle_type AS v, COUNT(*) AS n FROM rides GROUP BY vehicle_type"""
    ).fetchall()
    by_status = conn.execute(
        """SELECT status AS s, COUNT(*) AS n FROM rides GROUP BY status"""
    ).fetchall()
    payment_mix = conn.execute(
        """SELECT payment_method AS p, COUNT(*) AS n FROM rides GROUP BY payment_method"""
    ).fetchall()
    top_drivers = conn.execute(
        """SELECT d.id, d.name, d.vehicle_type, d.rating,
                  COUNT(r.id) AS rides, COALESCE(SUM(r.fare),0) AS revenue
           FROM drivers d
           LEFT JOIN rides r ON r.driver_id=d.id AND r.status='completed'
           GROUP BY d.id ORDER BY revenue DESC LIMIT 5"""
    ).fetchall()
    conn.close()
    return jsonify({
        "by_day": [_to_dict(r) for r in by_day][::-1],
        "by_vehicle": [_to_dict(r) for r in by_vehicle],
        "by_status": [_to_dict(r) for r in by_status],
        "payment_mix": [_to_dict(r) for r in payment_mix],
        "top_drivers": [_to_dict(r) for r in top_drivers],
    })


@app.put("/api/admin/users/<int:user_id>")
def api_admin_edit_user(user_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "User not found"}), 404
    name = (body.get("name") or row["name"]).strip()
    phone = _norm_phone(body.get("phone")) or row["phone"]
    conn.execute("UPDATE users SET name=?, phone=? WHERE id=?", (name, phone, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/admin/users/<int:user_id>")
def api_admin_delete_user(user_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "User not found"}), 404
    if row["role"] == "admin":
        conn.close()
        return jsonify({"error": "Cannot delete admin"}), 400
    if row["role"] == "driver":
        drv = conn.execute("SELECT id FROM drivers WHERE user_id=?", (user_id,)).fetchone()
        if drv:
            conn.execute("DELETE FROM ride_events WHERE driver_id=?", (drv["id"],))
            conn.execute("UPDATE rides SET driver_id=NULL WHERE driver_id=?", (drv["id"],))
            conn.execute("DELETE FROM drivers WHERE id=?", (drv["id"],))
    conn.execute("DELETE FROM messages WHERE sender_user_id=?", (user_id,))
    conn.execute("DELETE FROM rides WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.put("/api/admin/drivers/<int:driver_id>")
def api_admin_edit_driver(driver_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    body = _json_body()
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM drivers WHERE id=?", (driver_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Driver not found"}), 404
    name = (body.get("name") or row["name"]).strip()
    vehicle_type = body.get("vehicle_type") or row["vehicle_type"]
    vehicle_reg = body.get("vehicle_reg") or row["vehicle_reg"]
    conn.execute("UPDATE drivers SET name=?, vehicle_type=?, vehicle_reg=? WHERE id=?",
                 (name, vehicle_type, vehicle_reg, driver_id))
    conn.execute("UPDATE users SET name=? WHERE id=?", (name, row["user_id"]))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/admin/drivers/<int:driver_id>")
def api_admin_delete_driver(driver_id):
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM drivers WHERE id=?", (driver_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({"error": "Driver not found"}), 404
    conn.execute("DELETE FROM ride_events WHERE driver_id=?", (driver_id,))
    conn.execute("DELETE FROM messages WHERE ride_id IN (SELECT id FROM rides WHERE driver_id=?)", (driver_id,))
    conn.execute("UPDATE rides SET driver_id=NULL WHERE driver_id=?", (driver_id,))
    conn.execute("DELETE FROM drivers WHERE id=?", (driver_id,))
    conn.execute("UPDATE users SET role='passenger' WHERE id=?", (row["user_id"],))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Chat / Messaging
# ---------------------------------------------------------------------------

BOT_RESPONSES = {
    "hello": "Hello! Welcome to iSafedrive support. How can I help you today?",
    "hi": "Hi there! How can I assist you?",
    "help": "I can help with: ride issues, payment problems, account questions, safety concerns, and general inquiries. What's your question?",
    "fare": "Fares are calculated based on distance, time, and vehicle type. You can see the fare breakdown before booking. Use promo code SAFE10 for 10% off!",
    "payment": "We accept cash, card, and bank transfers. Card payments are processed securely. If you have payment issues, please describe the problem.",
    "cancel": "You can cancel a ride from the app. Cancellation fees may apply if the driver is already on the way. Need help with a specific ride?",
    "safety": "Your safety is our priority. Use the SOS button during any ride to call emergency services. All drivers are verified and rated.",
    "driver": "All our drivers go through background checks and vehicle inspections. You can rate your driver after each ride.",
    "complaint": "I'm sorry to hear that. Please provide details about your issue and I'll escalate it to our support team.",
    "refund": "Refunds are processed within 24-48 hours for eligible cases. Please provide your ride ID and reason for the refund request.",
    "account": "For account issues, you can update your profile in the app. For password resets or account deletion, please contact us with your registered phone number.",
    "default": "Thank you for reaching out! I've noted your message. Our support team will review it. Is there anything else I can help with?",
}


def _bot_reply(content):
    text = content.lower().strip()
    for key, reply in BOT_RESPONSES.items():
        if key != "default" and key in text:
            return reply
    return BOT_RESPONSES["default"]


@app.post("/api/messages")
def api_send_message():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    body = _json_body()
    content = (body.get("content") or "").strip()
    if not content:
        return jsonify({"error": "Message content required"}), 400
    ride_id = body.get("ride_id")
    conv_type = body.get("conversation_type", "ride" if ride_id else "support")
    sender_role = user["role"]
    conn = db.get_conn()
    cur = conn.execute(
        "INSERT INTO messages(ride_id, conversation_type, sender_user_id, sender_role, content) VALUES(?,?,?,?,?)",
        (ride_id, conv_type, user["id"], sender_role, content),
    )
    msg_id = cur.lastrowid
    conn.commit()
    msg = conn.execute("SELECT * FROM messages WHERE id=?", (msg_id,)).fetchone()
    conn.close()
    result = _to_dict(msg)
    if conv_type == "support":
        bot_content = _bot_reply(content)
        conn2 = db.get_conn()
        conn2.execute(
            "INSERT INTO messages(ride_id, conversation_type, sender_user_id, sender_role, content) VALUES(?,'support',NULL,'bot',?)",
            (None, bot_content),
        )
        conn2.commit()
        bot_msg = conn2.execute("SELECT * FROM messages WHERE id=last_insert_rowid()").fetchone()
        conn2.close()
        result["bot_reply"] = _to_dict(bot_msg)
    return jsonify(result), 201


@app.get("/api/messages")
def api_get_messages():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    ride_id = request.args.get("ride_id")
    conv_type = request.args.get("type", "ride" if ride_id else "support")
    conn = db.get_conn()
    if ride_id:
        rows = conn.execute(
            "SELECT * FROM messages WHERE ride_id=? AND conversation_type='ride' ORDER BY id",
            (int(ride_id),),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_type='support' AND (sender_user_id=? OR sender_role='bot') ORDER BY id",
            (user["id"],),
        ).fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.get("/api/admin/messages")
def api_admin_messages():
    user = _require_admin()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401
    conn = db.get_conn()
    rows = conn.execute(
        """SELECT m.*, u.name AS sender_name FROM messages m
           LEFT JOIN users u ON u.id = m.sender_user_id
           ORDER BY m.id DESC LIMIT 200"""
    ).fetchall()
    conn.close()
    return jsonify([_to_dict(r) for r in rows])


@app.get("/api/notifications")
def api_notifications():
    user = _auth_user()
    if not user:
        return jsonify({"error": "Not authenticated"}), 401
    conn = db.get_conn()
    notifs = []
    if user["role"] == "passenger":
        rides = conn.execute(
            "SELECT id, status, trip_code, driver_id FROM rides WHERE user_id=? ORDER BY id DESC LIMIT 10",
            (user["id"],),
        ).fetchall()
        for r in rides:
            if r["status"] == "assigned":
                notifs.append({"title": "Driver Found!", "body": "Your driver is heading to pickup", "type": "ride_assigned", "ride_id": r["id"]})
            elif r["status"] == "arrived":
                notifs.append({"title": "Driver Arrived!", "body": "Your driver is waiting at pickup", "type": "driver_arrived", "ride_id": r["id"]})
            elif r["status"] == "completed":
                notifs.append({"title": "Trip Complete", "body": "Thanks for riding with iSafedrive", "type": "ride_completed", "ride_id": r["id"]})
    elif user["role"] == "driver":
        drv = conn.execute("SELECT id FROM drivers WHERE user_id=?", (user["id"],)).fetchone()
        if drv:
            rides = conn.execute(
                "SELECT id, status FROM rides WHERE driver_id=? AND status IN ('assigned','completed') ORDER BY id DESC LIMIT 10",
                (drv["id"],),
            ).fetchall()
            for r in rides:
                if r["status"] == "completed":
                    notifs.append({"title": "Trip Completed", "body": f"Ride #{r['id']} completed successfully", "type": "ride_completed", "ride_id": r["id"]})
    conn.close()
    return jsonify(notifs)


# ---------------------------------------------------------------------------
# Static + entry
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory("../static", "index.html")


if __name__ == "__main__":
    db.init_db(reset=True)
    print("=" * 56)
    print("  iSafedrive API running -> http://127.0.0.1:5000")
    print("  Admin bootstrap: 07000000000 / admin123")
    print("  Passengers & drivers: register in-app (no demo data)")
    print("=" * 56)
    app.run(debug=True, host="127.0.0.1", port=5000, use_reloader=False)
