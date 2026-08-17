/* iSafedrive — bootstrap + auth router (role-based directories) */
(function (global) {
  const U = global.U;
  const api = global.api;

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

    // Admin accounts are not self-registerable — hide the create-account tab.
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
    // Driver-only fields appear only on the driver register screen.
    el("reg-driver").classList.toggle("hidden", r.role !== "driver");
  }

  function go(route) {
    const target = "#/" + route;
    if (location.hash === target) { renderAuth(); return; }
    location.hash = target;
  }

  // Role cards -> per-role sign-in pages (hash directories).
  document.querySelectorAll(".role-card").forEach((c) => {
    c.onclick = () => go(c.dataset.role + "/login");
  });

  // Auth tabs toggle login <-> register for the current role directory.
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
    api.clearSession();
    if (global.Pax && global.Pax.destroy) global.Pax.destroy();
    if (global.Drv && global.Drv.destroy) global.Drv.destroy();
    hide("app-shell");
    show("auth-screen");
    go("");
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
      renderAuth();
    }, 3000);
  }

  api.detect().catch(() => {}).then(boot);
})(window);
