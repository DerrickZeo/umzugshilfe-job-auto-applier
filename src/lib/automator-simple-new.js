// src/lib/automator-simple.js
// Robust Umzugshilfe automator (single session, resilient selectors)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AUTH_STATE_PATH = path.resolve(process.cwd(), "auth.json");

function escapeRe(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
      baseUrl: "https://studenten-umzugshilfe.com", // matches your screenshots
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

    // land on home first (cheap) and check auth
    await this.page.goto(`${this.config.baseUrl}/`, {
      waitUntil: "domcontentloaded",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    // Open Meine Jobs through Meine Daten (your nav shows the link there)
    const ok = await this._openMeineJobsViaMeineDaten();
    if (!ok) throw new Error("Failed to open Meine Jobs after login");

    this.ready = true;
    this.isLoggedIn = true;
    this._startKeepAlive();
    console.log("✅ Browser automation ready");
  }

  /* --------------------------------- LOGIN --------------------------------- */

  async _ensureAuthenticated() {
    // If we see the login form, log in.
    if (
      await this.page
        .locator("form#tl_login_235, input#username")
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      console.log("🔐 Session expired — re-logging in…");
      await this._login();
    }
  }

  async _login() {
    console.log("🔐 Logging into Umzugshilfe...");
    await this.page.goto(`${this.config.baseUrl}/login`, {
      waitUntil: "domcontentloaded",
    });
    await this._dismissOverlays();

    await this.page.fill(
      'input#username, input[name="username"]',
      this.config.username
    );
    await this.page.fill(
      'input#password, input[name="password"]',
      this.config.password
    );
    await this._dismissOverlays();

    await Promise.all([
      // don't use networkidle (site may keep long connections); wait for nav or a post-login element
      this.page.waitForLoadState("domcontentloaded"),
      this.page.click('button[type="submit"], button:has-text("Anmelden")'),
    ]);

    // Wait until the post-login nav ("Meine Jobs") is present anywhere
    const navOk = await this.page
      .locator('a[href*="intern/meine-jobs"], a:has-text("Meine Jobs")')
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!navOk) {
      throw new Error("Login failed - check credentials");
    }

    // Save cookies for faster cold starts
    await this.context.storageState({ path: AUTH_STATE_PATH });
  }

  /* -------------------------- NAVIGATING TO THE LIST ----------------------- */

  // The “Meine Jobs” link is reliably visible on /intern/meine-daten (your screenshot).
  async _openMeineJobsViaMeineDaten() {
    // If we're already on the list and entries exist, done.
    if (this.page.url().includes("/intern/meine-jobs")) {
      const count = await this.page.locator("div.entry").count();
      if (count > 0) return true;
    }

    // Go to Meine Daten where the nav shows the link
    await this.page.goto(`${this.config.baseUrl}/intern/meine-daten`, {
      waitUntil: "domcontentloaded",
    });
    await this._dismissOverlays();
    await this._ensureAuthenticated();

    const jobsLink = this.page.locator('a[href*="intern/meine-jobs"]');
    const gotLink = await jobsLink
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!gotLink) return false;

    await this._dismissOverlays();

    await Promise.all([
      this.page.waitForLoadState("domcontentloaded"),
      jobsLink.first().click(),
    ]);

    // Wait for at least one entry; if missing, try one reload
    let ok = await this.page
      .locator("div.entry")
      .first()
      .isVisible()
      .catch(() => false);
    if (!ok) {
      console.log("⚠️ Meine Jobs elements not found yet, reloading once…");
      await this.page.reload({ waitUntil: "domcontentloaded" });
      ok = await this.page
        .locator("div.entry")
        .first()
        .isVisible()
        .catch(() => false);
    }
    return ok;
  }

  // Refresh list (used before each apply)
  async _refreshMeineJobs() {
    if (!this.page.url().includes("/intern/meine-jobs")) {
      const ok = await this._openMeineJobsViaMeineDaten();
      return ok;
    }
    await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this._dismissOverlays();
    await this._ensureAuthenticated();
    await this.page
      .locator("div.entry")
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    return (await this.page.locator("div.entry").count()) > 0;
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
    return await this._clickAccept(entry.first());
  }

  /* ------------------------ APPLY BY DATE/TIME/ZIP/CITY --------------------- */

  // date: "27.08.2025", time: "13:00" (or "9:00" – we’ll zero-pad), zip: "50670", city: "Köln"(optional)
  async applyToJobByDetails({ date, time, zip, city }) {
    // Normalize time (e.g., "9:00" -> "09:00")
    if (time) {
      const m = String(time).match(/^(\d{1,2}):(\d{2})$/);
      if (m) time = `${String(m[1]).padStart(2, "0")}:${m[2]}`;
    }

    const ok = await this._refreshMeineJobs();
    if (!ok) {
      console.log("⚠️ Could not load Meine Jobs");
      return false;
    }

    // Build the exact phrase you showed: “Am DD.MM.YYYY um HH:MM in 12345 City”
    // Use a regex to be robust to NBSP and tiny whitespace diffs.
    const re = new RegExp(
      `Am\\s+${escapeRe(date)}\\s+um\\s+${escapeRe(time)}\\s+in\\s+${escapeRe(
        zip
      )}(?:\\s+${escapeRe(city || "")})?`,
      "i"
    );

    // Prefer new/neu entries
    let entry = this.page
      .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
      .filter({
        has: this.page.locator("span.date.location", { hasText: re }),
      });

    if ((await entry.count()) === 0) {
      // Fallback: any entry, search by text content
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

    return await this._clickAccept(entry.first());
  }

  /* ------------------------------- CLICK ACCEPT ----------------------------- */

  async _clickAccept(entry) {
    // The button you highlighted: <button type="submit" id="ctrl_accept" ...>
    const submit = entry.locator(
      'form button#ctrl_accept, form button[name="accept"], form input[type="submit"][name="accept"]'
    );

    if ((await submit.count()) === 0) {
      console.log("⚠️ Accept button not found in entry");
      return false;
    }

    // Click and wait briefly for either navigation or in-place mutation
    await Promise.allSettled([
      this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }),
      submit.first().click(),
    ]);

    // Small settle; list usually changes in place
    await this.page.waitForTimeout(300);

    // If the entry disappeared, treat as success
    if ((await entry.count()) === 0) return true;

    // Or if status changed to waiting/accepted…
    const status = (await entry.first().getAttribute("data-status")) || "";
    if (/(waiting|wartend|accepted|pending)/i.test(status)) return true;

    // Some UIs draw a cancel/red-X once accepted
    const hasX = await entry
      .locator("button:has-text('x'), .btn.red, .accepted-state")
      .count();
    return hasX > 0;
  }

  // Kill cookie banners / consent modals / sticky overlays
  async _dismissOverlays() {
    try {
      // Common consent buttons (German): Akzeptieren / Verstanden / Zustimmen / OK
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
            .click({ timeout: 1000 })
            .catch(() => {});
          await this.page.waitForTimeout(150);
        }
      }

      // Close buttons
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
            .click({ timeout: 1000 })
            .catch(() => {});
          await this.page.waitForTimeout(150);
        }
      }

      // Fallback: remove overlay if it still blocks pointer events
      await this.page
        .evaluate(() => {
          const kill = (q) => document.querySelector(q)?.remove();
          kill("cms-accept-tags");
          const mod = document.querySelector(".mod_cms_accept_tags");
          if (mod) mod.remove();
          const cb = document.querySelector(
            "#cookiebar, .cookiebar, #cookie-bar, .cookie-bar"
          );
          if (cb) cb.remove();
          document.body.classList.remove("cookie-bar-visible");
        })
        .catch(() => {});
    } catch (_) {}
  }

  /* -------------------------------- UTILITIES ------------------------------- */

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
