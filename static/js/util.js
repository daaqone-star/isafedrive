/* iSafedrive — shared helpers */
(function (global) {
  let fmtN;
  try { fmtN = new Intl.NumberFormat("en-NG"); }
  catch (e) { fmtN = new Intl.NumberFormat("en-US"); }

  function ngn(amount) {
    return "₦" + fmtN.format(Math.round(amount || 0));
  }

  function km(dist) {
    if (dist == null) return "—";
    return dist < 1 ? (dist * 1000).toFixed(0) + " m" : dist.toFixed(2) + " km";
  }

  function mins(m) {
    if (m == null) return "—";
    return Math.round(m) + " min";
  }

  function haversine(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function routeDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
    return d;
  }

  const FARE_TABLE = {
    Mini: { base: 300, per_km: 100, per_min: 15, icon: "🚙", seats: 4 },
    Sedan: { base: 400, per_km: 140, per_min: 18, icon: "🚗", seats: 4 },
    SUV: { base: 700, per_km: 220, per_min: 25, icon: "🚐", seats: 6 },
    Premium: { base: 1200, per_km: 350, per_min: 40, icon: "🚘", seats: 4 },
    Okada: { base: 150, per_km: 60,  per_min: 10, icon: "🏍️", seats: 1 },
    Keke: { base: 200, per_km: 80,  per_min: 12, icon: "🛺", seats: 3 },
  };

  const PROMOS = { SAFE10: 10, WELCOME20: 20 };

  function applyPromo(fare, code) {
    const c = String(code || "").trim().toUpperCase();
    if (!c || !PROMOS[c]) return { fare, discount: 0, code: null };
    const discount = Math.round(fare * PROMOS[c] / 100);
    return { fare: fare - discount, discount, code: c };
  }

  function fareBreakdown(type, distanceKm) {
    const cfg = FARE_TABLE[type] || FARE_TABLE.Mini;
    const minutes = Math.max(3, Math.round(distanceKm * 5));
    return {
      base: cfg.base,
      distPart: Math.round(distanceKm * cfg.per_km),
      timePart: Math.round(minutes * cfg.per_min),
      minutes,
    };
  }

  function estimateFare(vehicleType, distanceKm) {
    const cfg = FARE_TABLE[vehicleType] || FARE_TABLE.Mini;
    const minutes = Math.max(3, distanceKm * 5);
    return Math.round(cfg.base + distanceKm * cfg.per_km + minutes * cfg.per_min);
  }

  function vehicleLabel(type) {
    return `${type} · ${FARE_TABLE[type]?.seats ?? 4} seats`;
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
      " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  }

  function toast(msg, ms) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms || 2600);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function STATUS_LABEL(s) {
    return ({
      requesting: "Requesting",
      assigned: "Driver assigned",
      driver_arriving: "Driver on the way",
      arrived: "Driver arrived",
      in_transit: "On the way to destination",
      completed: "Completed",
      cancelled: "Cancelled",
    })[s] || s;
  }

  global.U = {
    ngn, km, mins, haversine, routeDistance, estimateFare, vehicleLabel,
    fmtTime, fmtDate, toast, escapeHtml, uid, FARE_TABLE, PROMOS,
    applyPromo, fareBreakdown, STATUS_LABEL,
  };
})(window);
