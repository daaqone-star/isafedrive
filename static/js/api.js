/*
 * iSafedrive — API layer.
 *
 * Detects whether the Flask backend is reachable. If yes it talks to the
 * REST API; if not it transparently uses the in-browser simulation (Sim),
 * so the app always works.
 */
(function (global) {
  const SESSION_KEY = "isafedrive_session";
  let serverMode = false;

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
  }
  function saveSession(s) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

  function authHeaders(extra) {
    const s = loadSession();
    return { "Content-Type": "application/json", ...(s ? { "X-User-Id": String(s.id) } : {}), ...(extra || {}) };
  }

  async function http(method, path, body) {
    const opts = { method, headers: authHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw { error: "Network error — is the server running?", _net: true };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      if (res.status === 401 && path !== "/api/auth/login" && loadSession()) {
        clearSession();
        setTimeout(() => location.reload(), 600);
        throw { error: "Session expired — redirecting to login…", _net: false, status: 401 };
      }
      throw { error: data?.error || `Request failed (${res.status})`, _net: false, status: res.status };
    }
    return data;
  }

  async function detect() {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "__probe__", password: "__probe__" }),
      });
      serverMode = res.status === 200 || res.status === 401;
    } catch (e) {
      serverMode = false;
    }
    return serverMode;
  }

  const server = {
    login: (b) => http("POST", "/api/auth/login", b),
    register: (b) => http("POST", "/api/auth/register", b),
    me: () => http("GET", "/api/me"),
    driversNearby: (lat, lng, vtype, radius) =>
      http("GET", `/api/drivers/nearby?lat=${lat}&lng=${lng}&vehicle_type=${encodeURIComponent(vtype || "any")}&radius=${radius || 5}`),
    createRide: (b) => http("POST", "/api/rides", b),
    getRide: (id) => http("GET", `/api/rides/${id}`),
    listRides: (role, userId) => http("GET", "/api/rides"),
    pendingRides: (lat, lng, radius, driverId) =>
      http("GET", `/api/rides/pending?lat=${lat}&lng=${lng}&radius=${radius || 8}`),
    acceptRide: (id) => http("POST", `/api/rides/${id}/accept`),
    declineRide: (id) => http("POST", `/api/rides/${id}/decline`),
    updateRideStatus: (id, status) => http("POST", `/api/rides/${id}/status`, { status }),
    completeRide: (id) => http("POST", `/api/rides/${id}/complete`),
    cancelRide: (id, reason) => http("POST", `/api/rides/${id}/cancel`, { reason }),
    rateRide: (id, rating, comment) => http("POST", `/api/rides/${id}/rate`, { rating, comment }),
    driverEarnings: () => http("GET", "/api/driver/earnings"),
    toggleDriver: (online) => http("POST", "/api/driver/toggle", { online }),
    adminStats: () => http("GET", "/api/admin/stats"),
    adminRides: (status) => http("GET", `/api/admin/rides${status ? "?status=" + status : ""}`),
    adminRide: (id) => http("GET", `/api/admin/rides/${id}`),
    adminCancelRide: (id) => http("POST", `/api/admin/rides/${id}/cancel`),
    adminDrivers: () => http("GET", "/api/admin/drivers"),
    adminUsers: () => http("GET", "/api/admin/users"),
    adminApproveDriver: (id, approved) => http("PUT", `/api/admin/drivers/${id}/approve`, { approved }),
    adminSuspendDriver: (id, suspend) => http("PUT", `/api/admin/drivers/${id}/suspend`, { suspend }),
    adminAnalytics: () => http("GET", "/api/admin/analytics"),
    adminEditUser: (id, data) => http("PUT", `/api/admin/users/${id}`, data),
    adminDeleteUser: (id) => http("DELETE", `/api/admin/users/${id}`),
    adminEditDriver: (id, data) => http("PUT", `/api/admin/drivers/${id}`, data),
    adminDeleteDriver: (id) => http("DELETE", `/api/admin/drivers/${id}`),
    sendMessage: (data) => http("POST", "/api/messages", data),
    getMessages: (rideId) => http("GET", `/api/messages${rideId ? "?ride_id=" + rideId : ""}`),
    adminMessages: () => http("GET", "/api/admin/messages"),
  };

  // Build a facade where each method resolves to the right backend.
  const api = {};
  const keys = Object.keys(server);
  for (const k of keys) {
    api[k] = (async (...args) => {
      if (serverMode) {
        // For server calls, some take (role, userId) or (id, driverId) — drop the
        // redundant local-only args.
        switch (k) {
          case "listRides": return server.listRides();
          case "acceptRide": return server.acceptRide(args[0]);
          case "declineRide": return server.declineRide(args[0]);
          case "updateRideStatus": return server.updateRideStatus(args[0], args[1]);
          case "completeRide": return server.completeRide(args[0]);
          case "pendingRides": return server.pendingRides(args[0], args[1], args[2]);
          case "adminRides": return server.adminRides(args[0]);
          case "adminRide": return server.adminRide(args[0]);
          case "adminCancelRide": return server.adminCancelRide(args[0]);
          case "rateRide": return server.rateRide(args[0], args[1], args[2]);
          case "toggleDriver": return server.toggleDriver(args[0]);
          case "cancelRide": return server.cancelRide(args[0], args[1]);
          case "driversNearby": return server.driversNearby(args[0], args[1], args[2], args[3]);
          case "adminEditUser": return server.adminEditUser(args[0], args[1]);
          case "adminDeleteUser": return server.adminDeleteUser(args[0]);
          case "adminEditDriver": return server.adminEditDriver(args[0], args[1]);
          case "adminDeleteDriver": return server.adminDeleteDriver(args[0]);
          case "sendMessage": return server.sendMessage(args[0]);
          case "getMessages": return server.getMessages(args[0]);
          default: return server[k](...args);
        }
      }
      return global.Sim[k](...args);
    });
  }

  api.serverMode = () => serverMode;
  api.detect = detect;
  api.loadSession = loadSession;
  api.saveSession = saveSession;
  api.clearSession = clearSession;
  api.authHeaders = authHeaders;
  api.http = http;

  global.api = api;
})(window);
