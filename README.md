# iSafedrive 🚗

A full-featured Nigerian ride-hailing platform: **Passenger app**, **Driver app**, and **Admin dashboard**, all with **live maps**, **ride booking**, live driver tracking, and fares in Naira. Ships with **no demo/mock data** — every passenger and driver registers fresh.

Built with Flask + SQLite (backend) and a mobile-first single-page web app (frontend) using **Leaflet + OpenStreetMap** — no API keys needed.

![Stack](https://img.shields.io/badge/Flask-3.x-1a7dff) ![Map](https://img.shields.io/badge/Leaflet%2BOSM-free-1a7dff)

---

## ✨ Features

### 👤 Passenger app
- Live interactive map (Leaflet + OpenStreetMap)
- Tap the map to set pickup & dropoff (or use "current location")
- Vehicle choice: Mini, Sedan, SUV, Premium, Okada, Keke
- Instant fare estimate in ₦ (base + per km + per min)
- Book a ride → live driver dispatch, tracking, and status timeline
- Payment method: cash / card / bank transfer
- Trip history, profile, and driver rating

### 🧑‍✈️ Driver app
- Go Online / Offline (visible to the platform instantly)
- Incoming ride requests with fare, route and distance
- Accept / Decline requests
- On-trip flow: head to pickup → arrived → start trip → complete
- Live position reported to the map (simulated GPS)
- Earnings dashboard (today + lifetime), trip history, profile

### 🛡️ Admin dashboard
- Live map of every driver (online / busy / offline) + active rides
- KPIs: rides, revenue, online drivers, passengers, active rides
- Rides manager with status filters
- Driver management: approve, revoke, suspend
- Passenger directory
- Analytics: revenue by day, vehicle mix, status mix

---

## 🚀 Quick start (Windows)

```bat
start.bat
```

Or manually:

```bash
python -m pip install -r requirements.txt
python run.py
```

Then open **http://127.0.0.1:5000** in your browser.

> **Two modes, automatically detected:**
> - **LIVE** — the Flask server is running; all data is shared in real time.
> - **SIM** — no server needed; a full in-browser simulation runs instead (data persists in `localStorage`, synced across tabs).

---

## 🔑 Accounts

There is **no demo data**. Passenger and driver accounts are created in the app:

1. Open the app → pick a portal (Passenger / Driver / Admin).
2. Passengers & drivers: **Create account**, enter your name, phone and password (drivers also add vehicle details).
3. Admin: the platform ships one **bootstrap admin** — `07000000000` / `admin123`. Change it before going live.

Tip: open the passenger and driver apps in **two separate windows/tabs**, sign in to each, then book a ride from the passenger side and accept it from the driver side. A third tab as Admin shows everything live on the map.

---

## 🗺️ How the live map works

- Tiles come from OpenStreetMap (free, no key).
- Drivers report their own "GPS" while on a trip, so the passenger and admin dashboards show movement in real time.
- In SIM mode (no server) a movement simulation runs inside your browser so the live map stays lively.

---

## 📁 Project structure

```
iSafeApp/
├── run.py                # entry point (starts server)
├── requirements.txt
├── server/
│   ├── app.py            # Flask REST API (auth, rides, drivers, admin)
│   └── db.py             # SQLite schema, fare engine, promos, bootstrap admin
├── static/
│   ├── index.html        # single-page shell (passenger / driver / admin)
│   ├── css/styles.css    # mobile-first UI
│   └── js/
│       ├── util.js       # formatting + fare helpers
│       ├── sim.js        # in-browser simulation backend (SIM mode)
│       ├── api.js        # API bridge: server or simulation fallback
│       ├── map.js        # Leaflet helpers (markers, routes, fit)
│       ├── app.js        # bootstrap + auth + role routing
│       ├── passenger.js  # passenger app
│       ├── driver.js     # driver app
│       └── admin.js      # admin dashboard
└── test_api.py           # backend smoke tests (Flask test client)
└── test_http.py          # full HTTP smoke test
└── test_sim.js           # simulation-mode tests (Node)
```

---

## 🧪 Tests

```bash
python test_api.py      # backend API via Flask test client
python test_http.py     # real HTTP server smoke test
node   test_sim.js      # in-browser simulation logic (Node)
```

---

## 🔌 REST API overview

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Create user (passenger/driver) |
| POST | `/api/auth/login` | Sign in, returns token (user id) |
| GET | `/api/me` | Current user + driver record |
| GET | `/api/drivers/nearby` | Available drivers near a point |
| POST | `/api/rides` | Book a ride (estimates fare) |
| GET | `/api/rides/pending` | Requests near a driver |
| POST | `/api/rides/<id>/accept` | Driver accepts |
| POST | `/api/rides/<id>/decline` | Driver declines |
| POST | `/api/rides/<id>/status` | Advance trip (arrived / in_transit) |
| POST | `/api/rides/<id>/complete` | Finish trip |
| POST | `/api/rides/<id>/cancel` | Cancel a ride |
| POST | `/api/rides/<id>/rate` | Rate driver |
| GET | `/api/driver/earnings` | Driver earnings |
| PUT | `/api/driver/location` | Driver reports live GPS |
| GET | `/api/admin/stats` `/rides` `/drivers` `/users` `/analytics` | Admin data |

Auth: send `X-User-Id: <token>` header (demo-grade auth).

---

## ⚠️ Notes

- Demo-grade security (plain-text passwords, token = user id). Add real auth (JWT/BCrypt) before production.
- Rides wait for a real driver to accept them — there is no auto-assign or fake driver fill.
- Map tiles and reverse geocoding (Nominatim) require internet.
