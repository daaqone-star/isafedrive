/* iSafedrive — Admin dashboard */
(function (global) {
  const U = global.U;
  const MK = global.MapKit;
  const api = global.api;
  const L = global.L;

  const A = {
    map: null,
    mapLayer: null,
    section: "dashboard",
    refreshTimer: null,
    ridesFilter: "all",
    ridesSearch: "",
    driversSearch: "",
    usersSearch: "",
  };

  function el(id) { return document.getElementById(id); }
  function show(elId) { el(elId).classList.remove("hidden"); }
  function hide(elId) { el(elId).classList.add("hidden"); }

  const PAY_LABEL = { cash: "💵 Cash", card: "💳 Card", transfer: "🏦 Transfer" };
  const PAY_METHOD = (m) => PAY_LABEL[m] || m || "—";

  function init() {
    document.querySelectorAll(".admin-nav").forEach((n) => {
      n.onclick = () => switchSection(n.dataset.admin);
    });
    el("btn-ad-close").onclick = () => hide("admin-detail");
    switchSection("dashboard");
    setInterval(refreshCurrent, 8000);
  }

  function switchSection(name) {
    A.section = name;
    document.querySelectorAll(".admin-nav").forEach((n) => n.classList.toggle("active", n.dataset.admin === name));
    ["dashboard", "livemap", "rides", "drivers", "users", "analytics"].forEach((s) => {
      el("admin-" + s).classList.toggle("hidden", s !== name);
    });
    if (name === "dashboard") renderDashboard();
    else if (name === "livemap") initLiveMap();
    else if (name === "rides") renderRides();
    else if (name === "drivers") renderDrivers();
    else if (name === "users") renderUsers();
    else if (name === "analytics") renderAnalytics();
  }

  function refreshCurrent() {
    if (A.section === "dashboard") renderDashboard(false);
    else if (A.section === "livemap") refreshLiveMap();
    else if (A.section === "rides") renderRides(false);
    else if (A.section === "drivers") renderDrivers(false);
    else if (A.section === "users") renderUsers(false);
    else if (A.section === "analytics") renderAnalytics(false);
  }

  function toolbar(updatedAt) {
    const t = updatedAt ? `<span class="muted" style="font-size:12px">Updated ${updatedAt}</span>` : "";
    return `<div class="admin-toolbar">
      ${t}
      <button class="tool-btn" onclick="Adm.refresh()">↻ Refresh</button>
    </div>`;
  }

  function emptyState(ico, title, sub) {
    return `<div class="empty-state"><span class="es-ico">${ico}</span><b>${title}</b><p>${sub}</p></div>`;
  }

  // ---------------------------------------------------------------
  async function renderDashboard(showLoading = true) {
    const wrap = el("admin-dashboard");
    if (showLoading) wrap.innerHTML = `<h2>Dashboard</h2><p class="sub">Loading…</p>`;
    try {
      const [stats, rides, analytics, drivers] = await Promise.all([
        api.adminStats(), api.adminRides(), api.adminAnalytics(), api.adminDrivers(),
      ]);
      const active = ["requesting", "assigned", "driver_arriving", "arrived", "in_transit"];
      const recent = rides.slice(0, 8);
      const updated = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const pending = drivers.filter((d) => !d.approved).length;
      const online = drivers.filter((d) => d.online).length;
      const top = (analytics.top_drivers || []).filter((d) => d.rides > 0);
      const statHtml = `
        ${statCard("🚗", stats.completed_rides, "Completed rides")}
        ${statCard("📅", stats.today_rides, "Rides today")}
        ${statCard("🟢", online, "Drivers online")}
        ${statCard("🧑‍✈️", stats.total_drivers, "Total drivers")}
        ${statCard("👥", stats.total_users, "Passengers")}
        ${statCard("⚡", stats.active_rides, "Active rides")}
        ${statCard("🚫", stats.cancelled_rides, "Cancelled")}
        ${statCard("💰", U.ngn(stats.revenue), "Total revenue")}
        ${statCard("💵", U.ngn(stats.today_revenue), "Revenue today")}
      `;
      const callout = pending > 0
        ? `<div class="callout"><span class="co-ico">⏳</span>
            <div><b>${pending} driver${pending > 1 ? "s" : ""} pending approval</b>
            <div class="muted" style="font-size:12px">Approve them so they can start accepting rides.</div></div>
            <a class="co-go" href="javascript:Adm.switchSection('drivers')">Review →</a></div>`
        : "";
      wrap.innerHTML = `
        <h2>Dashboard</h2>
        <p class="sub">iSafedrive control centre — live overview</p>
        ${toolbar(updated)}
        ${callout}
        <div class="admin-stats">${statHtml}</div>
        <div class="a-grid">
          <div class="a-panel">
            <h4>Revenue — last 7 days</h4>
            ${barChart(analytics.by_day, "revenue", "rides")}
          </div>
          <div class="a-panel">
            <h4>Rides by vehicle type</h4>
            ${vehicleChart(analytics.by_vehicle)}
            <h4 style="margin-top:16px">Rides by status</h4>
            ${statusChart(analytics.by_status)}
          </div>
        </div>
        <div class="a-grid" style="margin-top:12px">
          <div class="a-panel">
            <h4>Recent rides</h4>
            <div class="table-wrap">${ridesTable(recent)}</div>
          </div>
          <div class="a-panel">
            <h4>Top drivers</h4>
            ${top.length
              ? top.map((d, i) => `<div class="tdrv-row">
                  <span class="tdrv-rank">${i + 1}</span>
                  <b>${U.escapeHtml(d.name)}</b>
                  <span>${d.rides} rides · ${U.ngn(d.revenue)}</span></div>`).join("")
              : `<p class="muted">No completed rides yet.</p>`}
          </div>
        </div>`;
    } catch (e) {
      wrap.innerHTML = `<h2>Dashboard</h2><p class="muted">Could not load data.</p>`;
    }
  }

  function statCard(ico, val, lbl) {
    return `<div class="a-stat"><div class="as-ico">${ico}</div>
      <div class="as-val">${val ?? "—"}</div><div class="as-lbl">${lbl}</div></div>`;
  }

  function barChart(days, key, subKey) {
    if (!days || !days.length) return `<p class="muted">No data yet.</p>`;
    const max = Math.max(...days.map((d) => d[key] || 0), 1);
    const html = days.map((d) => {
      const h = Math.round(((d[key] || 0) / max) * 100);
      const label = (d.day || "").slice(5) || d.day;
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)">
          <span>${label}</span><span>${U.ngn(d[key] || 0)}</span></div>
        <div class="bar"><div style="width:${h}%"></div></div>
      </div>`;
    }).join("");
    return html;
  }

  function vehicleChart(rows) {
    if (!rows || !rows.length) return `<p class="muted">No data yet.</p>`;
    const total = rows.reduce((s, r) => s + r.n, 0) || 1;
    return `<div class="legend-row">` + rows.map((r) => `
      <div style="flex:1;text-align:center">
        <strong style="font-size:15px">${r.n}</strong>
        <div style="font-size:11px">${r.v}</div>
        <div class="bar" style="margin-top:4px"><div style="width:${Math.round((r.n / total) * 100)}%"></div></div>
      </div>`).join("") + `</div>`;
  }

  function statusChart(rows) {
    if (!rows || !rows.length) return `<p class="muted">No data yet.</p>`;
    return `<div class="legend-row">` + rows.map((r) => `
      <span><span class="lg-dot" style="background:${stColor(r.s)}"></span>${U.STATUS_LABEL(r.s)}: <b>${r.n}</b></span>`).join("") + `</div>`;
  }

  function paymentChart(rows) {
    if (!rows || !rows.length) return `<p class="muted">No data yet.</p>`;
    return `<div class="legend-row">` + rows.map((r) => `
      <span>${PAY_METHOD(r.p)}: <b>${r.n}</b></span>`).join("") + `</div>`;
  }

  function stColor(s) {
    return ({ completed: "#1a7dff", cancelled: "#e0343d", in_transit: "#1a7dff", requesting: "#b57a00" })[s] || "#9aa1a9";
  }

  // ---------------------------------------------------------------
  function initLiveMap() {
    if (!A.map) {
      A.map = MK.createMap(el("admin-map"), [6.5244, 3.3792], 12);
      A.mapLayer = L.layerGroup().addTo(A.map);
    }
    setTimeout(() => A.map.invalidateSize(), 120);
    refreshLiveMap();
  }

  async function refreshLiveMap() {
    if (!A.map) return;
    try {
      const [drivers, rides] = await Promise.all([api.adminDrivers(), api.adminRides()]);
      A.mapLayer.clearLayers();
      drivers.forEach((d) => {
        if (!d.approved && !d.online) return;
        const st = d.online ? (d.status === "busy" ? "busy" : "available") : "offline";
        const m = L.marker([d.lat, d.lng], { icon: MK.driverIcon(st) }).addTo(A.mapLayer);
        m.bindPopup(`<b>${U.escapeHtml(d.name)}</b><br>${d.vehicle_type} · ${U.escapeHtml(d.vehicle_reg)}<br>
          ★ ${d.rating} · ${st}<br>${U.ngn(d.total_earned)} lifetime`);
      });
      const active = rides.filter((r) => ["assigned", "driver_arriving", "arrived", "in_transit"].includes(r.status));
      active.forEach((r) => {
        MK.polylines(A.mapLayer, [
          { lat: r.pickup_lat, lng: r.pickup_lng },
          { lat: r.dropoff_lat, lng: r.dropoff_lng },
        ], r.status === "in_transit" ? "#1a7dff" : "#b57a00");
        L.marker([r.pickup_lat, r.pickup_lng], { icon: MK.dropIcon("A") }).addTo(A.mapLayer);
        L.marker([r.dropoff_lat, r.dropoff_lng], { icon: MK.dropIcon("B") }).addTo(A.mapLayer);
      });
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------
  async function renderRides(showLoading = true) {
    const wrap = el("admin-rides");
    if (showLoading) wrap.innerHTML = `<h2>Rides</h2><p class="sub">Loading…</p>`;
    const filters = [
      ["all", "All"], ["active", "Active"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["requesting", "Requesting"],
    ];
    const current = A.ridesFilter || "all";
    try {
      const rides = await api.adminRides(current === "all" ? "" : current);
      const q = (A.ridesSearch || "").toLowerCase();
      const filtered = q ? rides.filter((r) =>
        String(r.id).includes(q) ||
        (r.passenger_name || "").toLowerCase().includes(q) ||
        (r.driver_name || "").toLowerCase().includes(q) ||
        (r.pickup_address || "").toLowerCase().includes(q) ||
        (r.dropoff_address || "").toLowerCase().includes(q) ||
        (r.promo_code || "").toLowerCase().includes(q)
      ) : rides;
      const totalFare = filtered.filter((r) => r.status === "completed").reduce((s, r) => s + (r.fare || 0), 0);
      wrap.innerHTML = `
        <h2>Rides</h2>
        <p class="sub">All ride requests across the platform${rides.length ? ` · ${rides.length} total` : ""}</p>
        <div class="filter-row">${filters.map(([v, lbl]) =>
          `<button class="f-btn ${v === current ? "active" : ""}" onclick="Adm.setRidesFilter('${v}')">${lbl}</button>`).join("")}</div>
        <div class="admin-toolbar">
          <input class="search" placeholder="Search by ID, passenger, driver, route or promo…" value="${A.ridesSearch || ""}" oninput="Adm.setRidesSearch(this.value)" />
          <button class="tool-btn" onclick="Adm.exportRides()">⬇ Export CSV</button>
        </div>
        ${filtered.length ? `<p class="muted" style="margin:0 0 10px">Showing ${filtered.length} rides · completed value <b>${U.ngn(totalFare)}</b></p>` : ""}
        <div class="table-wrap">${ridesTable(filtered)}</div>`;
    } catch (e) {
      wrap.innerHTML = `<h2>Rides</h2><p class="muted">Could not load rides.</p>`;
    }
  }

  function ridesTable(rides) {
    if (!rides.length) return emptyState("🚕", "No rides found", "When passengers book a ride it will appear here.");
    return `<table class="admin-table">
      <thead><tr>
        <th>ID</th><th>Passenger</th><th>Driver</th><th>Route</th>
        <th>Type</th><th>Fare</th><th>Promo</th><th>Payment</th><th>Status</th><th>When</th>
      </tr></thead><tbody>
      ${rides.map((r) => `<tr class="clickable" onclick="Adm.openRide(${r.id})">
        <td>#${r.id}</td>
        <td>${U.escapeHtml(r.passenger_name || "—")}</td>
        <td>${U.escapeHtml(r.driver_name || "—")}</td>
        <td style="max-width:220px;font-size:12px">${U.escapeHtml(r.pickup_address || "A")} → ${U.escapeHtml(r.dropoff_address || "B")}</td>
        <td>${r.vehicle_type}</td>
        <td><b>${U.ngn(r.fare)}</b>${r.discount ? `<br><small class="muted">−${U.ngn(r.discount)} ${r.promo_code || ""}</small>` : ""}</td>
        <td>${r.promo_code ? `<span class="tag busy">${r.promo_code}</span>` : "—"}</td>
        <td>${PAY_METHOD(r.payment_method)}</td>
        <td>${statusTag(r.status)}</td>
        <td>${U.fmtTime(r.created_at)}</td>
      </tr>`).join("")}
      </tbody></table>`;
  }

  async function openRide(id) {
    try {
      const r = await api.adminRide(id);
      if (!r) { U.toast("Ride not found"); return; }
      const finished = ["completed", "cancelled"].includes(r.status);
      const rows = [
        ["Status", statusTag(r.status)],
        ["Vehicle", r.vehicle_type],
        ["Distance", r.distance_km ? `${r.distance_km} km` : "—"],
        ["Duration", r.duration_min ? `${r.duration_min} min` : "—"],
        ["Fare", `<b>${U.ngn(r.fare)}</b>`],
        ["Discount", r.discount ? `−${U.ngn(r.discount)} (${r.promo_code || ""})` : "—"],
        ["Payment", PAY_METHOD(r.payment_method)],
        ["Passenger", `${U.escapeHtml(r.passenger_name || "—")} · ${U.escapeHtml(r.passenger_phone || "")}`],
        ["Driver", r.driver_name
          ? `${U.escapeHtml(r.driver_name)} · ${U.escapeHtml(r.driver_phone || "")} · ★ ${r.rating}` : "Not assigned yet"],
        ["Created", r.created_at],
      ];
      if (r.accepted_at) rows.push(["Accepted", r.accepted_at]);
      if (r.started_at) rows.push(["Started", r.started_at]);
      if (r.completed_at) rows.push(["Completed", r.completed_at]);
      if (r.cancelled_at) rows.push(["Cancelled", `${r.cancelled_at}${r.cancel_reason ? ` (${r.cancel_reason})` : ""}`]);
      if (r.rating) rows.push(["Rating", `★ ${r.rating}${r.comment ? ` — ${U.escapeHtml(r.comment)}` : ""}`]);
      el("ad-title").textContent = `Ride #${r.id} details`;
      el("ad-body").innerHTML = `
        <div class="detail-route">
          <div class="dr"><span class="req-pin pin-a">A</span><span>${U.escapeHtml(r.pickup_address || "Pickup")}</span></div>
          <div class="dr"><span class="req-pin pin-b">B</span><span>${U.escapeHtml(r.dropoff_address || "Dropoff")}</span></div>
        </div>
        <div class="detail-grid">${rows.map(([k, v]) =>
          `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>
        ${finished ? "" : `<button class="btn btn-ghost-danger btn-block" onclick="Adm.forceCancel(${r.id})">✕ Force cancel ride</button>`}`;
      show("admin-detail");
    } catch (e) {
      U.toast("Could not load ride details");
    }
  }

  async function forceCancel(id) {
    if (!confirm("Cancel this ride? The passenger and driver will be notified.")) return;
    try {
      await api.adminCancelRide(id);
      hide("admin-detail");
      U.toast("Ride cancelled by admin");
      refreshCurrent();
    } catch (e) {
      U.toast(e.error || "Cancel failed");
    }
  }

  function statusTag(s) {
    const map = {
      completed: ["st-completed", "Completed"], cancelled: ["st-cancelled", "Cancelled"],
      requesting: ["st-active", "Requesting"], assigned: ["st-active", "Assigned"],
      driver_arriving: ["st-active", "Arriving"], arrived: ["st-active", "Arrived"],
      in_transit: ["st-active", "In transit"],
    };
    const [cls, lbl] = map[s] || ["", s];
    return `<span class="tag ${cls === "st-completed" ? "on" : cls === "st-cancelled" ? "red" : "busy"}">${lbl}</span>`;
  }

  function exportRides() {
    api.adminRides(A.ridesFilter === "all" ? "" : A.ridesFilter).then((rides) => {
      const q = (A.ridesSearch || "").toLowerCase();
      const rows = q ? rides.filter((r) =>
        String(r.id).includes(q) ||
        (r.passenger_name || "").toLowerCase().includes(q) ||
        (r.driver_name || "").toLowerCase().includes(q)) : rides;
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [
        ["id", "passenger", "driver", "pickup", "dropoff", "vehicle", "fare", "discount", "promo", "payment", "status", "created_at"],
        ...rows.map((r) => [r.id, r.passenger_name, r.driver_name, r.pickup_address, r.dropoff_address,
          r.vehicle_type, r.fare, r.discount, r.promo_code, r.payment_method, r.status, r.created_at]),
      ];
      const csv = lines.map((l) => l.map(esc).join(",")).join("\r\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "isafedrive-rides.csv";
      a.click();
      URL.revokeObjectURL(a.href);
      U.toast("Rides exported to CSV");
    }).catch(() => U.toast("Export failed"));
  }

  // ---------------------------------------------------------------
  async function renderDrivers(showLoading = true) {
    const wrap = el("admin-drivers");
    if (showLoading) wrap.innerHTML = `<h2>Drivers</h2><p class="sub">Loading…</p>`;
    try {
      const drivers = await api.adminDrivers();
      const q = (A.driversSearch || "").toLowerCase();
      const filtered = q ? drivers.filter((d) =>
        (d.name || "").toLowerCase().includes(q) ||
        (d.phone || "").toLowerCase().includes(q) ||
        (d.vehicle_reg || "").toLowerCase().includes(q) ||
        (d.vehicle_type || "").toLowerCase().includes(q)
      ) : drivers;
      const approved = drivers.filter((d) => d.approved).length;
      const pending = drivers.length - approved;
      const online = drivers.filter((d) => d.online).length;
      wrap.innerHTML = `
        <h2>Drivers</h2>
        <p class="sub">${drivers.length} drivers registered</p>
        <div class="chips">
          <span class="chip on">Approved <b>${approved}</b></span>
          <span class="chip">Pending approval <b>${pending}</b></span>
          <span class="chip">Online now <b>${online}</b></span>
        </div>
        <div class="admin-toolbar">
          <input class="search" placeholder="Search drivers by name, phone, vehicle or plate…" value="${A.driversSearch || ""}" oninput="Adm.setDriversSearch(this.value)" />
        </div>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr>
            <th>Driver</th><th>Vehicle</th><th>Rating</th><th>Trips</th><th>Earned</th>
            <th>Status</th><th>Online</th><th>Actions</th>
          </tr></thead><tbody>
          ${filtered.length ? filtered.map((d) => `<tr>
            <td><b>${U.escapeHtml(d.name)}</b><br><small>${U.escapeHtml(d.phone)}</small></td>
            <td>${d.vehicle_type}<br><small>${U.escapeHtml(d.vehicle_reg)}</small></td>
            <td>★ ${d.rating}</td>
            <td>${d.trips}</td>
            <td>${U.ngn(d.total_earned)}</td>
            <td>${d.approved ? `<span class="tag on">Approved</span>` : `<span class="tag pending">Pending</span>`}</td>
            <td>${d.online ? `<span class="tag on">Online</span>` : `<span class="tag off">Offline</span>`}</td>
            <td>
              <button class="mini-btn approve" onclick="Adm.approveDriver(${d.id}, ${d.approved ? 0 : 1})">
                ${d.approved ? "Revoke" : "Approve"}</button>
              <button class="mini-btn ${d.approved ? "suspend" : "approve"}" onclick="Adm.suspendDriver(${d.id}, ${d.approved ? 1 : 0})">
                ${d.approved ? "Suspend" : "Restore"}</button>
              <button class="mini-btn approve" onclick="Adm.editDriver(${d.id},'${U.escapeHtml(d.name)}','${d.vehicle_type}','${U.escapeHtml(d.vehicle_reg)}')">Edit</button>
              <button class="mini-btn suspend" onclick="Adm.deleteDriver(${d.id})">Delete</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="8">${emptyState("🧑‍✈️", "No drivers found", "Register as a driver in the app and they will appear here for approval.")}</td></tr>`}
          </tbody></table></div>`;
    } catch (e) {
      wrap.innerHTML = `<h2>Drivers</h2><p class="muted">Could not load drivers.</p>`;
    }
  }

  // ---------------------------------------------------------------
  async function renderUsers(showLoading = true) {
    const wrap = el("admin-users");
    if (showLoading) wrap.innerHTML = `<h2>Users</h2><p class="sub">Loading…</p>`;
    try {
      const users = await api.adminUsers();
      const q = (A.usersSearch || "").toLowerCase();
      const filtered = q ? users.filter((u) =>
        (u.name || "").toLowerCase().includes(q) || (u.phone || "").toLowerCase().includes(q)
      ) : users;
      const riders = users.filter((u) => u.rides > 0).length;
      wrap.innerHTML = `
        <h2>Passengers</h2>
        <p class="sub">${users.length} registered passengers</p>
        <div class="chips">
          <span class="chip on">Total <b>${users.length}</b></span>
          <span class="chip">Have ridden <b>${riders}</b></span>
        </div>
        <div class="admin-toolbar">
          <input class="search" placeholder="Search passengers by name or phone…" value="${A.usersSearch || ""}" oninput="Adm.setUsersSearch(this.value)" />
        </div>
        <div class="table-wrap"><table class="admin-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Rides</th><th>Joined</th><th>Actions</th></tr></thead><tbody>
          ${filtered.length ? filtered.map((u) => `<tr>
            <td><b>${U.escapeHtml(u.name)}</b></td>
            <td>${U.escapeHtml(u.phone)}</td>
            <td>${u.rides}</td>
            <td>${U.fmtDate(u.created_at)}</td>
            <td>
              <button class="mini-btn approve" onclick="Adm.editUser(${u.id},'${U.escapeHtml(u.name)}','${U.escapeHtml(u.phone)}')">Edit</button>
              <button class="mini-btn suspend" onclick="Adm.deleteUser(${u.id})">Delete</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="5">${emptyState("👥", "No passengers found", "When passengers register they will appear here.")}</td></tr>`}
          </tbody></table></div>`;
    } catch (e) {
      wrap.innerHTML = `<h2>Users</h2><p class="muted">Could not load users.</p>`;
    }
  }

  // ---------------------------------------------------------------
  async function renderAnalytics(showLoading = true) {
    const wrap = el("admin-analytics");
    if (showLoading) wrap.innerHTML = `<h2>Analytics</h2><p class="sub">Loading…</p>`;
    try {
      const a = await api.adminAnalytics();
      const days = a.by_day || [];
      const maxRides = Math.max(...days.map((d) => d.rides), 1);
      const totalRides = days.reduce((s, d) => s + d.rides, 0);
      const totalRev = days.reduce((s, d) => s + d.revenue, 0);
      wrap.innerHTML = `
        <h2>Analytics</h2>
        <p class="sub">Platform usage over time</p>
        ${toolbar()}
        <div class="chips">
          <span class="chip on">Rides (7d) <b>${totalRides}</b></span>
          <span class="chip">Revenue (7d) <b>${U.ngn(totalRev)}</b></span>
        </div>
        <div class="a-grid">
          <div class="a-panel"><h4>Rides per day (last 7)</h4>
            ${days.length ? days.map((d) => {
              const h = Math.round((d.rides / maxRides) * 100);
              return `<div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)">
                  <span>${d.day}</span><span>${d.rides} rides · ${U.ngn(d.revenue)}</span></div>
                <div class="bar"><div style="width:${h}%"></div></div></div>`;
            }).join("") : `<p class="muted">No data yet.</p>`}
          </div>
          <div class="a-panel"><h4>Vehicle mix</h4>${vehicleChart(a.by_vehicle)}
            <h4 style="margin-top:16px">Status mix</h4>${statusChart(a.by_status)}
            <h4 style="margin-top:16px">Payment mix</h4>${paymentChart(a.payment_mix)}</div>
        </div>`;
    } catch (e) {
      wrap.innerHTML = `<h2>Analytics</h2><p class="muted">Could not load analytics.</p>`;
    }
  }

  global.Adm = {
    init,
    switchSection,
    refresh: refreshCurrent,
    approveDriver: async (id, approved) => {
      await api.adminApproveDriver(id, approved);
      U.toast(approved ? "Driver approved" : "Approval revoked");
      renderDrivers(false);
    },
    suspendDriver: async (id, suspend) => {
      await api.adminSuspendDriver(id, suspend);
      U.toast(suspend ? "Driver suspended" : "Driver restored");
      renderDrivers(false);
    },
    editUser: async (id, currentName, currentPhone) => {
      const name = prompt("Edit name:", currentName);
      if (name === null) return;
      const phone = prompt("Edit phone:", currentPhone);
      if (phone === null) return;
      try {
        await api.adminEditUser(id, { name, phone });
        U.toast("User updated");
        renderUsers(false);
      } catch (e) { U.toast(e.error || "Update failed"); }
    },
    deleteUser: async (id) => {
      if (!confirm("Delete this passenger? This cannot be undone.")) return;
      try {
        await api.adminDeleteUser(id);
        U.toast("User deleted");
        renderUsers(false);
      } catch (e) { U.toast(e.error || "Delete failed"); }
    },
    editDriver: async (id, currentName, currentType, currentReg) => {
      const name = prompt("Edit driver name:", currentName);
      if (name === null) return;
      const vehicle_type = prompt("Edit vehicle type:", currentType);
      if (vehicle_type === null) return;
      const vehicle_reg = prompt("Edit vehicle plate:", currentReg);
      if (vehicle_reg === null) return;
      try {
        await api.adminEditDriver(id, { name, vehicle_type, vehicle_reg });
        U.toast("Driver updated");
        renderDrivers(false);
      } catch (e) { U.toast(e.error || "Update failed"); }
    },
    deleteDriver: async (id) => {
      if (!confirm("Delete this driver? They will be demoted to passenger. This cannot be undone.")) return;
      try {
        await api.adminDeleteDriver(id);
        U.toast("Driver deleted");
        renderDrivers(false);
      } catch (e) { U.toast(e.error || "Delete failed"); }
    },
    setRidesFilter: (f) => { A.ridesFilter = f; renderRides(false); },
    setRidesSearch: (v) => { A.ridesSearch = v; renderRides(false); },
    setDriversSearch: (v) => { A.driversSearch = v; renderDrivers(false); },
    setUsersSearch: (v) => { A.usersSearch = v; renderUsers(false); },
    openRide,
    forceCancel,
    exportRides,
  };
})(window);
