/* iSafedrive — Driver app */
(function (global) {
  const U = global.U;
  const MK = global.MapKit;
  const api = global.api;
  const L = global.L;

  const D = {
    map: null,
    selfMarker: null,
    driver: null,       // driver record from me()
    online: false,
    activeRide: null,
    currentRequest: null,
    pollTimer: null,
    moveTimer: null,
    meTimer: null,
    pos: null,          // {lat, lng} current simulated position
    base: null,
  };

  function el(id) { return document.getElementById(id); }

  let _audioCtx = null;
  function playChime() {
    try {
      _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _audioCtx;
      if (ctx.state === "suspended") ctx.resume();
      [880, 1174.66].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t);
        o.stop(t + 0.18);
      });
    } catch (e) { /* audio unavailable */ }
  }

  function init() {
    D.map = MK.createMap(el("drv-map"));
    el("btn-drv-locate").onclick = () => { if (D.pos) D.map.setView([D.pos.lat, D.pos.lng], 15); };
    el("btn-go-online").onclick = toggleOnline;
    el("btn-drv-accept").onclick = acceptRequest;
    el("btn-drv-decline").onclick = declineRequest;
    el("btn-drv-status").onclick = advanceTrip;
    el("btn-drv-cancel-trip").onclick = () => cancelTrip();
    el("btn-drv-pay-confirm").onclick = confirmPayment;
    document.querySelectorAll("#driver-app .bt-tab").forEach((t) => {
      t.onclick = () => drvTab(t.dataset.tab);
    });
    loadDriver();
  }

  async function loadDriver() {
    try {
      const me = await api.me();
      D.driver = me.driver;
      D.online = !!D.driver.online;
      D.pos = { lat: D.driver.lat, lng: D.driver.lng };
      D.base = { lat: D.driver.lat, lng: D.driver.lng };
      renderSelf();
      applyOnlineUI();
      startWatchers();
    } catch (e) {
      U.toast("Could not load driver profile");
    }
  }

  function renderSelf() {
    if (!D.pos) return;
    if (!D.selfMarker) {
      D.selfMarker = L.marker([D.pos.lat, D.pos.lng], { icon: MK.driverIcon(D.online ? "available" : "offline"), zIndexOffset: 1000 }).addTo(D.map);
    } else {
      D.selfMarker.setLatLng([D.pos.lat, D.pos.lng]);
    }
    if (D.map.getZoom() < 12) D.map.setView([D.pos.lat, D.pos.lng], 13);
  }

  function applyOnlineUI() {
    const pill = el("drv-online-pill");
    pill.classList.toggle("online", D.online);
    pill.innerHTML = `<span class="pdot"></span> ${D.online ? "Online — accepting rides" : "Offline"}`;
    const btn = el("btn-go-online");
    btn.textContent = D.online ? "Go Offline" : "Go Online";
    btn.classList.toggle("offline", D.online);
    el("drv-idle-card").classList.toggle("hidden", D.online);
    el("drv-request").classList.add("hidden");
    D.currentRequest = null;
  }

  async function toggleOnline() {
    try {
      const drv = await api.toggleDriver(!D.online);
      D.driver = drv;
      D.online = !!drv.online;
      applyOnlineUI();
      renderSelf();
      U.toast(D.online ? "You're online" : "You're offline");
      if (D.online) pollRequests();
      refreshEarnings();
    } catch (e) {
      U.toast(e.error || "Could not change status");
    }
  }

  async function refreshEarnings() {
    try {
      const e = await api.driverEarnings();
      el("drv-idle-earnings").textContent =
        D.online ? `Today: ${U.ngn(e.today_revenue)} · ${e.today_rides} ride(s)` : `Lifetime: ${U.ngn(e.total_earned)} · ${e.trips} trips`;
    } catch (err) { /* ignore */ }
  }

  function startWatchers() {
    clearInterval(D.pollTimer);
    clearInterval(D.moveTimer);
    clearInterval(D.meTimer);

    D.pollTimer = setInterval(() => { if (D.online) pollRequests(); }, 3000);
    D.moveTimer = setInterval(moveTick, 2000);
    D.meTimer = setInterval(async () => {
      try {
        const me = await api.me();
        if (me.driver) {
          D.driver = me.driver;
          D.online = !!me.driver.online;
          D.pos = { lat: me.driver.lat, lng: me.driver.lng };
          renderSelf();
          if (!D.activeRide && D.driver.status === "busy") checkActiveFromServer();
        }
      } catch (e) { /* ignore */ }
    }, 3000);
    setInterval(refreshEarnings, 30000);
  }

  // If a ride was already assigned to this driver (e.g. passenger app or
  // another tab), pick it up.
  async function checkActiveFromServer() {
    try {
      const rides = await api.listRides();
      const active = rides.find((r) => ["assigned", "driver_arriving", "arrived", "in_transit"].includes(r.status));
      if (active) { D.activeRide = active; enterActiveTrip(); }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------
  async function pollRequests() {
    if (D.activeRide) return;
    if (D.currentRequest) return;
    try {
      const pending = await api.pendingRides(D.pos.lat, D.pos.lng, 8);
      if (pending.length) {
        D.currentRequest = pending[0];
        renderRequest(D.currentRequest);
        playChime();
      }
    } catch (e) { /* ignore */ }
  }

  function renderRequest(r) {
    el("drv-req-pickup").textContent = r.pickup_address || "Pickup location";
    el("drv-req-dropoff").textContent = r.dropoff_address || "Destination";
    el("drv-req-pax").textContent = r.passenger_name || "Passenger";
    el("drv-req-dist").textContent = `${U.km(r.distance_to_pickup_km)} to pickup · ${U.km(r.distance_km)} trip`;
    el("drv-req-fare").textContent = U.ngn(r.fare);
    el("drv-req-pay").textContent =
      r.payment_method === "card" ? "💳 Card" : r.payment_method === "transfer" ? "🏦 Transfer" : "💵 Cash";
    el("drv-request").classList.remove("hidden");
    // draw the request route on the map
    MK.clearLayer(D.map);
    renderSelf();
    MK.polylines(D.map, [
      { lat: r.pickup_lat, lng: r.pickup_lng },
      { lat: r.dropoff_lat, lng: r.dropoff_lng },
    ], "#1a7dff");
    MK.fitAll(D.map, [D.pos, { lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng }]);
  }

  async function acceptRequest() {
    if (!D.currentRequest) return;
    const id = D.currentRequest.id;
    try {
      const ride = await api.acceptRide(id);
      D.currentRequest = null;
      D.activeRide = ride;
      el("drv-request").classList.add("hidden");
      enterActiveTrip();
      U.toast("Ride accepted!");
    } catch (e) {
      U.toast(e.error || "Could not accept ride");
      D.currentRequest = null;
      el("drv-request").classList.add("hidden");
    }
  }

  async function declineRequest() {
    if (!D.currentRequest) return;
    const id = D.currentRequest.id;
    try { await api.declineRide(id); } catch (e) { /* ignore */ }
    D.currentRequest = null;
    el("drv-request").classList.add("hidden");
  }

  // ---------------------------------------------------------------
  function enterActiveTrip() {
    el("drv-idle-card").classList.add("hidden");
    el("drv-request").classList.add("hidden");
    el("drv-active").classList.remove("hidden");
    renderActive();
  }

  function rideTarget() {
    const r = D.activeRide;
    if (!r) return null;
    if (r.status === "in_transit") return { lat: r.dropoff_lat, lng: r.dropoff_lng };
    return { lat: r.pickup_lat, lng: r.pickup_lng };
  }

  function moveTick() {
    if (!D.activeRide || !D.pos) return;
    const target = rideTarget();
    if (!target) return;
    const dist = U.haversine(D.pos, target);
    if (dist > 0.06) {
      const f = 0.00075 / Math.max(dist, 0.00075);
      D.pos.lat += (target.lat - D.pos.lat) * f;
      D.pos.lng += (target.lng - D.pos.lng) * f;
    }
    renderSelf();
    if (api.serverMode()) {
      api.http("PUT", "/api/driver/location", { lat: D.pos.lat, lng: D.pos.lng }).catch(() => {});
    }
    renderActive();
  }

  async function advanceTrip() {
    if (!D.activeRide) return;
    const r = D.activeRide;
    try {
      if (r.status === "in_transit") {
        const done = await api.completeRide(r.id);
        D.activeRide = done;
        U.toast("Trip completed! +" + U.ngn(r.fare));
        renderActive();
      } else if (r.status === "arrived") {
        const ride = await api.updateRideStatus(r.id, "in_transit");
        D.activeRide = ride;
        U.toast("Trip started — drive safely!");
      } else {
        const ride = await api.updateRideStatus(r.id, "arrived");
        D.activeRide = ride;
        U.toast("Marked as arrived at pickup");
      }
      renderActive();
    } catch (e) {
      U.toast(e.error || "Action failed");
    }
  }

  async function cancelTrip() {
    if (!D.activeRide) return;
    try {
      await api.cancelRide(D.activeRide.id, "Driver cancelled");
      U.toast("Trip cancelled");
      endTrip();
    } catch (e) { U.toast(e.error || "Could not cancel"); }
  }

  function renderActive() {
    const r = D.activeRide;
    if (!r) return;
    const d = r.driver || {};
    el("drv-active-pickup").textContent = r.pickup_address || "Pickup";
    el("drv-active-dropoff").textContent = r.dropoff_address || "Destination";
    el("drv-active-fare").textContent = U.ngn(r.fare);

    const target = rideTarget();
    const dist = target ? U.haversine(D.pos, target) : 0;
    const statusMap = {
      assigned: ["Heading to pickup", `Driver ${U.escapeHtml(d.name || "")} · ${d.vehicle_type || ""}`],
      driver_arriving: ["Heading to pickup", `${U.km(dist)} away · ${d.vehicle_type || ""}`],
      arrived: ["Waiting at pickup", "Passenger ${passenger} is on the way"],
      in_transit: ["On the way to destination", `${U.km(dist)} remaining`],
      completed: ["Trip completed", "Collect payment to finish"],
      cancelled: ["Trip cancelled", "This ride was cancelled"],
    };
    const [title, sub] = statusMap[r.status] || ["Active trip", ""];
    el("drv-active-status").textContent = title;
    el("drv-active-sub").textContent = sub.includes("${passenger}") ? sub.replace("${passenger}", "your passenger") : sub;

    const btn = el("btn-drv-status");
    btn.textContent = r.status === "in_transit" ? "Complete trip" : r.status === "arrived" ? "Start trip" : "Arrived at pickup";

    renderPaymentUI(r);

    // map
    MK.clearLayer(D.map);
    renderSelf();
    const pts = [{ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng }];
    MK.polylines(D.map, pts, "#1a7dff");
    L.marker([r.pickup_lat, r.pickup_lng], { icon: MK.dropIcon("A") }).addTo(D.map);
    L.marker([r.dropoff_lat, r.dropoff_lng], { icon: MK.dropIcon("B") }).addTo(D.map);
    MK.fitAll(D.map, [D.pos, ...pts]);
  }

  function renderPaymentUI(r) {
    const box = el("drv-pay");
    const info = el("drv-pay-info");
    const confirmBtn = el("btn-drv-pay-confirm");
    const methodLabel = r.payment_method === "card" ? "💳 Card"
      : r.payment_method === "transfer" ? "🏦 Bank transfer" : "💵 Cash";

    if (r.status === "completed") {
      const how = r.payment_method === "card" ? "paid by card"
        : r.payment_method === "transfer" ? "paid by bank transfer" : "to collect in cash";
      info.innerHTML = `<b>${U.ngn(r.fare)}</b> fare — passenger ${how}.<br><small class="muted">Confirm to mark this payment as received and finish the trip.</small>`;
      confirmBtn.classList.remove("hidden");
      el("btn-drv-status").classList.add("hidden");
      el("btn-drv-cancel-trip").classList.add("hidden");
      box.classList.remove("hidden");
      return;
    }

    confirmBtn.classList.add("hidden");
    el("btn-drv-status").classList.remove("hidden");
    el("btn-drv-cancel-trip").classList.remove("hidden");
    if (r.status === "cancelled") { box.classList.add("hidden"); return; }
    info.textContent = `${methodLabel} · ${U.ngn(r.fare)} fare`;
    box.classList.remove("hidden");
  }

  function confirmPayment() {
    if (!D.activeRide) return;
    const r = D.activeRide;
    if (r.status !== "completed") return;
    U.toast("Payment confirmed — safe travels!");
    refreshEarnings();
    endTrip();
  }

  function endTrip() {
    D.activeRide = null;
    el("drv-active").classList.add("hidden");
    el("drv-idle-card").classList.toggle("hidden", D.online);
    MK.clearLayer(D.map);
    renderSelf();
  }

  // ---------------------------------------------------------------
  function drvTab(tab) {
    document.querySelectorAll("#driver-app .bt-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    const home = tab === "home";
    el("drv-map-wrap").classList.toggle("hidden", !home);
    el("drv-earnings-view").classList.toggle("hidden", tab !== "earnings");
    el("drv-trips-view").classList.toggle("hidden", tab !== "trips");
    el("drv-profile-view").classList.toggle("hidden", tab !== "profile");
    if (home) {
      setTimeout(() => D.map?.invalidateSize(), 150);
    } else if (tab === "earnings") renderEarnings();
    else if (tab === "trips") renderTrips();
    else if (tab === "profile") renderProfile();
  }

  async function renderEarnings() {
    const wrap = el("drv-earnings-view");
    wrap.innerHTML = `<div class="list-head"><button class="back" onclick="Drv.drvTab('home')">←</button><h2>Earnings</h2></div>`;
    try {
      const e = await api.driverEarnings();
      wrap.innerHTML += `<div class="stat-grid">
        <div class="stat-box"><div class="sv">${U.ngn(e.today_revenue)}</div><div class="sl">Today</div></div>
        <div class="stat-box"><div class="sv">${e.today_rides}</div><div class="sl">Rides today</div></div>
        <div class="stat-box"><div class="sv">${U.ngn(e.total_earned)}</div><div class="sl">Total earned</div></div>
      </div><div class="stat-grid">
        <div class="stat-box"><div class="sv">${e.trips}</div><div class="sl">Total trips</div></div>
        <div class="stat-box"><div class="sv">${(e.avg_rating || 0).toFixed(2)}</div><div class="sl">Rating</div></div>
        <div class="stat-box"><div class="sv">${e.total}</div><div class="sl">All rides</div></div>
      </div>`;
    } catch (err) { wrap.innerHTML += `<p class="muted">Could not load earnings.</p>`; }
  }

  async function renderTrips() {
    const wrap = el("drv-trips-view");
    wrap.innerHTML = `<div class="list-head"><button class="back" onclick="Drv.drvTab('home')">←</button><h2>My Trips</h2></div>`;
    try {
      const rides = await api.listRides();
      if (!rides.length) { wrap.innerHTML += `<p class="muted">No trips yet. Go online to start earning!</p>`; return; }
      rides.forEach((r) => {
        const st = r.status === "completed" ? "st-completed" : r.status === "cancelled" ? "st-cancelled" : "st-active";
        wrap.innerHTML += `<div class="ride-card">
          <div class="rc-top"><strong>${r.vehicle_type} · ${U.fmtDate(r.created_at)}</strong>
            <span class="rc-status ${st}">${U.STATUS_LABEL(r.status)}</span></div>
          <div class="rc-addr"><span class="req-pin pin-a">A</span><b>${U.escapeHtml(r.pickup_address || "Pickup")}</b></div>
          <div class="rc-addr"><span class="req-pin pin-b">B</span><b>${U.escapeHtml(r.dropoff_address || "Dropoff")}</b></div>
          <div class="rc-meta"><span>${U.km(r.distance_km)}</span><span class="rc-fare">${U.ngn(r.fare)}</span>
            ${r.rating ? `<span>★ ${r.rating}</span>` : ""}</div>
        </div>`;
      });
    } catch (e) { wrap.innerHTML += `<p class="muted">Could not load trips.</p>`; }
  }

  function renderProfile() {
    const s = api.loadSession();
    const d = D.driver || {};
    const wrap = el("drv-profile-view");
    wrap.innerHTML = `<div class="list-head"><button class="back" onclick="Drv.drvTab('home')">←</button><h2>Profile</h2></div>
      <div class="profile-card">
        <div class="profile-avatar">${U.escapeHtml((s?.name || "?").charAt(0))}</div>
        <h2>${U.escapeHtml(s?.name || "")}</h2>
        <p>${U.escapeHtml(s?.phone || "")}</p>
        <p>${d.vehicle_type || ""} · ${U.escapeHtml(d.vehicle_reg || "")}</p>
      </div>
      <div class="profile-row"><span>Rating</span><strong>★ ${(d.rating || 5).toFixed(1)}</strong></div>
      <div class="profile-row"><span>Total trips</span><strong>${d.trips || 0}</strong></div>
      <div class="profile-row"><span>Account status</span><strong>${d.approved ? "Approved" : "Pending review"}</strong></div>`;
  }

  global.Drv = { init, drvTab };
})(window);
