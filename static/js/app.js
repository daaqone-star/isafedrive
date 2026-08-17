/* iSafedrive — bootstrap + auth router (role-based directories) */
(function (global) {
  const U = global.U;
  const api = global.api;
  const SESSION_KEY = "isafedrive_last_role";
  const NOTIF_KEY = "isafedrive_notifications";

  function el(id) { return document.getElementById(id); }
  function show(elId) { el(elId).classList.remove("hidden"); }
  function hide(elId) { el(elId).classList.add("hidden"); }

  const ROLES = {
    passenger: {
      title: "Passenger",
      sub: "Sign in to book your ride",
      loginBtn: "Sign in",
      regBtn: "Create account",
      regNote: "",
    },
    driver: {
      title: "Driver",
      sub: "Sign in to your driver account",
      loginBtn: "Sign in as Driver",
      regBtn: "Create driver account",
      regNote: "New drivers are approved by admin before they can go online.",
    },
    admin: {
      title: "Admin",
      sub: "Sign in to the control centre",
      loginBtn: "Sign in to Admin",
      regBtn: "",
      regNote: "",
    },
  };

  function parseRoute() {
    const h = (location.hash || "#/").replace(/^#\/?/, "");
    const parts = h.split("/");
    const role = ROLES[parts[0]] ? parts[0] : null;
    if (!role) return { role: null, mode: "login" };
    const mode = role === "admin" ? "login" : parts[1] === "register" ? "register" : "login";
    return { role, mode };
  }

  function renderAuth() {
    const r = parseRoute();
    if (!r.role) {
      show("role-picker");
      hide("auth-role-screen");
      return;
    }
    hide("role-picker");
    show("auth-role-screen");

    const cfg = ROLES[r.role];
    el("auth-role-title").textContent = cfg.title;
    el("auth-role-sub").textContent = cfg.sub;
    el("login-btn").textContent = cfg.loginBtn;
    el("register-btn").textContent = cfg.regBtn;
    el("auth-role-note").textContent = cfg.regNote;

    const regTab = document.querySelector('.at-tab[data-mode="register"]');
    regTab.classList.toggle("hidden", r.role === "admin");

    setMode(r.mode);
    el("login-error").textContent = "";
    el("register-error").textContent = "";
    el("login-form").reset();
    el("register-form").reset();
  }

  function setMode(mode) {
    const r = parseRoute();
    document.querySelectorAll(".auth-tabs .at-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.mode === mode));
    el("login-form").classList.toggle("hidden", mode !== "login");
    el("register-form").classList.toggle("hidden", mode !== "register");
    el("reg-driver").classList.toggle("hidden", r.role !== "driver");
  }

  function go(route) {
    const target = "#/" + route;
    if (location.hash === target) { renderAuth(); return; }
    location.hash = target;
  }

  /* ---- Notifications ---- */
  function _loadNotifs() {
    try { return JSON.parse(sessionStorage.getItem(NOTIF_KEY)) || []; } catch (e) { return []; }
  }

  function _saveNotifs(arr) {
    sessionStorage.setItem(NOTIF_KEY, JSON.stringify(arr));
  }

  function _updateBadge() {
    const notifs = _loadNotifs();
    const unread = notifs.filter((n) => !n.read).length;
    const badge = el("notif-badge");
    if (badge) {
      badge.textContent = unread;
      badge.style.display = unread > 0 ? "" : "none";
    }
  }

  function notify(title, body) {
    const notifs = _loadNotifs();
    notifs.unshift({ title: title || "", body: body || "", time: Date.now(), read: false });
    _saveNotifs(notifs);
    _updateBadge();
    if (U && U.toast) U.toast(title || "Notification");
    else if (global.toast) global.toast(title || "Notification");
  }

  function toggleNotifs() {
    const panel = el("notif-panel");
    if (!panel) return;
    const isHidden = panel.classList.contains("hidden");
    if (isHidden) {
      const notifs = _loadNotifs();
      notifs.forEach((n) => (n.read = true));
      _saveNotifs(notifs);
      _updateBadge();
      const list = el("notif-list");
      if (list) {
        list.innerHTML = "";
        if (notifs.length === 0) {
          list.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">No notifications</div>';
        } else {
          notifs.forEach((n) => {
            const d = document.createElement("div");
            d.className = "notif-item" + (n.read ? "" : " unread");
            d.innerHTML =
              '<strong>' + (n.title || "") + '</strong><br><span>' + (n.body || "") + '</span><br><small>' +
              new Date(n.time).toLocaleString() + "</small>";
            list.appendChild(d);
          });
        }
      }
      show("notif-panel");
    } else {
      hide("notif-panel");
    }
  }

  window.App = { toggleNotifs: toggleNotifs, notify: notify };

  /* ---- Auth tabs / role cards ---- */
  document.querySelectorAll(".role-card").forEach((c) => {
    c.onclick = () => go(c.dataset.role + "/login");
  });

  document.querySelectorAll(".auth-tabs .at-tab").forEach((t) => {
    t.onclick = () => {
      const r = parseRoute();
      if (!r.role) return;
      go(r.role + "/" + (t.dataset.mode === "register" ? "register" : "login"));
    };
  });

  el("btn-auth-back").onclick = () => go("");

  el("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    doLogin();
  });

  el("register-form").addEventListener("submit", (e) => {
    e.preventDefault();
    doRegister();
  });

  document.querySelectorAll(".js-logout").forEach((b) => (b.onclick = logout));

  function normPhone(p) { return (p || "").replace(/[\s\-()]/g, "").trim(); }

  async function doLogin() {
    const phone = normPhone(el("login-phone").value);
    const password = el("login-password").value;
    if (!phone || !password) { el("login-error").textContent = "Enter your phone and password."; return; }
    const btn = el("login-btn");
    btn.disabled = true;
    el("login-error").textContent = "";
    try {
      const res = await api.login({ phone, password });
      api.saveSession(res.user);
      const r = parseRoute();
      if (r.role) sessionStorage.setItem(SESSION_KEY, r.role);
      enterApp(res.user);
    } catch (err) {
      el("login-error").textContent = err.error || "Login failed";
    } finally {
      btn.disabled = false;
    }
  }

  async function doRegister() {
    const r = parseRoute();
    const role = r.role || "passenger";
    const name = el("reg-name").value.trim();
    const phone = normPhone(el("reg-phone").value);
    const password = el("reg-password").value;
    const errEl = el("register-error");
    errEl.textContent = "";
    if (!name || !phone || !password) { errEl.textContent = "Fill in all fields."; return; }
    if (password.length < 4) { errEl.textContent = "Password must be at least 4 characters."; return; }
    if (!/^0\d{10}$/.test(phone) && !/^\+?\d{10,13}$/.test(phone)) {
      errEl.textContent = "Enter a valid phone number (e.g. 08012345678).";
      return;
    }
    const btn = el("register-btn");
    btn.disabled = true;
    const payload = { name, phone, password, role };
    if (role === "driver") {
      payload.vehicle_type = el("reg-vehicle").value;
      payload.vehicle_reg = el("reg-plate").value.trim() || "---";
    }
    try {
      const res = await api.register(payload);
      api.saveSession(res.user);
      sessionStorage.setItem(SESSION_KEY, role);
      U.toast("Account created — welcome to iSafedrive!");
      enterApp(res.user);
    } catch (err) {
      errEl.textContent = err.error || "Registration failed";
    } finally {
      btn.disabled = false;
    }
  }

  function enterApp(user) {
    hide("splash");
    hide("auth-screen");
    show("app-shell");
    show("notif-fab");
    _updateBadge();
    if (user.role === "driver") {
      el("drv-name").textContent = user.name;
      const pill = el("mode-pill-drv");
      pill.textContent = api.serverMode() ? "LIVE" : "SIM";
      pill.classList.toggle("off", !api.serverMode());
    } else if (user.role === "admin") {
      el("admin-name").textContent = user.name;
    } else {
      el("pax-name").textContent = user.name;
      const pill = el("mode-pill-pax");
      pill.textContent = api.serverMode() ? "LIVE" : "SIM";
      pill.classList.toggle("off", !api.serverMode());
    }

    ["passenger-app", "driver-app", "admin-app"].forEach((id) => hide(id));
    try { history.replaceState(null, "", "#/"); } catch (e) { location.hash = "#/"; }
    if (user.role === "driver") {
      show("driver-app");
      global.Drv.init();
    } else if (user.role === "admin") {
      show("admin-app");
      global.Adm.init();
    } else {
      show("passenger-app");
      global.Pax.init();
    }
  }

  function logout() {
    const saved = api.loadSession();
    if (saved && saved.role) {
      sessionStorage.setItem(SESSION_KEY, saved.role);
    }
    api.clearSession();
    if (global.Pax && global.Pax.destroy) global.Pax.destroy();
    if (global.Drv && global.Drv.destroy) global.Drv.destroy();
    hide("app-shell");
    hide("notif-fab");
    hide("notif-panel");
    show("auth-screen");
    const lastRole = sessionStorage.getItem(SESSION_KEY);
    if (lastRole && ROLES[lastRole]) {
      go(lastRole + "/login");
    } else {
      go("");
    }
  }

  function boot() {
    window.addEventListener("hashchange", renderAuth);
    try {
      const isServer = api.serverMode();
      const foot = el("auth-foot");
      foot.textContent = isServer
        ? "Connected to iSafedrive server (LIVE mode)."
        : "Running in your browser.";
      foot.classList.toggle("live", isServer);
    } catch (e) { /* ignore */ }

    const saved = api.loadSession();
    if (saved && saved.id) {
      enterApp(saved);
      return;
    }
    setTimeout(() => {
      el("splash").classList.add("fade-out");
      show("auth-screen");
      const lastRole = sessionStorage.getItem(SESSION_KEY);
      if (lastRole && ROLES[lastRole]) {
        go(lastRole + "/login");
      } else {
        renderAuth();
      }
    }, 3000);
  }

  api.detect().catch(() => {}).then(boot);
})(window);
