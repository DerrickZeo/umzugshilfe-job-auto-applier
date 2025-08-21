// src/lib/automator-simple.js
// Fast, resilient Umzugshilfe automator (no fragile waitForNavigation on clicks)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const AUTH_STATE_PATH = path.resolve(process.cwd(), "auth.json");

class UmzugshilfeAutomator {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;

    this.isLoggedIn = false;
    this.ready = false;
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

    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          // Do NOT use --single-process on Windows; it’s crashy
        ],
      });

      await this._createContextAndPage(true);

      // First paint + auth check
      await this._safeGoto(`${this.config.baseUrl}/`);
      await this._ensureAuthenticated();

      // Open Meine Jobs with a safe, retrying flow
      const ok = await this._openMeineJobsWithRetry();
      if (!ok) throw new Error("Failed to open Meine Jobs after login");

      this.ready = true;
      console.log("✅ Browser automation ready");
    } catch (error) {
      console.error("❌ Failed to initialize automation:", error);
      await this.cleanup();
      throw error;
    }
  }

  /* --------------------------------- LOGIN --------------------------------- */

  async login() {
    console.log("🔐 Logging into Umzugshilfe...");
    await this._guardAlive();

    // Go to login (DOM ready is enough; SPA/site may not hit networkidle)
    await this._safeGoto(`${this.config.baseUrl}/login`);

    await this.page.fill(
      'input[name="username"], input#username',
      this.config.username
    );
    await this.page.fill(
      'input[name="password"], input#password',
      this.config.password
    );

    // Click submit; wait for either URL change (off /login) OR entries appearing
    await this.page
      .click(
        'button[type="submit"], button:has-text("Anmelden"), button:has-text("Login")'
      )
      .catch(() => {});

    // Give the app a moment to route; then verify we left /login
    await Promise.race([
      this.page
        .waitForURL((url) => !/\/login\b/i.test(String(url)), {
          timeout: this.config.timeout,
        })
        .catch(() => {}),
      this.page
        .waitForSelector("div.entry", { timeout: this.config.timeout })
        .catch(() => {}),
    ]);

    const stillOnLogin =
      this.page.url().includes("/login") ||
      !!(await this.page.$('input[name="username"], #username'));

    if (stillOnLogin) throw new Error("Login failed - check credentials");

    // Save cookies for quick restarts
    await this.context.storageState({ path: AUTH_STATE_PATH });

    // Confirm Meine Jobs opens
    const ok = await this._openMeineJobsWithRetry();
    if (!ok) throw new Error("Login ok, but Meine Jobs did not load");

    this.isLoggedIn = true;
    this._startKeepAlive();
    console.log("✅ Successfully logged in");
  }

  async _ensureAuthenticated() {
    await this._guardAlive();
    const atLogin =
      this.page.url().includes("/login") ||
      !!(await this.page.$('input[name="username"], #username'));
    if (atLogin) {
      console.log("🔐 Session expired — re-logging in…");
      await this.login();
    }
  }

  /* -------------------------- MEINE JOBS NAVIGATION ------------------------- */

  async _openMeineJobsWithRetry() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ok = await this.ensureMeineJobsOpen();
        if (ok) return true;
        throw new Error("Meine Jobs not loaded");
      } catch (e) {
        console.warn(
          `⚠️ ensureMeineJobsOpen attempt ${attempt} failed: ${e.message}`
        );
        await this._recreatePage(
          attempt === 1 /* resetContext on second run */
        );
        await this._safeGoto(`${this.config.baseUrl}/`);
        await this._ensureAuthenticated();
      }
    }
    return false;
  }

  // Open Meine Jobs like a human: click the nav link if present; otherwise direct URL.
  async ensureMeineJobsOpen() {
    await this._guardAlive();

    // If already there and entries exist, done
    if (this.page.url().includes("/intern/meine-jobs")) {
      const count = await this.page.locator("div.entry").count();
      if (count > 0) return true;
    }

    await this._safeGoto(`${this.config.baseUrl}/`);

    const jobsLink = this.page.getByRole("link", { name: /meine jobs/i });
    if ((await jobsLink.count()) > 0) {
      // Click; do NOT waitForNavigation (SPA or partial updates possible)
      await jobsLink
        .first()
        .click()
        .catch(() => {});
      await Promise.race([
        this.page
          .waitForURL(/\/intern\/meine-jobs/i, { timeout: 8000 })
          .catch(() => {}),
        this.page
          .waitForSelector("div.entry", { timeout: 8000 })
          .catch(() => {}),
      ]);
    } else {
      await this._safeGoto(`${this.config.baseUrl}/intern/meine-jobs`);
    }

    await this._ensureAuthenticated();

    // Wait for entries to exist (hydrate)
    await this.page
      .waitForSelector("div.entry", { timeout: 8000 })
      .catch(() => {});
    let cnt = await this.page.locator("div.entry").count();
    if (cnt > 0) return true;

    // Last resort: reload once
    await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page
      .waitForSelector("div.entry", { timeout: 8000 })
      .catch(() => {});
    cnt = await this.page.locator("div.entry").count();
    return cnt > 0;
  }

  // Use before acting so we always see the freshest state
  async goToMeineJobs() {
    await this._ensureAuthenticated();

    if (this.page.url().includes("/intern/meine-jobs")) {
      await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await this._ensureAuthenticated();
    } else {
      const ok = await this.ensureMeineJobsOpen();
      if (!ok) return false;
    }

    await this.page
      .waitForSelector("div.entry", { timeout: 8000 })
      .catch(() => {});
    const total = await this.page.locator("div.entry").count();
    const fresh = await this.page
      .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
      .count();
    console.log(
      `📄 Page loaded with ${total} total entries, ${fresh} new entries`
    );
    return total > 0;
  }

  /* ------------------------------ APPLY LOGIC ------------------------------- */

  async applyToJob(jobId) {
    const ok = await this.goToMeineJobs();
    if (!ok) return false;

    const entry = this.page
      .locator("div.entry")
      .filter({ hasText: `#${jobId}` });
    if ((await entry.count()) === 0) {
      console.log(`⚠️ Job #${jobId} not present on Meine Jobs`);
      return false;
    }
    return await this._submitAcceptInEntry(entry.first());
  }

  // date "DD.MM.YYYY", time "HH:MM", zip "12345", city optional
  async applyToJobByDetails({ date, time, zip, city }) {
    const ok = await this.goToMeineJobs();
    if (!ok)
      console.log("⚠️ Page elements not found after reload, continuing…");

    const norm = (s) =>
      s
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const needle = norm(`Am ${date} um ${time} in ${zip}`);

    // Prefer entries in NEW/NEU state and match inside the date/location span
    let entry = this.page
      .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
      .filter({
        has: this.page.locator("span.date.location"),
        hasText: needle,
      });

    if ((await entry.count()) === 0) {
      // Fallback: match anywhere inside the entry
      entry = this.page
        .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
        .filter({ hasText: needle });

      if ((await entry.count()) === 0) {
        console.log(`❌ No row found for: ${needle}${city ? " " + city : ""}`);
        return false;
      }
    }

    return await this._submitAcceptInEntry(entry.first());
  }

  async _submitAcceptInEntry(entry) {
    const form = entry.locator("form");
    const submit = form.locator(
      '#ctrl_accept, button[name="accept"], input[type="submit"][name="accept"]'
    );

    if ((await submit.count()) === 0) {
      console.log("⚠️ Accept submit not found in entry");
      return false;
    }

    // Click immediately; then wait for either URL change OR list mutation
    await submit
      .first()
      .click()
      .catch(() => {});
    await Promise.race([
      this.page
        .waitForURL((url) => /\/intern\/meine-jobs/i.test(String(url)), {
          timeout: 8000,
        })
        .catch(() => {}),
      this.page.waitForTimeout(500), // small settle
    ]);

    // If the entry disappeared, success
    if ((await entry.count()) === 0) return true;

    // Check for status flip or "red X"
    const statusAfter = (await entry.first().getAttribute("data-status")) || "";
    if (/(waiting|wartend|accepted|pending)/i.test(statusAfter)) return true;

    const hasX = await entry
      .locator("button:has-text('x'), .btn.red, .accepted-state")
      .count();
    if (hasX > 0) return true;

    // Final verification: reload and re-check
    await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page
      .waitForSelector("div.entry", { timeout: 6000 })
      .catch(() => {});
    const stillThere = await entry.count();
    if (!stillThere) return true;
    const statusReload =
      (await entry.first().getAttribute("data-status")) || "";
    return /(waiting|wartend|accepted|pending)/i.test(statusReload);
  }

  /* ------------------------------ UTILITIES -------------------------------- */

  async _safeGoto(url) {
    await this._guardAlive();
    try {
      // 'domcontentloaded' avoids long hangs on 'networkidle' for SPAs
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.timeout,
      });
    } catch (_) {
      // Try once more with a lighter wait
      try {
        await this.page.goto(url, {
          waitUntil: "load",
          timeout: this.config.timeout,
        });
      } catch {}
    }
  }

  async blockNonEssentialRequests() {
    await this.page.route("**/*", (route) => {
      const type = route.request().resourceType();
      // Keep stylesheets; blocking can break clickable areas
      if (["image", "font", "media"].includes(type)) return route.abort();
      route.continue();
    });
  }

  _startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    const interval = Math.max(2, this.config.keepAliveMinutes) * 60 * 1000;

    this.keepAliveTimer = setInterval(async () => {
      try {
        if (!this._pageAlive()) return;
        await this.page.evaluate(async () => {
          try {
            await fetch("/intern/meine-daten", {
              method: "HEAD",
              credentials: "include",
            });
          } catch (_) {}
        });
      } catch {}
    }, interval);
  }

  _setupCrashDiagnostics() {
    try {
      this.browser.on("disconnected", () =>
        console.error("❌ Browser disconnected")
      );
      this.context?.on?.("close", () => console.error("❌ Context closed"));
      this.page?.on?.("close", () => console.error("❌ Page closed"));
    } catch {}
  }

  _pageAlive() {
    return this.page && !this.page.isClosed();
  }

  async _guardAlive() {
    if (!this._pageAlive()) await this._recreatePage(false);
  }

  async _createContextAndPage(preferAuthState = false) {
    const ctxOptions =
      preferAuthState && fs.existsSync(AUTH_STATE_PATH)
        ? { storageState: AUTH_STATE_PATH }
        : {};
    this.context = await this.browser.newContext(ctxOptions);
    this.page = await this.context.newPage({
      viewport: { width: 1280, height: 720 },
    });
    await this.blockNonEssentialRequests();
    this.page.setDefaultTimeout(this.config.timeout);
    this._setupCrashDiagnostics();
  }

  async _recreatePage(resetContext = false) {
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
    } catch {}
    if (resetContext && this.context) {
      try {
        await this.context.close();
      } catch {}
      this.context = null;
    }
    if (!this.context) {
      const ctxOptions = fs.existsSync(AUTH_STATE_PATH)
        ? { storageState: AUTH_STATE_PATH }
        : {};
      this.context = await this.browser.newContext(ctxOptions);
    }
    this.page = await this.context.newPage({
      viewport: { width: 1280, height: 720 },
    });
    await this.blockNonEssentialRequests();
    this.page.setDefaultTimeout(this.config.timeout);
    this._setupCrashDiagnostics();
  }

  async _maybeScreenshot(tag) {
    if (process.env.DEBUG_MODE === "true") {
      try {
        await this.page.screenshot({
          path: `debug-${tag}-${Date.now()}.png`,
          fullPage: true,
        });
      } catch {}
    }
  }

  /* ------------------------------- LIFECYCLE -------------------------------- */

  async cleanup() {
    console.log("🧹 Cleaning up browser automation...");
    try {
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.ready = false;
      this.isLoggedIn = false;
      console.log("✅ Browser cleanup completed");
    } catch (error) {
      console.error("❌ Error during cleanup:", error);
    }
  }

  isReady() {
    return this.ready && this.isLoggedIn;
  }

  async healthCheck() {
    if (!this.ready || !this._pageAlive()) return false;
    try {
      return await this.page.evaluate(() => document.readyState === "complete");
    } catch {
      return false;
    }
  }
}

module.exports = { UmzugshilfeAutomator };
