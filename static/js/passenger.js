/* iSafedrive — Passenger app */
(function (global) {
  const U = global.U;
  const MK = global.MapKit;
  const api = global.api;
  const L = global.L;

  const P = {
    map: null,
    pickup: null,
    dropoff: null,
    vehicleType: "Sedan",
    activeRide: null,
    pollTimer: null,
    nearbyTimer: null,
    markers: { pickup: null, dropoff: null, driver: null, route: [] },
    nearbyLayer: null,
    rate: 5,
    promoCode: "",
    lat: 6.5244,
    lng: 3.3792,
    searchTimers: {},
    _inited: false,
  };

  function el(id) { return document.getElementById(id); }
  function show(id) { el(id)?.classList.remove("hidden"); }
  function hide(id) { el(id)?.classList.add("hidden"); }

  function notify(title, body) {
    window.App?.notify(title, body);
  }

  // ---------------------------------------------------------------
  function init() {
    if (P._inited) {
      setTimeout(() => P.map?.invalidateSize(), 200);
      return;
    }
    P._inited = true;

    P.map = MK.createMap(el("pax-map"), [P.lat, P.lng], 14);
    setTimeout(() => P.map?.invalidateSize(), 400);
    setTimeout(() => P.map?.invalidateSize(), 1200);
    P.map.on("click", onMapClick);
    P.nearbyLayer = L.layerGroup().addTo(P.map);

    el("btn-pax-locate").onclick = () => useGeolocation(true);

    buildVehicleOptions();

    el("btn-book").onclick = book;
    el("btn-cancel-request").onclick = () => cancelActive("Passenger cancelled request");
    el("btn-cancel-ride").onclick = () => cancelActive("Passenger cancelled");
    el("btn-rate-open").onclick = () => el("pax-rate").classList.remove("hidden");
    el("btn-rate-submit").onclick = submitRating;
    el("btn-ride-done").onclick = () => { stopRide(); U.toast("Safe journey — see you next time!"); };
    el("pay-method").onchange = () => { syncPayUI(); };
    el("card-number").addEventListener("input", () => {
      el("card-number").value = el("card-number").value.replace(/[^\d]/g, "").replace(/(\d{4})(?=\d)/g, "$1 ");
    });
    el("card-expiry").addEventListener("input", () => {
      const v = el("card-expiry").value.replace(/[^\d]/g, "");
      if (v.length > 2) el("card-expiry").value = v.slice(0, 2) + "/" + v.slice(2, 4);
    });
    el("btn-promo-apply").onclick = applyPromoCode;
    el("promo-input").addEventListener("keydown", (e) => { if (e.key === "Enter") applyPromoCode(); });
    el("btn-sos").onclick = () => el("sos-modal").classList.remove("hidden");
    el("btn-sos-close").onclick = () => el("sos-modal").classList.add("hidden");

    // book-other checkbox
    const bookOtherCheck = el("book-other-check");
    if (bookOtherCheck) {
      bookOtherCheck.onchange = () => {
        el("book-other-fields").classList.toggle("hidden", !bookOtherCheck.checked);
      };
    }

    // chat FAB
    const chatFab = el("chat-fab");
    if (chatFab) {
      chatFab.onclick = () => openChat();
      chatFab.classList.remove("hidden");
    }

    // stars
    el("pax-stars").querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        P.rate = Number(b.dataset.s);
        el("pax-stars").querySelectorAll("button").forEach((x) => x.classList.toggle("on", Number(x.dataset.s) <= P.rate));
      };
    });

    // bottom tabs
    document.querySelectorAll("#passenger-app .bt-tab").forEach((t) => {
      t.onclick = () => paxTab(t.dataset.tab);
    });

    // Location search — pickup
    setupSearch("pickup");
    // Location search — dropoff
    setupSearch("dropoff");

    el("btn-book").disabled = true;
    syncPayUI();
    useGeolocation(true);
  }

  // ---------------------------------------------------------------
  // Location search with Nominatim
  // ---------------------------------------------------------------
  function setupSearch(which) {
    const input = el(which === "pickup" ? "pickup-input" : "dropoff-input");
    const results = el(which === "pickup" ? "pickup-results" : "dropoff-results");
    if (!input || !results) return;

    let debounce = null;

    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 3) { results.classList.add("hidden"); return; }
      debounce = setTimeout(() => searchLocation(q, which, results), 350);
    });

    input.addEventListener("focus", () => {
      const q = input.value.trim();
      if (q.length >= 3 && results.children.length > 0) {
        results.classList.remove("hidden");
      }
    });

    // Close results when clicking outside
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.classList.add("hidden");
      }
    });

    // When user presses Enter, use the text as-is and reverse geocode later
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        results.classList.add("hidden");
        const q = input.value.trim();
        if (!q) return;
        // Try to geocode the text query via Nominatim search
        geocodeQuery(q, which);
      }
    });
  }

  async function searchLocation(query, which, resultsEl) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=5`,
        { headers: { "User-Agent": "iSafedriveApp/1.0" } }
      );
      const data = await res.json();
      if (!data.length) {
        resultsEl.innerHTML = `<div class="sr-item"><span class="sr-name">No results found</span></div>`;
        resultsEl.classList.remove("hidden");
        return;
      }
      resultsEl.innerHTML = data.map((r, i) => {
        const parts = (r.display_name || "").split(",");
        const name = parts[0] || query;
        const addr = parts.slice(1, 4).join(",").trim();
        return `<div class="sr-item" data-idx="${i}">
          <div class="sr-name">${U.escapeHtml(name)}</div>
          <div class="sr-addr">${U.escapeHtml(addr)}</div>
        </div>`;
      }).join("");
      resultsEl.classList.remove("hidden");

      // Click handler for each result
      resultsEl.querySelectorAll(".sr-item").forEach((item) => {
        item.onclick = () => {
          const idx = parseInt(item.dataset.idx);
          const r = data[idx];
          if (!r) return;
          const latlng = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
          const name = (r.display_name || "").split(",")[0].trim();
          if (which === "pickup") {
            placePickup(latlng, name);
          } else {
            placeDropoff(latlng, name);
          }
          resultsEl.classList.add("hidden");
        };
      });
    } catch (e) {
      resultsEl.innerHTML = `<div class="sr-item"><span class="sr-name">Search failed — try again</span></div>`;
      resultsEl.classList.remove("hidden");
    }
  }

  async function geocodeQuery(query, which) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=1`,
        { headers: { "User-Agent": "iSafedriveApp/1.0" } }
      );
      const data = await res.json();
      if (data.length) {
        const latlng = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        if (which === "pickup") {
          placePickup(latlng, query);
        } else {
          placeDropoff(latlng, query);
        }
      } else {
        U.toast("Location not found — try a different search");
      }
    } catch (e) {
      U.toast("Could not find location");
    }
  }

  // ---------------------------------------------------------------
  function syncPayUI() {
    const m = el("pay-method").value;
    el("pay-card").classList.toggle("hidden", m !== "card");
    el("pay-transfer").classList.toggle("hidden", m !== "transfer");
    el("pay-processing").classList.add("hidden");
    if (m === "transfer") {
      el("transfer-ref").textContent = "#ISAF-" + Math.floor(1000 + Math.random() * 9000) + "-" + Date.now().toString(36).toUpperCase().slice(-3);
    }
  }

  // Payment helpers
  function luhn(num) {
    const digits = num.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = parseInt(digits[i], 10);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return sum % 10 === 0;
  }

  function validExpiry(exp) {
    const m = exp.trim().match(/^(\d{2})\s*\/\s*(\d{2})$/);
    if (!m) return false;
    const mm = +m[1], yy = 2000 + +m[2];
    if (mm < 1 || mm > 12) return false;
    return new Date(yy, mm, 0, 23, 59, 59) >= new Date();
  }

  function validateCard() {
    const name = el("card-name").value.trim();
    const num = el("card-number").value.trim();
    const exp = el("card-expiry").value.trim();
    const cvv = el("card-cvv").value.trim();
    if (!name) { U.toast("Enter the cardholder name"); return false; }
    if (!luhn(num)) { U.toast("Enter a valid card number"); return false; }
    if (!validExpiry(exp)) { U.toast("Enter a valid expiry (MM/YY)"); return false; }
    if (!/^\d{3,4}$/.test(cvv)) { U.toast("Enter a valid CVV"); return false; }
    return true;
  }

  function processPayment(method) {
    return new Promise((resolve) => {
      const box = el("pay-processing");
      box.classList.remove("hidden");
      el("pay-processing-text").textContent =
        method === "card" ? "Processing card payment…" : "Generating transfer reference…";
      setTimeout(() => { box.classList.add("hidden"); resolve(); }, method === "card" ? 1400 : 800);
    });
  }

  function useGeolocation(centerMap) {
    if (!navigator.geolocation) {
      U.toast("Location unavailable — tap map or search to set location");
      P.map.setView([P.lat, P.lng], 14);
      return;
    }
    U.toast("Detecting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        P.lat = pos.coords.latitude;
        P.lng = pos.coords.longitude;
        if (centerMap) {
          P.map.setView([P.lat, P.lng], 15);
          setTimeout(() => P.map?.invalidateSize(), 200);
        }
        if (!P.pickup) {
          placePickup({ lat: P.lat, lng: P.lng }, "Current location");
          U.toast("📍 Current location set as pickup");
          setTimeout(() => {
            const dropoff = el("dropoff-input");
            if (dropoff) { dropoff.focus(); dropoff.placeholder = "🔍 Where are you going?"; }
          }, 500);
        } else {
          U.toast("📍 Location updated");
        }
      },
      () => {
        U.toast("Could not detect location — use search or tap map");
        if (centerMap) P.map.setView([P.lat, P.lng], 14);
        if (!P.pickup) {
          placePickup({ lat: P.lat, lng: P.lng }, "Lagos, Nigeria");
          setTimeout(() => {
            const dropoff = el("dropoff-input");
            if (dropoff) { dropoff.focus(); dropoff.placeholder = "🔍 Where are you going?"; }
          }, 500);
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function onMapClick(e) {
    if (P.activeRide) return;
    if (!P.pickup) placePickup(e.latlng);
    else placeDropoff(e.latlng);
  }

  function reverseGeocode(latlng, cb) {
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latlng.lat}&lon=${latlng.lng}`, {
      headers: { "User-Agent": "iSafedriveApp/1.0" }
    })
      .then((r) => r.json())
      .then((d) => cb(d?.display_name?.split(",").slice(0, 3).join(",") || `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`))
      .catch(() => cb(`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`));
  }

  function placePickup(p, label) {
    P.pickup = { lat: p.lat, lng: p.lng };
    if (P.markers.pickup) P.map.removeLayer(P.markers.pickup);
    P.markers.pickup = L.marker([p.lat, p.lng], { icon: MK.passengerIcon() }).addTo(P.map);
    if (label) {
      el("pickup-input").value = label;
    } else {
      reverseGeocode(p, (a) => { el("pickup-input").value = a; });
    }
    P.map.setView([p.lat, p.lng], 15);
    refreshNearby();
    updateFare();
    setTimeout(() => {
      const dropoff = el("dropoff-input");
      if (dropoff && !P.dropoff) {
        dropoff.classList.add("active-dest");
        dropoff.focus();
        dropoff.placeholder = "🔍 Where are you going?";
      }
    }, 300);
  }

  function placeDropoff(p) {
    P.dropoff = { lat: p.lat, lng: p.lng };
    if (P.markers.dropoff) P.map.removeLayer(P.markers.dropoff);
    P.markers.dropoff = L.marker([p.lat, p.lng], { icon: MK.dropIcon("B") }).addTo(P.map);
    if (p.label) {
      el("dropoff-input").value = p.label;
    } else {
      reverseGeocode(p, (a) => { el("dropoff-input").value = a; });
    }
    el("dropoff-input").classList.remove("active-dest");
    drawRoute();
    updateFare();
    if (P.pickup) MK.fitAll(P.map, [P.pickup, P.dropoff]);
  }

  function drawRoute() {
    P.markers.route.forEach((l) => l.remove());
    P.markers.route = [];
    if (P.pickup && P.dropoff) {
      P.markers.route = MK.polylines(P.map, [P.pickup, P.dropoff], "#1a7dff");
    }
  }

  async function refreshNearby() {
    if (!P.pickup || P.activeRide) return;
    try {
      const drv = await api.driversNearby(P.pickup.lat, P.pickup.lng, "any", 10);
      P.nearbyLayer.clearLayers();
      if (drv.length === 0) return;
      drv.slice(0, 15).forEach((d) => {
        const m = L.marker([d.lat, d.lng], { icon: MK.driverIcon("available") }).addTo(P.nearbyLayer);
        const popupHtml = `<div class="driver-popup">
          <div class="dp-header"><b>${U.escapeHtml(d.name)}</b><span class="dp-rating">★ ${(d.rating || 5).toFixed(1)}</span></div>
          <div class="dp-details">
            <span>🚗 ${d.vehicle_type}</span>
            <span>📋 ${U.escapeHtml(d.vehicle_reg || "---")}</span>
            <span>📏 ${U.km(d.distance_km)} away</span>
          </div>
          <button class="btn btn-primary btn-block dp-book" onclick="Pax.bookDriver(${d.id}, '${U.escapeHtml(d.vehicle_type)}')">Book ${U.escapeHtml(d.vehicle_type)}</button>
        </div>`;
        m.bindPopup(popupHtml, { maxWidth: 260 });
        m.on("click", () => {
          P.selectedDriver = d;
          P.vehicleType = d.vehicle_type;
          document.querySelectorAll(".v-opt").forEach((b) => {
            b.classList.toggle("selected", b.querySelector(".v-name")?.textContent === d.vehicle_type);
          });
          updateFare();
        });
      });
    } catch (e) { /* ignore */ }
  }

  function bookDriver(driverId, vehicleType) {
    P.vehicleType = vehicleType;
    document.querySelectorAll(".v-opt").forEach((b) => {
      b.classList.toggle("selected", b.querySelector(".v-name")?.textContent === vehicleType);
    });
    updateFare();
    U.toast(`Selected ${vehicleType} — set your pickup and dropoff`);
  }

  function buildVehicleOptions() {
    const wrap = el("vehicle-options");
    wrap.innerHTML = "";
    Object.keys(U.FARE_TABLE).forEach((vt) => {
      const cfg = U.FARE_TABLE[vt];
      const btn = document.createElement("button");
      btn.className = "v-opt" + (vt === P.vehicleType ? " selected" : "");
      btn.innerHTML = `<span class="v-icon">${cfg.icon}</span>
        <span class="v-name">${vt}</span>
        <span class="v-price">${U.ngn(cfg.base)}</span>`;
      btn.onclick = () => {
        P.vehicleType = vt;
        wrap.querySelectorAll(".v-opt").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        updateFare();
      };
      wrap.appendChild(btn);
    });
  }

  function updateFare() {
    const row = el("fare-row");
    const both = P.pickup && P.dropoff;
    el("btn-book").disabled = !both;
    if (!both) { row.hidden = true; return; }
    const dist = U.haversine(P.pickup, P.dropoff);
    const baseFare = U.estimateFare(P.vehicleType, dist);
    const promo = U.applyPromo(baseFare, P.promoCode);
    const mins = Math.max(3, Math.round(dist * 5));
    const breakdown = U.fareBreakdown(P.vehicleType, dist);
    el("fare-amount").textContent = U.ngn(promo.fare);
    el("fare-original").textContent = promo.discount ? U.ngn(baseFare) + " (was)" : "";
    el("fare-original").hidden = !promo.discount;
    el("fare-meta").textContent = `${U.km(dist)} · ${U.mins(mins)}`;
    el("fare-breakdown").textContent =
      `${P.vehicleType}: base ${U.ngn(breakdown.base)} + ${U.ngn(breakdown.distPart)} dist + ${U.ngn(breakdown.timePart)} time`;
    row.hidden = false;
  }

  function applyPromoCode() {
    const raw = el("promo-input").value.trim();
    const msg = el("promo-msg");
    const res = U.applyPromo(1, raw);
    msg.classList.remove("ok", "bad");
    if (!raw) { P.promoCode = ""; msg.textContent = ""; updateFare(); return; }
    if (res.code) {
      P.promoCode = res.code;
      msg.textContent = `✓ ${res.code} applied`;
      msg.classList.add("ok");
    } else {
      P.promoCode = "";
      msg.textContent = "Invalid promo code";
      msg.classList.add("bad");
    }
    updateFare();
  }

  // ---------------------------------------------------------------
  async function book() {
    if (!P.pickup || !P.dropoff) { U.toast("Set both pickup and dropoff first"); return; }
    if (P.activeRide) return;
    const method = el("pay-method").value;
    if (method === "card" && !validateCard()) return;
    const payload = {
      pickup: { lat: P.pickup.lat, lng: P.pickup.lng, address: el("pickup-input").value || "Pickup" },
      dropoff: { lat: P.dropoff.lat, lng: P.dropoff.lng, address: el("dropoff-input").value || "Dropoff" },
      vehicle_type: P.vehicleType,
      payment_method: method,
      promo_code: P.promoCode || null,
    };
    const bookOtherCheck = el("book-other-check");
    if (bookOtherCheck && bookOtherCheck.checked) {
      payload.recipient_name = el("book-other-name")?.value.trim() || null;
      payload.recipient_phone = el("book-other-phone")?.value.trim() || null;
    }
    el("btn-book").disabled = true;
    try {
      await processPayment(method);
      const ride = await api.createRide(payload);
      P.activeRide = ride;
      showSection("pax-searching");
      U.toast(method === "cash" ? "Ride requested — finding your driver…" : "Payment confirmed — finding your driver…");
      startPolling();
    } catch (e) {
      U.toast(e.error || "Could not book ride");
      el("btn-book").disabled = false;
    }
  }

  function showSection(name) {
    ["pax-booking", "pax-searching", "pax-active"].forEach((s) => el(s).classList.toggle("hidden", s !== name));
  }

  function startPolling() {
    clearInterval(P.pollTimer);
    P.pollTimer = setInterval(async () => {
      if (!P.activeRide) return;
      try {
        const ride = await api.getRide(P.activeRide.id);
        renderRide(ride);
      } catch (e) { /* ride may be gone */ }
    }, 2000);
  }

  function renderRide(ride) {
    const prevStatus = P.activeRide ? P.activeRide.status : null;
    P.activeRide = ride;
    if (ride.status === "requesting") {
      showSection("pax-searching");
      el("pax-search-sub").textContent = "Contacting nearby drivers…";
      return;
    }
    if (ride.status === "cancelled") {
      stopRide();
      U.toast("Your ride was cancelled");
      return;
    }
    showSection("pax-active");
    updateActiveCard(ride);
    trackDriver(ride);

    if (ride.status === "assigned" && prevStatus !== "assigned") {
      notify("Driver Found!", "Your driver is on the way");
    } else if (ride.status === "driver_arriving" && prevStatus !== "driver_arriving") {
      notify("Driver Arrived!", "Your driver is waiting");
    } else if (ride.status === "completed" && prevStatus !== "completed") {
      notify("Trip Complete", "Thanks for riding with iSafedrive");
    }
  }

  function updateActiveCard(ride) {
    const d = ride.driver;
    el("pax-driver-name").textContent = d ? d.name : "Driver";
    el("pax-driver-avatar").textContent = "🚗";
    el("pax-car-detail").textContent = `${ride.vehicle_type} · ${d ? d.vehicle_reg : "—"}`;
    el("pax-driver-rating").textContent = d ? d.rating?.toFixed(1) : "5.0";
    el("pax-fare").textContent = U.ngn(ride.fare);

    const line = el("pax-status-line");
    const statuses = {
      assigned: ["🚙", "Driver assigned — heading to your pickup"],
      driver_arriving: ["🚙", "Your driver is on the way"],
      arrived: ["🛑", "Your driver has arrived — come out!"],
      in_transit: ["🛺", "On the way to your destination"],
      completed: ["✅", "Trip completed — safe journey!"],
    };
    const [ico, txt] = statuses[ride.status] || ["🚙", ride.status];
    line.innerHTML = `<span class="st-ico">${ico}</span><span>${txt}</span>`;

    const pay = el("pax-pay-status");
    pay.textContent = ride.payment_method === "card" ? "💳 Paid by card"
      : ride.payment_method === "transfer" ? "🏦 Bank transfer · confirm before pickup"
      : "💵 Cash · pay at destination";

    const cancelBtn = el("btn-cancel-ride");
    const rateBtn = el("btn-rate-open");
    const doneBtn = el("btn-ride-done");
    const finished = ride.status === "completed" || ride.status === "cancelled";
    cancelBtn.classList.toggle("hidden", finished);
    rateBtn.classList.toggle("hidden", ride.status !== "completed");
    doneBtn.classList.toggle("hidden", !finished);
    el("pax-rate").classList.toggle("hidden", ride.status !== "completed");

    const codeBox = el("pax-trip-code");
    if (ride.trip_code && ["assigned", "driver_arriving"].includes(ride.status)) {
      el("pax-code-value").textContent = ride.trip_code;
      codeBox.classList.remove("hidden");
    } else {
      codeBox.classList.add("hidden");
    }

    renderReceipt(ride);
  }

  function renderReceipt(ride) {
    const box = el("pax-receipt");
    if (ride.status !== "completed") { box.classList.add("hidden"); return; }
    const bd = U.fareBreakdown(ride.vehicle_type, ride.distance_km);
    const rows = [
      ["Base fare", U.ngn(bd.base)],
      ["Distance (" + U.km(ride.distance_km) + ")", U.ngn(bd.distPart)],
      ["Time (" + U.mins(ride.duration_min) + ")", U.ngn(bd.timePart)],
    ];
    if (ride.discount > 0) rows.push(["Promo " + (ride.promo_code || ""), "-" + U.ngn(ride.discount)]);
    const rowHtml = rows.map(([k, v]) =>
      `<div class="rc-line ${k.startsWith("Promo") ? "discount" : ""}"><span>${k}</span><span>${v}</span></div>`).join("");
    el("pax-receipt-body").innerHTML = `
      ${rowHtml}
      <div class="rc-line total"><span>Total paid (${ride.payment_method})</span><span>${U.ngn(ride.fare)}</span></div>
      <div class="rc-line"><span>Trip ID</span><span>#${ride.id}</span></div>`;
    box.classList.remove("hidden");
  }

  function trackDriver(ride) {
    const d = ride.driver;
    if (!d) return;
    if (!P.markers.driver) {
      P.markers.driver = L.marker([d.lat, d.lng], { icon: MK.driverIcon("busy"), zIndexOffset: 1000 }).addTo(P.map);
    } else {
      P.markers.driver.setLatLng([d.lat, d.lng]);
    }
    P.markers.route.forEach((l) => l.remove());
    P.markers.route = [];
    const pts = [{ lat: ride.pickup_lat, lng: ride.pickup_lng }, { lat: ride.dropoff_lat, lng: ride.dropoff_lng }];
    if (P.markers.pickup) P.markers.pickup.setLatLng([ride.pickup_lat, ride.pickup_lng]);
    if (P.markers.dropoff) P.markers.dropoff.setLatLng([ride.dropoff_lat, ride.dropoff_lng]);
    P.markers.route = MK.polylines(P.map, pts, "#1a7dff");
    if (ride.status === "assigned" || ride.status === "driver_arriving") {
      MK.fitAll(P.map, [d, { lat: ride.pickup_lat, lng: ride.pickup_lng }]);
    } else if (ride.status === "in_transit") {
      MK.fitAll(P.map, [d, { lat: ride.dropoff_lat, lng: ride.dropoff_lng }]);
    }
  }

  async function cancelActive(reason) {
    if (!P.activeRide) return;
    try {
      await api.cancelRide(P.activeRide.id, reason);
      stopRide();
      U.toast("Ride cancelled");
    } catch (e) {
      U.toast(e.error || "Could not cancel");
    }
  }

  async function submitRating() {
    if (!P.activeRide) return;
    try {
      await api.rateRide(P.activeRide.id, P.rate, el("pax-comment").value);
      U.toast("Thanks for rating your driver!");
      el("pax-rate").classList.add("hidden");
    } catch (e) {
      U.toast(e.error || "Could not submit rating");
    }
  }

  function stopRide() {
    clearInterval(P.pollTimer);
    P.activeRide = null;
    if (P.markers.driver) { P.map.removeLayer(P.markers.driver); P.markers.driver = null; }
    if (P.markers.pickup) { P.map.removeLayer(P.markers.pickup); P.markers.pickup = null; }
    if (P.markers.dropoff) { P.map.removeLayer(P.markers.dropoff); P.markers.dropoff = null; }
    P.markers.route.forEach((l) => l.remove());
    P.markers.route = [];
    P.pickup = null; P.dropoff = null;
    P.promoCode = "";
    el("pickup-input").value = "";
    el("dropoff-input").value = "";
    el("dropoff-input").placeholder = "🔍 Search destination…";
    el("dropoff-input").classList.remove("active-dest");
    el("fare-row").hidden = true;
    el("promo-input").value = "";
    el("promo-msg").textContent = "";
    el("btn-book").disabled = true;
    el("pax-receipt").classList.add("hidden");
    el("pax-pay-status").textContent = "";
    el("card-name").value = "";
    el("card-number").value = "";
    el("card-expiry").value = "";
    el("card-cvv").value = "";
    syncPayUI();
    showSection("pax-booking");
    P.nearbyLayer.clearLayers();
    setTimeout(() => P.map?.invalidateSize(), 200);
  }

  // ---------------------------------------------------------------
  function paxTab(tab) {
    document.querySelectorAll("#passenger-app .bt-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    const bookingVisible = tab === "book";
    el("pax-sheet").classList.toggle("hidden", !bookingVisible);
    el("pax-trips").classList.toggle("hidden", tab !== "trips");
    el("pax-profile").classList.toggle("hidden", tab !== "profile");
    if (tab === "trips") renderTrips();
    if (tab === "profile") renderProfile();
    if (bookingVisible) {
      setTimeout(() => {
        P.map?.invalidateSize();
        if (P.pickup) refreshNearby();
      }, 200);
    }
  }

  async function renderTrips() {
    const wrap = el("pax-trips");
    wrap.innerHTML = `<div class="list-head"><button class="back" onclick="Pax.paxTab('book')">←</button><h2>My Trips</h2></div>`;
    try {
      const rides = await api.listRides();
      if (!rides.length) { wrap.innerHTML += `<p class="muted">No trips yet.</p>`; return; }
      rides.forEach((r) => {
        const st = r.status === "completed" ? "st-completed" : r.status === "cancelled" ? "st-cancelled" : "st-active";
        wrap.innerHTML += `<div class="ride-card">
          <div class="rc-top"><strong>${r.vehicle_type} · ${U.fmtDate(r.created_at)}</strong>
            <span class="rc-status ${st}">${U.STATUS_LABEL(r.status)}</span></div>
          <div class="rc-addr"><span class="req-pin pin-a">A</span><b>${U.escapeHtml(r.pickup_address || "Pickup")}</b></div>
          <div class="rc-addr"><span class="req-pin pin-b">B</span><b>${U.escapeHtml(r.dropoff_address || "Dropoff")}</b></div>
          <div class="rc-meta"><span>${U.km(r.distance_km)}</span><span>${U.mins(r.duration_min)}</span>
            <span class="rc-fare">${U.ngn(r.fare)}</span><span>${r.payment_method}</span></div>
        </div>`;
      });
    } catch (e) { wrap.innerHTML += `<p class="muted">Could not load trips.</p>`; }
  }

  async function renderProfile() {
    const wrap = el("pax-profile");
    const s = api.loadSession();
    wrap.innerHTML = `<div class="list-head"><button class="back" onclick="Pax.paxTab('book')">←</button><h2>Profile</h2></div>
      <div class="profile-card">
        <div class="profile-avatar">${U.escapeHtml((s?.name || "?").charAt(0))}</div>
        <h2>${U.escapeHtml(s?.name || "")}</h2>
        <p>${U.escapeHtml(s?.phone || "")}</p>
        <p>Member since ${U.fmtDate(s?.created_at || new Date().toISOString())}</p>
      </div>`;
    try {
      const rides = await api.listRides();
      const completed = rides.filter((r) => r.status === "completed");
      const spent = completed.reduce((a, r) => a + r.fare, 0);
      wrap.innerHTML += `<div class="stat-grid">
        <div class="stat-box"><div class="sv">${rides.length}</div><div class="sl">Trips</div></div>
        <div class="stat-box"><div class="sv">${completed.length}</div><div class="sl">Completed</div></div>
        <div class="stat-box"><div class="sv">${U.ngn(spent)}</div><div class="sl">Total spent</div></div>
      </div>`;
    } catch (e) { /* ignore */ }
    wrap.innerHTML += `<div class="profile-row"><span>Payment default</span><strong>Cash</strong></div>
      <div class="profile-row"><span>Zone</span><strong>Lagos</strong></div>
      <button class="btn btn-primary btn-block" style="margin-top:16px" onclick="Pax.openChat()">💬 Chat with Support</button>`;
  }

  let _chatTimer = null;
  async function openChat(rideId) {
    const chatFab = el("chat-fab");
    if (chatFab) chatFab.classList.add("hidden");
    el("chat-panel").classList.remove("hidden");
    el("chat-title").textContent = rideId ? `Chat — Ride #${rideId}` : "iSafedrive Support";
    el("chat-messages").innerHTML = "";
    el("chat-input").value = "";
    el("chat-send").onclick = () => sendChat(rideId);
    el("chat-close").onclick = closeChat;
    el("chat-input").addEventListener("keydown", function h(e) {
      if (e.key === "Enter") { sendChat(rideId); el("chat-input").removeEventListener("keydown", h); }
    });
    await loadChatMessages(rideId);
    clearInterval(_chatTimer);
    _chatTimer = setInterval(() => loadChatMessages(rideId), 3000);
  }

  async function loadChatMessages(rideId) {
    try {
      const msgs = await api.getMessages(rideId);
      const box = el("chat-messages");
      const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = msgs.map((m) => {
        const isMe = m.sender_role !== "bot";
        const label = m.sender_role === "bot" ? "🤖 Support" : m.sender_role === "driver" ? "🚗 Driver" : "You";
        return `<div class="chat-msg ${isMe ? "me" : "bot"}">
          <span class="cm-label">${label}</span>
          <div class="cm-bubble">${U.escapeHtml(m.content)}</div>
          <span class="cm-time">${U.fmtTime(m.created_at)}</span>
        </div>`;
      }).join("");
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
    } catch (e) { /* ignore */ }
  }

  async function sendChat(rideId) {
    const input = el("chat-input");
    const content = input.value.trim();
    if (!content) return;
    input.value = "";
    try {
      await api.sendMessage({ content, ride_id: rideId || null, conversation_type: rideId ? "ride" : "support" });
      await loadChatMessages(rideId);
    } catch (e) { U.toast("Could not send message"); }
  }

  function closeChat() {
    el("chat-panel").classList.add("hidden");
    clearInterval(_chatTimer);
    const chatFab = el("chat-fab");
    if (chatFab) chatFab.classList.remove("hidden");
  }

  global.Pax = { init, paxTab, placePickup, bookDriver, openChat, sendChat, closeChat };
})(window);
