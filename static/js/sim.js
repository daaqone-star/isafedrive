/*
 * iSafedrive — browser simulation backend.
 *
 * Implements the same API surface as the Flask server, persisted in
 * localStorage. It drives live driver movement and stays in sync across
 * tabs (one tab acts as the sim leader). Starts empty — no demo data.
 */
(function (global) {
  const KEY = "isafedrive_sim_v3";
  const LOCK_KEY = "isafedrive_sim_lock";
  const TICK = 2000;

  const LAGOS = { lat: 6.5244, lng: 3.3792 };

  const FARE_TABLE = global.U.FARE_TABLE;
  const H = global.U.haversine;

  const PROMOS = { SAFE10: 10, WELCOME20: 20 };

  function applyPromo(fare, code) {
    const c = String(code || "").trim().toUpperCase();
    if (!c || !PROMOS[c]) return { fare, discount: 0, code: null };
    const discount = Math.round(fare * PROMOS[c] / 100);
    return { fare: fare - discount, discount, code: c };
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function seed() {
    return { seq: 1, users: [], drivers: [], rides: [], events: [] };
  }

  function isoNow() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  let state = null;
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { state = JSON.parse(raw); if (state && state.users) return; }
    } catch (e) { /* ignore */ }
    state = seed();
    save();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  function userById(id) { return state.users.find((u) => u.id === Number(id)); }
  function driverByUserId(uid) { return state.drivers.find((d) => d.user_id === Number(uid)); }
  function rideById(id) { return state.rides.find((r) => r.id === Number(id)); }
  function nextId(table) {
    const mx = table.reduce((m, r) => Math.max(m, r.id), 0);
    return mx + 1;
  }

  // Identity is passed explicitly by the backend headers in server mode; in
  // sim mode the UI calls without ids, so we fall back to the logged-in user.
  function sessionUser() {
    try { return JSON.parse(sessionStorage.getItem("isafedrive_user") || "null"); }
    catch (e) { return null; }
  }
  function sessionUserId() { const u = sessionUser(); return u ? u.id : null; }
  function sessionDriverId() {
    const u = sessionUser();
    if (!u) return null;
    const d = driverByUserId(u.id);
    return d ? d.id : null;
  }

  function estimateFare(vtype, distKm) {
    const cfg = FARE_TABLE[vtype] || FARE_TABLE.Mini;
    const minutes = Math.max(3, distKm * 5);
    return Math.round(cfg.base + distKm * cfg.per_km + minutes * cfg.per_min);
  }

  function withDriver(ride) {
    const out = clone(ride);
    if (out.driver_id) {
      const d = state.drivers.find((x) => x.id === out.driver_id);
      if (d) out.driver = sanitizeDriver(d);
    }
    return out;
  }

  function sanitizeDriver(d) {
    const { base_lat, base_lng, ...rest } = d;
    return rest;
  }

  function logEvent(rideId, driverId, action) {
    state.events.push({ ride_id: rideId, driver_id: driverId, action, created_at: isoNow() });
  }

  // -----------------------------------------------------------------
  // Movement + auto-assign tick (only the leader tab runs this)
  // -----------------------------------------------------------------

  function moveDriver(d) {
    if (d.status === "offline") return;
    if (d.status === "busy") {
      const ride = state.rides.find(
        (r) => r.driver_id === d.id &&
          ["assigned", "driver_arriving", "arrived", "in_transit"].includes(r.status)
      );
      if (ride) {
        const target = ride.status === "in_transit"
          ? { lat: ride.dropoff_lat, lng: ride.dropoff_lng }
          : { lat: ride.pickup_lat, lng: ride.pickup_lng };
        moveToward(d, target, 0.0035);
        return;
      }
      d.status = "available";
    }
    // idle drift near base
    moveToward(d, { lat: d.base_lat, lng: d.base_lng }, 0.0015);
  }

  function moveToward(d, target, speed) {
    const dist = H(d, target);
    if (dist < 0.045) return; // arrived
    const f = speed / Math.max(dist, speed);
    d.lat += (target.lat - d.lat) * f;
    d.lng += (target.lng - d.lng) * f;
  }

  function tick() {
    for (const d of state.drivers) moveDriver(d);
    save();
  }

  // Leader election so only one tab simulates movement.
  function tryBecomeLeader() {
    const now = Date.now();
    try {
      const lock = localStorage.getItem(LOCK_KEY);
      if (lock) {
        const t = parseInt(lock, 10);
        if (now - t < 6000) return false;
      }
      localStorage.setItem(LOCK_KEY, String(now));
      return true;
    } catch (e) { return true; }
  }
  setInterval(() => {
    if (tryBecomeLeader()) { try { tick(); } catch (e) { /* ignore */ } }
  }, TICK);

  // -----------------------------------------------------------------
  // Public API (Promise-based, mirrors the Flask backend)
  // -----------------------------------------------------------------

  const API = {
    mode: "sim",

    login({ phone, password }) {
      load();
      const u = state.users.find((x) => x.phone === phone && x.password === password);
      if (!u) return Promise.reject({ error: "Invalid phone or password" });
      return Promise.resolve({ token: u.id, user: sanitizeUser(u) });
    },

    register(body) {
      load();
      if (body.role === "admin")
        return Promise.reject({ error: "Admin accounts are provisioned by the platform" });
      if (state.users.some((u) => u.phone === body.phone))
        return Promise.reject({ error: "Phone number already registered" });
      const u = {
        id: nextId(state.users), name: body.name, phone: body.phone,
        password: body.password, role: body.role || "passenger", created_at: isoNow(),
      };
      state.users.push(u);
      if (u.role === "driver") {
        state.drivers.push({
          id: nextId(state.drivers), user_id: u.id, name: u.name, phone: u.phone,
          vehicle_type: body.vehicle_type || "Mini", vehicle_reg: body.vehicle_reg || "---",
          rating: 5, trips: 0, online: 0, approved: 0, status: "offline",
          lat: LAGOS.lat, lng: LAGOS.lng, total_earned: 0,
          base_lat: LAGOS.lat, base_lng: LAGOS.lng,
        });
      }
      save();
      return Promise.resolve({ token: u.id, user: sanitizeUser(u) });
    },

    me() {
      const s = sessionStorage.getItem("isafedrive_user");
      if (!s) return Promise.reject({ error: "Not authenticated" });
      const u = userById(JSON.parse(s).id);
      if (!u) return Promise.reject({ error: "Not authenticated" });
      const out = sanitizeUser(u);
      if (u.role === "driver") out.driver = sanitizeDriver(driverByUserId(u.id));
      return Promise.resolve(out);
    },

    driversNearby(lat, lng, vtype, radius) {
      load();
      const r = state.drivers.filter(
        (d) => d.approved && d.online && d.status === "available" &&
          (!vtype || vtype === "any" || d.vehicle_type === vtype)
      ).map((d) => {
        const o = sanitizeDriver(d);
        o.distance_km = Math.round(H(d, { lat, lng }) * 100) / 100;
        return o;
      });
      const within = r.filter((d) => d.distance_km <= (radius || 5));
      within.sort((a, b) => a.distance_km - b.distance_km);
      return Promise.resolve(within);
    },

    createRide(body, userId) {
      load();
      userId = userId ?? sessionUserId();
      const dist = H(body.pickup, body.dropoff);
      const dur = Math.max(3, Math.round(dist * 5));
      const promo = applyPromo(estimateFare(body.vehicle_type || "Mini", dist), body.promo_code);
      const ride = {
        id: nextId(state.rides),
        user_id: Number(userId),
        driver_id: null,
        pickup_lat: body.pickup.lat, pickup_lng: body.pickup.lng,
        pickup_address: body.pickup.address || "",
        dropoff_lat: body.dropoff.lat, dropoff_lng: body.dropoff.lng,
        dropoff_address: body.dropoff.address || "",
        vehicle_type: body.vehicle_type || "Mini",
        distance_km: Math.round(dist * 100) / 100,
        duration_min: dur,
        fare: promo.fare,
        promo_code: promo.code,
        discount: promo.discount,
        payment_method: body.payment_method || "cash",
        status: "requesting",
        rating: null, comment: null,
        created_at: isoNow(),
        accepted_at: null, started_at: null, completed_at: null, cancelled_at: null,
        cancel_reason: null,
      };
      state.rides.push(ride);
      save();
      return Promise.resolve(withDriver(ride));
    },

    getRide(id) {
      load();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Ride not found" });
      return Promise.resolve(withDriver(r));
    },

    listRides(role, userId) {
      load();
      role = role ?? sessionUser()?.role;
      userId = userId ?? sessionUserId();
      let rows;
      if (role === "driver") {
        const d = driverByUserId(userId);
        if (!d) return Promise.resolve([]);
        rows = state.rides.filter((r) => r.driver_id === d.id);
      } else {
        rows = state.rides.filter((r) => r.user_id === Number(userId));
      }
      rows.sort((a, b) => b.id - a.id);
      return Promise.resolve(rows.slice(0, 50).map(withDriver));
    },

    pendingRides(lat, lng, radius, driverId) {
      load();
      driverId = driverId ?? sessionDriverId();
      const d = state.drivers.find((x) => x.id === driverId);
      if (!d) return Promise.resolve([]);
      const declined = new Set(
        state.events.filter((e) => e.action === "declined").map((e) => `${e.ride_id}:${e.driver_id}`)
      );
      const rows = state.rides
        .filter((r) => r.status === "requesting")
        .map((r) => {
          const dist = H({ lat, lng }, { lat: r.pickup_lat, lng: r.pickup_lng });
          return { ride: r, dist };
        })
        .filter((o) => o.dist <= (radius || 8))
        .map((o) => {
          const r = withDriver(o.ride);
          if (declined.has(`${r.id}:${d.id}`)) return null;
          r.distance_to_pickup_km = Math.round(o.dist * 100) / 100;
          r.passenger_name = userById(r.user_id)?.name || "Passenger";
          return r;
        })
        .filter(Boolean);
      rows.sort((a, b) => a.id - b.id);
      return Promise.resolve(rows);
    },

    acceptRide(id, driverId) {
      load();
      driverId = driverId ?? sessionDriverId();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Not found" });
      if (r.status !== "requesting") return Promise.reject({ error: "Ride no longer available" });
      const d = state.drivers.find((x) => x.id === driverId);
      if (!d) return Promise.reject({ error: "Not found" });
      r.driver_id = d.id;
      r.status = "assigned";
      r.accepted_at = isoNow();
      d.status = "busy";
      d.trips += 1;
      logEvent(r.id, d.id, "accepted");
      save();
      return Promise.resolve(withDriver(r));
    },

    declineRide(id, driverId) {
      load();
      logEvent(Number(id), Number(driverId ?? sessionDriverId()), "declined");
      save();
      return Promise.resolve({ ok: true });
    },

    updateRideStatus(id, status, driverId) {
      load();
      driverId = driverId ?? sessionDriverId();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Not found" });
      if (!r.driver_id) return Promise.reject({ error: "No driver assigned" });
      r.status = status;
      if (status === "in_transit") r.started_at = isoNow();
      logEvent(r.id, r.driver_id, status);
      save();
      return Promise.resolve(withDriver(r));
    },

    completeRide(id, driverId) {
      load();
      driverId = driverId ?? sessionDriverId();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Not found" });
      const d = state.drivers.find((x) => x.id === driverId);
      if (!d) return Promise.reject({ error: "Not found" });
      r.status = "completed";
      r.completed_at = isoNow();
      d.status = "available";
      d.total_earned += r.fare;
      logEvent(r.id, d.id, "completed");
      save();
      return Promise.resolve(withDriver(r));
    },

    cancelRide(id, userId, reason) {
      load();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Not found" });
      if (r.status === "completed" || r.status === "cancelled")
        return Promise.reject({ error: "Ride already finished" });
      r.status = "cancelled";
      r.cancelled_at = isoNow();
      r.cancel_reason = reason || "";
      if (r.driver_id) {
        const d = state.drivers.find((x) => x.id === r.driver_id);
        if (d) d.status = "available";
      }
      logEvent(r.id, r.driver_id, "cancelled");
      save();
      return Promise.resolve(withDriver(r));
    },

    rateRide(id, rating, comment) {
      load();
      const r = rideById(id);
      if (!r) return Promise.reject({ error: "Not found" });
      r.rating = rating;
      r.comment = comment || "";
      if (r.driver_id) {
        const d = state.drivers.find((x) => x.id === r.driver_id);
        if (d) {
          const rated = state.rides.filter((x) => x.driver_id === d.id && x.rating);
          d.rating = rated.length
            ? Math.round((rated.reduce((s, x) => s + x.rating, 0) / rated.length) * 100) / 100
            : rating;
        }
      }
      save();
      return Promise.resolve({ ok: true });
    },

    driverEarnings(userId) {
      load();
      userId = userId ?? sessionUserId();
      const d = driverByUserId(userId);
      if (!d) return Promise.resolve({});
      const rides = state.rides.filter((r) => r.driver_id === d.id);
      const today = new Date().toISOString().slice(0, 10);
      const todayRides = rides.filter((r) => r.status === "completed" && (r.completed_at || "").slice(0, 10) === today);
      return Promise.resolve({
        total: rides.length,
        revenue: rides.filter((r) => r.status === "completed").reduce((s, r) => s + r.fare, 0),
        today_rides: todayRides.length,
        today_revenue: todayRides.reduce((s, r) => s + r.fare, 0),
        avg_rating: d.rating,
        total_earned: d.total_earned,
        trips: d.trips,
      });
    },

    toggleDriver(userId, online) {
      load();
      userId = userId ?? sessionUserId();
      const d = driverByUserId(userId);
      if (!d) return Promise.reject({ error: "Not found" });
      d.online = online ? 1 : 0;
      d.status = online ? "available" : "offline";
      save();
      return Promise.resolve(sanitizeDriver(d));
    },

    adminStats() {
      load();
      const rides = state.rides;
      const completed = rides.filter((r) => r.status === "completed");
      const today = new Date().toISOString().slice(0, 10);
      return Promise.resolve({
        total_users: state.users.filter((u) => u.role === "passenger").length,
        total_drivers: state.drivers.length,
        online_drivers: state.drivers.filter((d) => d.online).length,
        active_rides: rides.filter((r) => ["requesting", "assigned", "driver_arriving", "arrived", "in_transit"].includes(r.status)).length,
        completed_rides: completed.length,
        cancelled_rides: rides.filter((r) => r.status === "cancelled").length,
        revenue: completed.reduce((s, r) => s + r.fare, 0),
        today_rides: rides.filter((r) => (r.created_at || "").slice(0, 10) === today).length,
        today_revenue: completed.filter((r) => (r.completed_at || "").slice(0, 10) === today).reduce((s, r) => s + r.fare, 0),
      });
    },

    adminRides(status) {
      load();
      let rows = state.rides.slice().sort((a, b) => b.id - a.id);
      if (status) rows = rows.filter((r) => r.status === status);
      return Promise.resolve(rows.map((r) => ({
        ...withDriver(r),
        passenger_name: userById(r.user_id)?.name || "—",
        driver_name: r.driver_id ? state.drivers.find((d) => d.id === r.driver_id)?.name : null,
      })));
    },

    adminRide(id) {
      load();
      const r = state.rides.find((x) => x.id === Number(id));
      if (!r) return Promise.resolve(null);
      const d = r.driver_id ? state.drivers.find((x) => x.id === r.driver_id) : null;
      const p = userById(r.user_id);
      return Promise.resolve({
        ...r, passenger_name: p?.name, passenger_phone: p?.phone,
        driver_name: d?.name, driver_phone: d?.phone,
        vehicle_type: r.vehicle_type, vehicle_reg: d?.vehicle_reg, rating: d?.rating,
      });
    },

    adminCancelRide(id) {
      load();
      const r = state.rides.find((x) => x.id === Number(id));
      if (!r || ["completed", "cancelled"].includes(r.status)) return Promise.resolve({ error: "Ride already finished" });
      r.status = "cancelled";
      r.cancelled_at = new Date().toISOString().slice(0, 19).replace("T", " ");
      r.cancel_reason = r.cancel_reason || "cancelled_by_admin";
      save();
      return Promise.resolve({ ok: true });
    },

    adminDrivers() {
      load();
      return Promise.resolve(state.drivers.map((d) => {
        const o = sanitizeDriver(d);
        o.joined = userById(d.user_id)?.created_at || "";
        o.completed_rides = state.rides.filter((r) => r.driver_id === d.id && r.status === "completed").length;
        return o;
      }));
    },

    adminUsers() {
      load();
      return Promise.resolve(state.users
        .filter((u) => u.role === "passenger")
        .map((u) => ({ ...sanitizeUser(u), rides: state.rides.filter((r) => r.user_id === u.id).length })));
    },

    adminApproveDriver(id, approved) {
      load();
      const d = state.drivers.find((x) => x.id === Number(id));
      if (d) { d.approved = approved ? 1 : 0; save(); }
      return Promise.resolve({ ok: true });
    },

    adminSuspendDriver(id, suspend) {
      load();
      const d = state.drivers.find((x) => x.id === Number(id));
      if (d) {
        d.approved = suspend ? 0 : 1;
        if (suspend) { d.online = 0; d.status = "offline"; }
        save();
      }
      return Promise.resolve({ ok: true });
    },

    adminAnalytics() {
      load();
      const byDay = {};
      const byVehicle = {};
      const byStatus = {};
      for (const r of state.rides) {
        const day = (r.created_at || "").slice(0, 10);
        if (!byDay[day]) byDay[day] = { rides: 0, revenue: 0 };
        byDay[day].rides++;
        if (r.status === "completed") byDay[day].revenue += r.fare;
        byVehicle[r.vehicle_type] = (byVehicle[r.vehicle_type] || 0) + 1;
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      }
      return Promise.resolve({
        by_day: Object.keys(byDay).sort().map((d) => ({ day: d, ...byDay[d] })),
        by_vehicle: Object.keys(byVehicle).map((v) => ({ v, n: byVehicle[v] })),
        by_status: Object.keys(byStatus).map((s) => ({ s, n: byStatus[s] })),
        payment_mix: Object.entries(state.rides.reduce((m, r) => {
          m[r.payment_method] = (m[r.payment_method] || 0) + 1;
          return m;
        }, {})).map(([p, n]) => ({ p, n })),
        top_drivers: state.drivers.map((d) => {
          const done = state.rides.filter((r) => r.driver_id === d.id && r.status === "completed");
          return {
            id: d.id, name: d.name, vehicle_type: d.vehicle_type, rating: d.rating,
            rides: done.length,
            revenue: done.reduce((s, r) => s + r.fare, 0),
          };
        }).sort((a, b) => b.revenue - a.revenue).slice(0, 5),
      });
    },

    adminEditUser(id, data) {
      load();
      const u = state.users.find((x) => x.id === Number(id));
      if (u) { if (data.name) u.name = data.name; if (data.phone) u.phone = data.phone; save(); }
      return Promise.resolve({ ok: true });
    },

    adminDeleteUser(id) {
      load();
      state.users = state.users.filter((x) => x.id !== Number(id));
      state.rides = state.rides.filter((x) => x.user_id !== Number(id));
      save();
      return Promise.resolve({ ok: true });
    },

    adminEditDriver(id, data) {
      load();
      const d = state.drivers.find((x) => x.id === Number(id));
      if (d) {
        if (data.name) d.name = data.name;
        if (data.vehicle_type) d.vehicle_type = data.vehicle_type;
        if (data.vehicle_reg) d.vehicle_reg = data.vehicle_reg;
        const u = state.users.find((x) => x.id === d.user_id);
        if (u && data.name) u.name = data.name;
        save();
      }
      return Promise.resolve({ ok: true });
    },

    adminDeleteDriver(id) {
      load();
      const d = state.drivers.find((x) => x.id === Number(id));
      if (d) {
        state.rides.forEach((r) => { if (r.driver_id === d.id) r.driver_id = null; });
        state.drivers = state.drivers.filter((x) => x.id !== d.id);
        const u = state.users.find((x) => x.id === d.user_id);
        if (u) u.role = "passenger";
        save();
      }
      return Promise.resolve({ ok: true });
    },

    sendMessage(data) {
      load();
      if (!state.messages) state.messages = [];
      const u = sessionUser();
      const msg = {
        id: nextId(state.messages), ride_id: data.ride_id || null,
        conversation_type: data.conversation_type || (data.ride_id ? "ride" : "support"),
        sender_user_id: u ? u.id : null, sender_role: u ? u.role : "passenger",
        content: data.content, created_at: isoNow(),
      };
      state.messages.push(msg);
      const result = { ...msg };
      if (msg.conversation_type === "support") {
        const bot = { id: nextId(state.messages), ride_id: null, conversation_type: "support",
          sender_user_id: null, sender_role: "bot", content: _botReplyLocal(data.content), created_at: isoNow() };
        state.messages.push(bot);
        result.bot_reply = bot;
      }
      save();
      return Promise.resolve(result);
    },

    getMessages(rideId) {
      load();
      const u = sessionUser();
      const msgs = (state.messages || []).filter((m) => {
        if (rideId) return m.ride_id === Number(rideId) && m.conversation_type === "ride";
        return m.conversation_type === "support" && (m.sender_user_id === (u ? u.id : null) || m.sender_role === "bot");
      });
      return Promise.resolve(msgs);
    },

    adminMessages() {
      load();
      return Promise.resolve(state.messages || []);
    },
  };

  const BOT_RESPONSES_LOCAL = {
    hello: "Hello! Welcome to iSafedrive support.",
    hi: "Hi there! How can I assist you?",
    help: "I can help with ride issues, payments, account questions, and more.",
    default: "Thank you for your message. Our support team will review it.",
  };
  function _botReplyLocal(content) {
    const t = (content || "").toLowerCase();
    for (const [k, v] of Object.entries(BOT_RESPONSES_LOCAL)) { if (k !== "default" && t.includes(k)) return v; }
    return BOT_RESPONSES_LOCAL.default;
  }

  function sanitizeUser(u) {
    const { password, ...rest } = u;
    return rest;
  }

  load();
  global.Sim = API;
})(window);
