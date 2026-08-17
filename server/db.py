"""
iSafedrive database layer.

SQLite schema. No demo/seed data — only a single bootstrap admin account.
"""
import math
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "isafedrive.db"

# Fares (NGN) by vehicle type: base fare + per-km + per-minute
FARE_TABLE = {
    "Mini":     {"base": 300, "per_km": 100, "per_min": 15, "seats": 4},
    "Sedan":    {"base": 400, "per_km": 140, "per_min": 18, "seats": 4},
    "SUV":      {"base": 700, "per_km": 220, "per_min": 25, "seats": 6},
    "Premium":  {"base": 1200, "per_km": 350, "per_min": 40, "seats": 4},
    "Okada":    {"base": 150, "per_km": 60,  "per_min": 10, "seats": 1},
    "Keke":     {"base": 200, "per_km": 80,  "per_min": 12, "seats": 3},
}

# Promo codes: code -> discount percent
PROMOS = {
    "SAFE10": 10,
    "WELCOME20": 20,
}

def apply_promo(fare, promo_code):
    """Return (final_fare, discount, normalized_code)."""
    code = (promo_code or "").strip().upper()
    if not code or code not in PROMOS:
        return int(fare), 0, None
    discount = int(round(int(fare) * PROMOS[code] / 100))
    return int(fare) - discount, discount, code

LAGOS_CENTER = (6.5244, 3.3792)


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def estimate_fare(vehicle_type, km, minutes):
    cfg = FARE_TABLE.get(vehicle_type, FARE_TABLE["Mini"])
    return int(cfg["base"] + km * cfg["per_km"] + minutes * cfg["per_min"])


def haversine(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def init_db(reset=True):
    conn = get_conn()
    if reset:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("DROP TABLE IF EXISTS messages")
        conn.execute("DROP TABLE IF EXISTS ride_events")
        conn.execute("DROP TABLE IF EXISTS rides")
        conn.execute("DROP TABLE IF EXISTS drivers")
        conn.execute("DROP TABLE IF EXISTS users")
        conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'passenger',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            vehicle_type TEXT NOT NULL,
            vehicle_reg TEXT NOT NULL,
            rating REAL DEFAULT 5.0,
            trips INTEGER DEFAULT 0,
            online INTEGER DEFAULT 0,
            approved INTEGER DEFAULT 1,
            status TEXT DEFAULT 'available',
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            total_earned REAL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS rides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            driver_id INTEGER,
            pickup_lat REAL NOT NULL,
            pickup_lng REAL NOT NULL,
            pickup_address TEXT DEFAULT '',
            dropoff_lat REAL NOT NULL,
            dropoff_lng REAL NOT NULL,
            dropoff_address TEXT DEFAULT '',
            vehicle_type TEXT NOT NULL,
            distance_km REAL DEFAULT 0,
            duration_min INTEGER DEFAULT 0,
            fare REAL DEFAULT 0,
            promo_code TEXT,
            discount REAL DEFAULT 0,
            payment_method TEXT DEFAULT 'cash',
            status TEXT DEFAULT 'requesting',
            rating INTEGER,
            comment TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            accepted_at TEXT,
            started_at TEXT,
            completed_at TEXT,
            cancelled_at TEXT,
            cancel_reason TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(driver_id) REFERENCES drivers(id)
        );

        CREATE TABLE IF NOT EXISTS ride_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ride_id INTEGER NOT NULL,
            driver_id INTEGER,
            action TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(ride_id) REFERENCES rides(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ride_id INTEGER,
            conversation_type TEXT NOT NULL DEFAULT 'ride',
            sender_user_id INTEGER,
            sender_role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(ride_id) REFERENCES rides(id),
            FOREIGN KEY(sender_user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
        CREATE INDEX IF NOT EXISTS idx_drivers_online ON drivers(online, approved, status);
        CREATE INDEX IF NOT EXISTS idx_messages_ride ON messages(ride_id, conversation_type);
        """
    )
    # Bootstrap: exactly one platform admin (no demo passengers, drivers or rides).
    if conn.execute("SELECT id FROM users WHERE role='admin'").fetchone() is None:
        conn.execute(
            "INSERT INTO users(name, phone, password, role) VALUES(?,?,?, 'admin')",
            ("iSafedrive Admin", "07000000000", "admin123"),
        )
    conn.commit()
    conn.close()

