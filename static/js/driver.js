/* iSafedrive — Driver app */
(function (global) {
  const U = global.U;
  const MK = global.MapKit;
  const api = global.api;
  const L = global.L;

  const D = {
    map: null,
    selfMarker: null,
    driver: null,
    online: false,
    activeRide: null,
    currentRequest: null,
    pollTimer: null,
    meTimer: null,
    pos: null,
    base: null,
    tripCode: null,
    geoWatchId: null,
    _inited: false,
    _gpsReady: false,
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

  function notify(title, body) {
    if (window.App && typeof window.App.notify === "function") {
      window.App.notify(title, body);
    }
  }

  function sendLocationToServer() {
    if (D.pos && api.serverMode()) {
      api.http("PUT", "/api/driver/location", { lat: D.pos.lat, lng: D.pos.lng }).catch(() => {});
    }
  }

  function init() {
    if (D._inited) {
      setTimeout(() => D.map?.invalidateSize(), 200);
      return;
    }
    D._inited = true;

    // Create map centered on user's last known position (or default)
    D.map = MK.createMap(el("drv-map"), [6.5244, 3.3792], 14);
    setTimeout(() => D.map?.invalidateSize(), 400);
    setTimeout(() => D.map?.invalidateSize(), 1200);

    el("btn-drv-locate").onclick = () => {
      if (D.pos) D.map.setView([D.pos.lat, D.pos.lng], 15);
      else useGeolocation();
    };
    el("btn-go-online").onclick = toggleOnline;
    el("btn-drv-accept").onclick = acceptRequest;
    el("btn-drv-decline").onclick = declineRequest;
    el("btn-drv-arrived").onclick = () => advanceTrip("arrived");
    el("btn-drv-start-ride").onclick = () => advanceTrip("in_transit");
    el("btn-drv-complete").onclick = () => advanceTrip("complete");
    el("btn-drv-cancel-trip").onclick = () => cancelTrip();
    el("btn-drv-pay-confirm").onclick = confirmPayment;
    document.querySelectorAll("#driver-app .bt-tab").forEach((t) => {
      t.onclick = () => drvTab(t.dataset.tab);
    });

    // Location search for driver
    setupDriverLocationSearch();

    // Step 1: Get GPS FIRST, then load driver profile
    getGPSFirst();
  }

  // ---------------------------------------------------------------
  // Get GPS position before loading driver data from server
  // ---------------------------------------------------------------
  function getGPSFirst() {
    if (!navigator.geolocation) {
      loadDriver();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        D.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        D.base = { ...D.pos };
        D._gpsReady = true;
        // Send GPS to server BEFORE loading driver profile
        sendLocationToServer();
        // Now load driver data (which will use the GPS-updated position)
        loadDriver();
      },
      () => {
        // GPS failed — load driver with whatever position is in the DB
        loadDriver();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function loadDriver() {
    try {
      const me = await api.me();
      D.driver = me.driver;

      // If GPS gave us a real position, use that instead of the DB position
      if (D._gpsReady && D.pos) {
        D.base = { lat: D.pos.lat, lng: D.pos.lng };
        // Update the DB position with real GPS
        sendLocationToServer();
      } else {
        // Use DB position as fallback
        D.pos = { lat: D.driver.lat, lng: D.driver.lng };
        D.base = { lat: D.driver.lat, lng: D.driver.lng };
      }

      D.online = !!D.driver.online;
      renderSelf();
      applyOnlineUI();
      startWatchers();
      startGPSWatch();
    } catch (e) {
      U.toast("Could not load driver profile");
    }
  }

  function startGPSWatch() {
    if (!navigator.geolocation) return;
    if (D.geoWatchId) navigator.geolocation.clearWatch(D.geoWatchId);
    D.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        D.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        D.base = { ...D.pos };
        renderSelf();
        sendLocationToServer();
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  function useGeolocation() {
    if (!navigator.geolocation) {
      U.toast("Location unavailable");
      return;
    }
    U.toast("Detecting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        D.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        D.base = { ...D.pos };
        renderSelf();
        sendLocationToServer();
        D.map.setView([D.pos.lat, D.pos.lng], 15);
        U.toast("📍 Location updated");
      },
      () => { U.toast("Could not detect location"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // ---------------------------------------------------------------
  // Driver location search
  // ---------------------------------------------------------------
  function setupDriverLocationSearch() {
    const input = el("drv-location-input");
    const results = el("drv-location-results");
    if (!input || !results) return;

    let debounce = null;

    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) { results.classList.add("hidden"); return; }
      debounce = setTimeout(() => searchDriverLocation(q), 350);
    });

    input.addEventListener("focus", () => {
      if (results.children.length > 0 && input.value.trim().length >= 3) {
        results.classList.remove("hidden");
      }
    });

    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.classList.add("hidden");
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        results.classList.add("hidden");
        const q = input.value.trim();
        if (!q) return;
        geocodeDriverQuery(q);
      }
    });
  }

  async function searchDriverLocation(query) {
    const results = el("drv-location-results");
    if (!results) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5`,
        { headers: { "User-Agent": "iSafedriveApp/1.0" } }
      );
      const data = await res.json();
      if (!data.length) {
        results.innerHTML = `<div class="sr-item"><span class="sr-name">No results</span></div>`;
        results.classList.remove("hidden");
        return;
      }
      results.innerHTML = data.map((r, i) => {
        const parts = (r.display_name || "").split(",");
        const name = parts[0] || query;
        const addr = parts.slice(1, 4).join(",").trim();
        return `<div class="sr-item" data-idx="${i}">
          <div class="sr-name">${U.escapeHtml(name)}</div>
          <div class="sr-addr">${U.escapeHtml(addr)}</div>
        </div>`;
      }).join("");
      results.classList.remove("hidden");

      results.querySelectorAll(".sr-item").forEach((item) => {
        item.onclick = () => {
          const idx = parseInt(item.dataset.idx);
          const r = data[idx];
          if (!r) return;
          D.pos = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
          D.base = { ...D.pos };
          renderSelf();
          sendLocationToServer();
          D.map.setView([D.pos.lat, D.pos.lng], 15);
          const name = (r.display_name || "").split(",")[0].trim();
          el("drv-location-input").value = name;
          results.classList.add("hidden");
          U.toast("📍 Location set: " + name);
        };
      });
    } catch (e) {
      results.innerHTML = `<div class="sr-item"><span class="sr-name">Search failed</span></div>`;
      results.classList.remove("hidden");
    }
  }

  async function geocodeDriverQuery(query) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=1`,
        { headers: { "User-Agent": "iSafedriveApp/1.0" } }
      );
      const data = await res.json();
      if (data.length) {
        D.pos = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        D.base = { ...D.pos };
        renderSelf();
        sendLocationToServer();
        D.map.setView([D.pos.lat, D.pos.lng], 15);
        U.toast("📍 Location set: " + query);
      } else {
        U.toast("Location not found");
      }
    } catch (e) {
      U.toast("Could not find location");
    }
  }

  // ---------------------------------------------------------------
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
    // Make sure server has our GPS position before toggling
    sendLocationToServer();
    try {
      const drv = await api.toggleDriver(!D.online);
      D.driver = drv;
      D.online = !!drv.online;
      applyOnlineUI();
      renderSelf();
      U.toast(D.online ? "You're online" : "You're offline");
      if (D.online) {
        pollRequests();
      } else {
        clearInterval(D.pollTimer);
      }
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
    clearInterval(D.meTimer);

    // Poll for ride requests every 2 seconds when online
    D.pollTimer = setInterval(() => {
      if (D.online && !D.activeRide) pollRequests();
      if (D.online) sendLocationToServer();
    }, 2000);

    // Refresh driver state from server
    D.meTimer = setInterval(async () => {
      try {
        const me = await api.me();
        if (me.driver) {
          D.driver = me.driver;
          D.online = !!me.driver.online;
          renderSelf();
          if (!D.activeRide && D.driver.status === "busy") checkActiveFromServer();
        }
      } catch (e) { /* ignore */ }
    }, 5000);
    setInterval(refreshEarnings, 30000);
  }

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
    if (!D.pos) return;
    try {
      const pending = await api.pendingRides(D.pos.lat, D.pos.lng, 15);
      if (pending.length) {
        D.currentRequest = pending[0];
        renderRequest(D.currentRequest);
        playChime();
        notify("🚗 New Ride Request!", `${pending[0].passenger_name || "Passenger"} needs a ride — ${U.ngn(pending[0].fare)} fare`);
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
      // Use server-generated trip code
      D.tripCode = ride.trip_code || null;
      el("drv-request").classList.add("hidden");
      enterActiveTrip();
      notify("Ride Accepted!", `Drive to pickup — Code: ${D.tripCode || "pending"}`);
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
    setTimeout(() => {
      D.map?.invalidateSize();
      const r = D.activeRide;
      if (r) {
        const pts = [D.pos, { lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng }];
        MK.fitAll(D.map, pts);
      }
    }, 200);
  }

  function rideTarget() {
    const r = D.activeRide;
    if (!r) return null;
    if (r.status === "in_transit") return { lat: r.dropoff_lat, lng: r.dropoff_lng };
    return { lat: r.pickup_lat, lng: r.pickup_lng };
  }

  async function advanceTrip(action) {
    if (!D.activeRide) return;
    const r = D.activeRide;
    try {
      if (action === "complete") {
        const done = await api.completeRide(r.id);
        D.activeRide = done;
        U.toast("Trip completed! +" + U.ngn(r.fare));
        notify("Trip Completed", `You earned ${U.ngn(r.fare)}`);
        renderActive();
      } else if (action === "in_transit") {
        const ride = await api.updateRideStatus(r.id, "in_transit");
        D.activeRide = ride;
        U.toast("Trip started — drive safely!");
        notify("Trip Started", "Passenger picked up. Drive safely!");
        renderActive();
      } else if (action === "arrived") {
        const ride = await api.updateRideStatus(r.id, "arrived");
        D.activeRide = ride;
        U.toast("Arrived at pickup — wait for passenger");
        notify("Arrived at Pickup", "Waiting for passenger");
        renderActive();
      }
    } catch (e) {
      U.toast(e.error || "Action failed");
    }
  }

  async function cancelTrip() {
    if (!D.activeRide) return;
    try {
      await api.cancelRide(D.activeRide.id, "Driver cancelled");
      U.toast("Trip cancelled");
      notify("Trip Cancelled", "This ride has been cancelled");
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
    const dist = target && D.pos ? U.haversine(D.pos, target) : 0;
    const statusMap = {
      assigned: ["Heading to pickup", `${U.km(dist)} to pickup`],
      driver_arriving: ["Heading to pickup", `${U.km(dist)} to pickup`],
      arrived: ["Waiting at pickup", "Passenger is on the way"],
      in_transit: ["On the way to destination", `${U.km(dist)} remaining`],
      completed: ["Trip completed", "Collect payment to finish"],
      cancelled: ["Trip cancelled", "This ride was cancelled"],
    };
    const [title, sub] = statusMap[r.status] || ["Active trip", ""];
    el("drv-active-status").textContent = title;
    el("drv-active-sub").textContent = sub;

    // Show the correct action button based on status
    const arrivedBtn = el("btn-drv-arrived");
    const startBtn = el("btn-drv-start-ride");
    const completeBtn = el("btn-drv-complete");
    const cancelBtn = el("btn-drv-cancel-trip");
    const finished = r.status === "completed" || r.status === "cancelled";

    // Hide all first
    arrivedBtn.classList.add("hidden");
    startBtn.classList.add("hidden");
    completeBtn.classList.add("hidden");
    cancelBtn.classList.toggle("hidden", finished);

    if (r.status === "assigned" || r.status === "driver_arriving") {
      arrivedBtn.classList.remove("hidden");
    } else if (r.status === "arrived") {
      startBtn.classList.remove("hidden");
    } else if (r.status === "in_transit") {
      completeBtn.classList.remove("hidden");
    }

    // Trip code display
    const codeEl = el("drv-trip-code");
    if (codeEl) {
      const code = D.tripCode || r.trip_code;
      if (r.status !== "completed" && r.status !== "cancelled" && code) {
        codeEl.classList.remove("hidden");
        codeEl.innerHTML = `<span class="tc-label">Your verification code</span>
          <span class="tc-code">${code}</span>`;
      } else {
        codeEl.classList.add("hidden");
        codeEl.innerHTML = "";
      }
    }

    renderPaymentUI(r);

    MK.clearLayer(D.map);
    renderSelf();
    const pts = [{ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng }];
    MK.polylines(D.map, pts, "#1a7dff");
    L.marker([r.pickup_lat, r.pickup_lng], { icon: MK.dropIcon("A") }).addTo(D.map);
    L.marker([r.dropoff_lat, r.dropoff_lng], { icon: MK.dropIcon("B") }).addTo(D.map);
    const fitPts = D.pos ? [D.pos, ...pts] : pts;
    MK.fitAll(D.map, fitPts);
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
      el("btn-drv-arrived").classList.add("hidden");
      el("btn-drv-start-ride").classList.add("hidden");
      el("btn-drv-complete").classList.add("hidden");
      el("btn-drv-cancel-trip").classList.add("hidden");
      box.classList.remove("hidden");
      return;
    }

    confirmBtn.classList.add("hidden");
    if (r.status !== "cancelled") { box.classList.remove("hidden"); }
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
    D.tripCode = null;
    el("drv-active").classList.add("hidden");
    el("drv-idle-card").classList.toggle("hidden", D.online);
    MK.clearLayer(D.map);
    renderSelf();
    setTimeout(() => D.map?.invalidateSize(), 200);
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
      setTimeout(() => {
        D.map?.invalidateSize();
        renderSelf();
      }, 200);
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
