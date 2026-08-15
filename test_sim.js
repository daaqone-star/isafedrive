/*
 * Headless test of the browser-simulation backend (sim.js) using Node.
 * Shims window/localStorage/sessionStorage, then exercises a full
 * passenger <-> driver ride flow against the simulation. No demo data —
 * every actor is registered fresh at runtime.
 */
const fs = require("fs");
const path = require("path");

(async () => {
  const store = new Map();
  const sstore = new Map();
  const localStorageShim = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sessionStorageShim = {
    getItem: (k) => (sstore.has(k) ? sstore.get(k) : null),
    setItem: (k, v) => sstore.set(k, String(v)),
    removeItem: (k) => sstore.delete(k),
  };

  global.window = global;
  global.document = { getElementById: () => null, readyState: "complete", addEventListener: () => {} };
  global.localStorage = localStorageShim;
  global.sessionStorage = sessionStorageShim;
  global.setInterval = (fn) => { global.__ticks = global.__ticks || []; global.__ticks.push(fn); return global.__ticks.length; };
  global.clearInterval = () => {};
  global.Intl = Intl;

  const js = (f) => fs.readFileSync(path.join(__dirname, "static", "js", f), "utf8");
  eval(js("util.js"));
  eval(js("sim.js"));

  const sim = global.Sim;
  const U = global.U;

  async function step(name, fn) {
    try { await fn(); console.log("ok   ", name); }
    catch (e) { console.log("FAIL ", name, "->", e.message); process.exitCode = 1; }
  }

  const USER = {};
  const PASS_PHONE = "08190000001";
  const DRV_PHONE = "08190000002";

  await step("register passenger fresh (no demo data)", async () => {
    const r = await sim.register({ name: "Test Pax", phone: PASS_PHONE, password: "x", role: "passenger" });
    if (r.user.role !== "passenger") throw new Error("wrong role");
    USER.passenger = r.user;
    sstore.set("isafedrive_user", JSON.stringify(r.user));
  });

  await step("register driver fresh + me()", async () => {
    const r = await sim.register({ name: "Test Drv", phone: DRV_PHONE, password: "x", role: "driver", vehicle_type: "Sedan", vehicle_reg: "TES 123 LAG" });
    if (r.user.role !== "driver") throw new Error("wrong role");
    sstore.set("isafedrive_user", JSON.stringify(r.user));
    const me = await sim.me();
    if (!me.driver || me.driver.vehicle_type !== "Sedan") throw new Error("driver record missing");
    if (me.driver.user_id !== r.user.id) throw new Error("user_id mismatch");
    USER.driver = r.user;
    USER.driverId = me.driver.id;
  });

  await step("driver login + toggle online works", async () => {
    const r = await sim.login({ phone: DRV_PHONE, password: "x" });
    sstore.set("isafedrive_user", JSON.stringify(r.user));
    await sim.adminApproveDriver(USER.driverId, 1);
    const d = await sim.toggleDriver(USER.driver.id, true);
    if (d.online !== 1) throw new Error("driver not online");
  });

  await step("admin self-registration blocked", async () => {
    let blocked = false;
    try { await sim.register({ name: "Admin", phone: "07000000000", password: "x", role: "admin" }); }
    catch (e) { blocked = true; }
    if (!blocked) throw new Error("admin register not blocked");
  });

  await step("nearby drivers", async () => {
    const drv = await sim.driversNearby(6.5244, 3.3792, "any", 6);
    if (!drv.length) throw new Error("no nearby drivers");
    const sorted = drv.every((d, i) => i === 0 || drv[i - 1].distance_km <= d.distance_km);
    if (!sorted) throw new Error("not sorted by distance");
  });

  let rideId;
  await step("passenger books ride", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.passenger));
    const ride = await sim.createRide({
      pickup: { lat: 6.5244, lng: 3.3792, address: "Lekki" },
      dropoff: { lat: 6.4551, lng: 3.3925, address: "Ikoyi" },
      vehicle_type: "Sedan", payment_method: "card",
    });
    rideId = ride.id;
    if (ride.status !== "requesting") throw new Error("should start requesting");
    if (!(ride.fare > 1000)) throw new Error("fare estimate wrong: " + ride.fare);
  });

  await step("driver sees pending + accepts (UI-style calls)", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.driver));
    const pending = await sim.pendingRides(6.5244, 3.3792, 8);
    if (!pending.some((p) => p.id === rideId)) throw new Error("ride not in pending");
    const accepted = await sim.acceptRide(rideId);
    if (accepted.status !== "assigned") throw new Error("accept failed");
  });

  await step("passenger sees assigned driver + tracks", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.passenger));
    const ride = await sim.getRide(rideId);
    if (!ride.driver || !ride.driver.lat) throw new Error("driver position missing");
    const before = ride.driver;
    (global.__ticks || []).forEach((t) => t());
    (global.__ticks || []).forEach((t) => t());
    const ride2 = await sim.getRide(rideId);
    const moved = Math.abs(ride2.driver.lat - before.lat) + Math.abs(ride2.driver.lng - before.lng);
    if (moved === 0) throw new Error("driver not moving toward pickup");
  });

  await step("driver advances trip + completes (UI-style calls)", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.driver));
    await sim.updateRideStatus(rideId, "arrived");
    await sim.updateRideStatus(rideId, "in_transit");
    const done = await sim.completeRide(rideId);
    if (done.status !== "completed") throw new Error("not completed");
  });

  await step("passenger rates", async () => {
    const r = await sim.rateRide(rideId, 5, "nice");
    if (!r.ok) throw new Error("rate failed");
  });

  await step("driver earnings + trips history (UI-style calls)", async () => {
    const e = await sim.driverEarnings();
    if (e.trips < 1) throw new Error("trips not counted");
    const rides = await sim.listRides();
    if (!rides.some((r) => r.id === rideId)) throw new Error("trip not in driver history");
  });

  await step("passenger trip history (UI-style calls)", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.passenger));
    const rides = await sim.listRides();
    if (!rides.some((r) => r.id === rideId)) throw new Error("trip not in passenger history");
  });

  await step("admin analytics", async () => {
    const a = await sim.adminAnalytics();
    if (!a.by_day.length) throw new Error("no analytics");
    const stats = await sim.adminStats();
    if (stats.completed_rides < 1) throw new Error("admin stats wrong");
  });

  await step("register + auth guard", async () => {
    const r = await sim.register({ name: "New User", phone: "08190000003", password: "x", role: "passenger" });
    if (!r.token) throw new Error("register failed");
    let dupErr = false;
    try { await sim.register({ name: "New User", phone: "08190000003", password: "x" }); }
    catch (e) { dupErr = true; }
    if (!dupErr) throw new Error("duplicate phone not blocked");
  });

  await step("driver toggle off/on", async () => {
    sstore.set("isafedrive_user", JSON.stringify(USER.driver));
    const d = await sim.toggleDriver(USER.driver.id, false);
    if (d.online !== 0) throw new Error("toggle failed");
    await sim.toggleDriver(USER.driver.id, true);
  });

  console.log(process.exitCode ? "\nSIM TESTS FAILED" : "\nALL SIM TESTS PASSED");
})();
