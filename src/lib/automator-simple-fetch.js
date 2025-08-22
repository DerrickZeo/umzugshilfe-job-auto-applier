// src/lib/automator-simple.js
// Ultra-fast Umzugshilfe automator: soft refresh + fetch-based apply + programmatic login

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AUTH_STATE_PATH = path.resolve(process.cwd(), "auth.json");
const escapeRe = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class UmzugshilfeAutomator {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.ready = false;
    this.isLoggedIn = false;
    this.keepAliveTimer = null;

    this.config = {
      username: process.env.LOGIN_USERNAME,
      password: process.env.LOGIN_PASSWORD,
      baseUrl: "https://studenten-umzugshilfe.com",
      headless: process.env.NODE_ENV === "production",
      timeout: 25000,
      keepAliveMinutes: 4,
    };
  }

  /* ---------------------------------- BOOT --------------------------------- */

  async initialize() {
    console.log("🤖 Initializing browser automation...");
    if (!this.config.username || !this.config.password) {
      throw new Error("LOGIN_USERNAME and LOGIN_PASSWORD must be configured");
    }

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
      ],
    });

    const ctxOptions = fs.existsSync(AUTH_STATE_PATH)
      ? { storageState: AUTH_STATE_PATH }
      : {};
    this.context = await this.browser.newContext(ctxOptions);
    this.page = await this.context.newPage({
      viewport: { width: 1280, height: 800 },
    });
    this.page.setDefaultTimeout(this.config.timeout);
    await this._blockNonEssentialRequests();

    // Land home, clear overlays, ensure auth
    await this.page.goto(`${this.config.baseUrl}/`, {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    // Open Meine Jobs through Meine Daten (as per site nav)
    const ok = await this._openMeineJobsViaMeineDaten();
    if (!ok) throw new Error("Failed to open Meine Jobs after login");

    this.ready = true;
    this.isLoggedIn = true;
    this._startKeepAlive();
    console.log("✅ Browser automation ready");
  }

  /* --------------------------------- LOGIN --------------------------------- */

  async _ensureAuthenticated() {
    const atLogin =
      this.page.url().includes("/login") ||
      (await this.page
        .locator('input[name="username"], #username')
        .first()
        .isVisible()
        .catch(() => false));
    if (atLogin) {
      console.log("🔐 Session expired — re-logging in…");
      await this._login();
    }
  }

  async _login() {
    console.log("🔐 Logging into Umzugshilfe...");

    await this.page.goto(`${this.config.baseUrl}/login`, {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();

    await this.page.fill(
      'input[name="username"], #username',
      this.config.username
    );
    await this.page.fill(
      'input[name="password"], #password',
      this.config.password
    );

    // Kill overlays that intercept pointer events
    await this.page.evaluate(() => {
      const killers = [
        "cms-accept-tags",
        ".mod_cms_accept_tags",
        ".cookiebar",
        ".mod_cookiebar",
      ];
      for (const sel of killers)
        document.querySelectorAll(sel).forEach((el) => el.remove());
      document.body.classList.remove("cookie-bar-visible");
    });

    // Programmatic submit (fast & reliable)
    await this.page.evaluate(() => {
      const form =
        document.querySelector('form[id^="tl_login_"]') ||
        document.querySelector('form[action*="/login"]') ||
        document.querySelector("form");
      if (!form) throw new Error("Login form not found");
      const btn = form.querySelector(
        'button[type="submit"], input[type="submit"]'
      );
      if (form.requestSubmit) form.requestSubmit(btn || undefined);
      else form.submit();
    });

    // Wait for URL change or lightweight navigation
    const ok = await Promise.race([
      this.page
        .waitForURL(/\/intern\/(meine-(daten|jobs))/, { timeout: 8000 })
        .then(() => true)
        .catch(() => false),
      this.page
        .waitForNavigation({ waitUntil: "networkidle", timeout: 8000 })
        .then(() => true)
        .catch(() => false),
    ]);

    if (!ok || this.page.url().includes("/login")) {
      // Retry once in case of CSRF rotation/lag
      await this.page.waitForTimeout(250);
      await this.page.evaluate(() => {
        const form =
          document.querySelector('form[id^="tl_login_"]') ||
          document.querySelector('form[action*="/login"]') ||
          document.querySelector("form");
        if (!form) throw new Error("Login form not found (retry)");
        const btn = form.querySelector(
          'button[type="submit"], input[type="submit"]'
        );
        if (form.requestSubmit) form.requestSubmit(btn || undefined);
        else form.submit();
      });
      const ok2 = await Promise.race([
        this.page
          .waitForURL(/\/intern\/(meine-(daten|jobs))/, { timeout: 8000 })
          .then(() => true)
          .catch(() => false),
        this.page
          .waitForNavigation({ waitUntil: "networkidle", timeout: 8000 })
          .then(() => true)
          .catch(() => false),
      ]);
      if (!ok2 || this.page.url().includes("/login")) {
        throw new Error("Login failed - still on /login after submit");
      }
    }

    // Persist cookies for warm restarts
    await this.context.storageState({ path: AUTH_STATE_PATH });
    this.isLoggedIn = true;
    this._startKeepAlive();
    console.log("✅ Logged in (bot submission)");
  }

  /* -------------------------- NAVIGATING TO THE LIST ----------------------- */

  async _openMeineJobsViaMeineDaten() {
    if (this.page.url().includes("/intern/meine-jobs")) {
      const found = await this._hasJobsInLiveDOM();
      if (found) return true;
    }

    await this.page.goto(`${this.config.baseUrl}/intern/meine-daten`, {
      waitUntil: "networkidle",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    const link = this.page.locator('a[href*="intern/meine-jobs"]');
    const hasLink = await link
      .first()
      .isVisible()
      .catch(() => false);

    if (hasLink) {
      await Promise.allSettled([
        this.page.waitForURL(/\/intern\/meine-jobs/, { timeout: 10000 }),
        this.page.waitForLoadState("networkidle", { timeout: 10000 }),
        link.first().click(),
      ]);
    } else {
      await this.page.goto(`${this.config.baseUrl}/intern/meine-jobs`, {
        waitUntil: "networkidle",
      });
    }

    await this._dismissOverlays();
    await this._ensureAuthenticated();

    // Wait for any of the stable markers to appear (not just div.entry)
    await this.page
      .waitForSelector(
        "span.date.location, div.entry, form button#ctrl_accept",
        { timeout: 8000 }
      )
      .catch(() => {});

    // Treat as OK if either the live DOM has rows OR the soft-refresh shows rows
    const liveOk = await this._hasJobsInLiveDOM();
    if (liveOk) return true;

    // One quick reload if still empty
    console.log("⚠️ Meine Jobs elements not found yet, reloading once…");
    await this.page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    return await this._hasJobsInLiveDOM(true);
  }

  async _hasJobsInLiveDOM(trySoft = false) {
    const liveCount = await this.page.locator("span.date.location").count();
    if (liveCount > 0) return true;

    // Some pages mark each row with div.entry — keep as secondary
    const entryCount = await this.page.locator("div.entry").count();
    if (entryCount > 0) return true;

    // If requested, check the fresh HTML quickly (no reload)
    if (trySoft) {
      try {
        const rows = await this._softRefreshJobsInPage();
        return rows && rows.length > 0;
      } catch (_) {}
    }
    return false;
  }

  /* ------------------------------ SOFT REFRESH ------------------------------ */

  // Pull fresh Meine Jobs HTML without reloading; returns parsed rows
  async _softRefreshJobsInPage() {
    return await this.page.evaluate(async () => {
      const r = await fetch("/intern/meine-jobs", { credentials: "include" });
      if (!r.ok) return [];
      const html = await r.text();
      const d = new DOMParser().parseFromString(html, "text/html");
      return [...d.querySelectorAll("div.entry")].map((el) => ({
        text: el.querySelector(".date.location")?.textContent?.trim() || "",
        status: el.getAttribute("data-status") || "",
        id: (el.textContent || "").match(/#\s?(\d{4,7})/)?.[1] || null,
      }));
    });
  }

  // Prefer soft refresh; fallback to real reload only if needed
  async _refreshMeineJobs() {
    if (!this.page.url().includes("/intern/meine-jobs")) {
      const ok = await this._openMeineJobsViaMeineDaten();
      return ok;
    }
    try {
      const rows = await this._softRefreshJobsInPage();
      if (rows && rows.length) return true;
    } catch {}
    await this.page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await this._dismissOverlays();
    await this._ensureAuthenticated();
    await this.page
      .locator("div.entry")
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    return (await this.page.locator("div.entry").count()) > 0;
  }

  /* ------------------ DIRECT APPLY FROM FRESH HTML (FAST) ------------------- */

  // Apply directly from freshly-fetched HTML (handles jobs not yet visible in live DOM)
  async _applyDirectFromFreshHTML({ date, time, zip, city }) {
    const cityPart = city ? `\\s+${escapeRe(city)}` : "(?:\\s+\\S+)?";
    const needle = `Am\\s+${escapeRe(date)}\\s+um\\s+${escapeRe(
      time
    )}\\s+in\\s+${escapeRe(zip)}${cityPart}`;

    const res = await this.page.evaluate(async (needleSource) => {
      const re = new RegExp(needleSource, "i");
      const resp = await fetch("/intern/meine-jobs", {
        credentials: "include",
      });
      if (!resp.ok) return { ok: false, why: `fetch list ${resp.status}` };
      const html = await resp.text();

      const doc = new DOMParser().parseFromString(html, "text/html");
      const entries = [...doc.querySelectorAll("div.entry")];
      const match = entries.find((el) =>
        re.test(el.querySelector("span.date.location")?.textContent || "")
      );
      if (!match) return { ok: false, why: "not_found" };

      const form = match.querySelector("form");
      if (!form) return { ok: false, why: "no_form" };

      const fd = new FormData(form);
      const acceptBtn = form.querySelector('#ctrl_accept,[name="accept"]');
      if (acceptBtn && acceptBtn.name)
        fd.set(acceptBtn.name, acceptBtn.value || "1");

      const action = form.getAttribute("action") || location.href;
      const method = (form.getAttribute("method") || "POST").toUpperCase();

      const post = await fetch(action, {
        method,
        body: fd,
        credentials: "include",
        redirect: "follow",
      });
      const text = await post.text(); // optional debugging
      return { ok: post.ok, status: post.status, text };
    }, needle);

    if (!res.ok) {
      console.log(
        "❌ _applyDirectFromFreshHTML failed:",
        res.why || res.status
      );
      return false;
    }
    // Cheap sync so the live page reflects change
    try {
      await this._softRefreshJobsInPage();
    } catch {}
    return true;
  }

  /* ------------------------------ APPLY BY ID ------------------------------- */

  async applyToJob(jobId) {
    const ok = await this._refreshMeineJobs();
    if (!ok) {
      console.log("⚠️ Could not load Meine Jobs");
      return false;
    }
    const entry = this.page
      .locator("div.entry")
      .filter({ hasText: `#${jobId}` });
    if ((await entry.count()) === 0) {
      console.log(`⚠️ Job #${jobId} not present on Meine Jobs`);
      return false;
    }
    return await this._applyViaFormFetch(entry.first());
  }

  /* ------------------------ APPLY BY DATE/TIME/ZIP/CITY --------------------- */

  async applyToJobByDetails({ date, time, zip, city }) {
    // Normalize time to HH:MM
    const m = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
    if (m) time = `${String(m[1]).padStart(2, "0")}:${m[2]}`;

    // 1) Try direct-from-fresh-HTML first (handles items not rendered yet)
    let ok = await this._applyDirectFromFreshHTML({ date, time, zip, city });
    if (ok) return true;

    // 2) Fall back to using the live DOM list
    ok = await this._refreshMeineJobs();
    if (!ok) return false;

    const re = new RegExp(
      `Am\\s+${escapeRe(date)}\\s+um\\s+${escapeRe(time)}\\s+in\\s+${escapeRe(
        zip
      )}${city ? `\\s+${escapeRe(city)}` : ""}`,
      "i"
    );

    let entry = this.page
      .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
      .filter({
        has: this.page.locator("span.date.location", { hasText: re }),
      });

    if ((await entry.count()) === 0) {
      entry = this.page.locator("div.entry").filter({
        has: this.page.locator("span.date.location", { hasText: re }),
      });
      if ((await entry.count()) === 0) {
        console.log(
          `❌ No row found for: Am ${date} um ${time} in ${zip}${
            city ? " " + city : ""
          }`
        );
        return false;
      }
    }
    return await this._applyViaFormFetch(entry.first());
  }

  /* -------------------------- FETCH-BASED FORM SUBMIT ----------------------- */

  async _applyViaFormFetch(entry) {
    const res = await entry.evaluate(async (node) => {
      const form = node.querySelector("form");
      if (!form) return { ok: false, why: "no form" };

      const fd = new FormData(form); // includes CSRF + hidden inputs
      const acceptBtn = form.querySelector('#ctrl_accept,[name="accept"]');
      if (acceptBtn && acceptBtn.name)
        fd.set(acceptBtn.name, acceptBtn.value || "1");

      const action = form.getAttribute("action") || location.href;
      const method = (form.getAttribute("method") || "POST").toUpperCase();

      const r = await fetch(action, {
        method,
        body: fd,
        credentials: "include",
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    });

    if (!res.ok) {
      console.log("❌ Accept fetch failed:", res.status, res.why || "");
      return false;
    }

    // Let the DOM mutate if it does in-place updates
    await this.page.waitForTimeout(150);

    if ((await entry.count()) === 0) return true;
    const statusAfter = (await entry.first().getAttribute("data-status")) || "";
    if (/(waiting|wartend|accepted|pending)/i.test(statusAfter)) return true;
    const hasX = await entry
      .locator("button:has-text('x'), .btn.red, .accepted-state")
      .count();
    return hasX > 0;
  }

  /* ------------------------------ UTILITIES -------------------------------- */

  async _dismissOverlays() {
    try {
      const candidates = [
        'cms-accept-tags button:has-text("Akzeptieren")',
        'cms-accept-tags button:has-text("Verstanden")',
        'cms-accept-tags button:has-text("Zustimmen")',
        'cms-accept-tags button:has-text("OK")',
        '.cookiebar button:has-text("OK")',
        '#cookiebar button:has-text("OK")',
        'button:has-text("Alle akzeptieren")',
        'button[aria-label="Akzeptieren"]',
      ];
      for (const sel of candidates) {
        const btn = this.page.locator(sel);
        if (await btn.count()) {
          await btn
            .first()
            .click({ timeout: 800 })
            .catch(() => {});
          await this.page.waitForTimeout(120);
        }
      }
      const closers = [
        'cms-accept-tags [aria-label="Schließen"]',
        "cms-accept-tags .close",
        ".cookiebar .close",
      ];
      for (const sel of closers) {
        const x = this.page.locator(sel);
        if (await x.count()) {
          await x
            .first()
            .click({ timeout: 800 })
            .catch(() => {});
          await this.page.waitForTimeout(120);
        }
      }
      await this.page
        .evaluate(() => {
          const kill = (q) => document.querySelector(q)?.remove();
          kill("cms-accept-tags");
          document
            .querySelectorAll(".mod_cms_accept_tags")
            .forEach((n) => n.remove());
          const cb = document.querySelector(
            "#cookiebar, .cookiebar, #cookie-bar, .cookie-bar"
          );
          if (cb) cb.remove();
          document.body.classList.remove("cookie-bar-visible");
        })
        .catch(() => {});
    } catch {}
  }

  async _blockNonEssentialRequests() {
    await this.page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) return route.abort();
      route.continue();
    });
  }

  _startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    const every = Math.max(2, this.config.keepAliveMinutes) * 60 * 1000;
    this.keepAliveTimer = setInterval(async () => {
      try {
        if (!this.page) return;
        await this.page.evaluate(async () => {
          try {
            await fetch("/intern/meine-daten", {
              method: "HEAD",
              credentials: "include",
            });
          } catch (_) {}
        });
      } catch (_) {}
    }, every);
  }

  async cleanup() {
    try {
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch {}
    this.ready = false;
    this.isLoggedIn = false;
    console.log("✅ Browser cleanup completed");
  }

  isReady() {
    return this.ready && this.isLoggedIn;
  }

  async healthCheck() {
    if (!this.ready || !this.page) return false;
    try {
      return await this.page.evaluate(() => document.readyState === "complete");
    } catch {
      return false;
    }
  }
}

module.exports = { UmzugshilfeAutomator };
