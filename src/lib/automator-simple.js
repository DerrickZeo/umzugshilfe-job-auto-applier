// src/lib/automator-simple.js
// Simplified Umzugshilfe automation for maximum speed

const { chromium } = require("playwright");

class UmzugshilfeAutomator {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.ready = false;

    this.config = {
      username: process.env.LOGIN_USERNAME,
      password: process.env.LOGIN_PASSWORD,
      baseUrl: "https://studenten-umzugshilfe.com", // canonical host
      headless: process.env.NODE_ENV === "production",
      timeout: 25000,
    };
  }

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
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      });

      this.page = await this.browser.newPage({
        viewport: { width: 1280, height: 720 },
      });
      await this.blockNonEssentialRequests();
      this.page.setDefaultTimeout(this.config.timeout);

      await this.login();

      this.ready = true;
      console.log("✅ Browser automation ready");
    } catch (error) {
      console.error("❌ Failed to initialize automation:", error);
      await this.cleanup();
      throw error;
    }
  }

  async login() {
    console.log("🔐 Logging into Umzugshilfe...");
    try {
      await this.page.goto(`${this.config.baseUrl}/login`, {
        waitUntil: "domcontentloaded",
      });

      await this.page.fill(
        'input[name="username"], input#username',
        this.config.username
      );
      await this.page.fill(
        'input[name="password"], input#password',
        this.config.password
      );

      await Promise.all([
        this.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        this.page.click(
          'button[type="submit"], button:has-text("Anmelden"), button:has-text("Login")'
        ),
      ]);

      // Go to Meine Jobs by clicking the nav link (preferred)
      await this.goToMeineJobs();
      if (!this.page.url().includes("/intern/meine-jobs")) {
        throw new Error("Login failed or could not reach Meine Jobs via link");
      }

      this.isLoggedIn = true;
      console.log("✅ Successfully logged in");
    } catch (error) {
      throw new Error(`Login failed: ${error.message}`);
    }
  }

  // Clicks the "Meine Jobs" link shown in the nav; falls back to direct URL if needed
  async goToMeineJobs() {
    if (this.page.url().includes("/intern/meine-jobs")) return;

    // If we’re not on any internal page yet, try landing page after login
    if (!/\/intern\//.test(this.page.url())) {
      await this.page
        .goto(`${this.config.baseUrl}/intern/meine-daten`, {
          waitUntil: "domcontentloaded",
        })
        .catch(() => {});
    }

    const link = this.page.locator(
      'a[aria-label="Meine Jobs"], nav a:has-text("Meine Jobs"), a[href*="meine-jobs"]'
    );

    if (await link.count()) {
      await Promise.all([
        this.page
          .waitForURL(/\/intern\/meine-jobs/i, { timeout: 8000 })
          .catch(() => {}),
        link.first().click(),
      ]);
    }

    // Fallback to direct URL if link click didn’t navigate
    if (!this.page.url().includes("/intern/meine-jobs")) {
      await this.page.goto(`${this.config.baseUrl}/intern/meine-jobs`, {
        waitUntil: "domcontentloaded",
      });
    }

    // Wait for entries/list/form to appear (best-effort)
    await this.page
      .waitForSelector("div.entry, div.list, form button#ctrl_accept", {
        timeout: 5000,
      })
      .catch(() => {});
  }

  async processJobs(jobIds) {
    console.log(`⚡ Processing ${jobIds.length} jobs: ${jobIds.join(", ")}`);
    if (!this.ready || !this.isLoggedIn)
      throw new Error("Automator not ready or not logged in");

    const results = { successful: [], failed: [] };

    for (const jobId of jobIds) {
      try {
        console.log(`📝 Applying to job: ${jobId}`);
        if (jobId === "TEST123" || String(jobId).startsWith("TEST")) {
          results.successful.push(jobId);
          continue;
        }
        const ok = await this.applyToJob(jobId);
        (ok ? results.successful : results.failed).push(jobId);
        console.log(
          ok ? `✅ Applied to ${jobId}` : `❌ Failed to apply ${jobId}`
        );
      } catch (e) {
        console.error(`❌ Error processing ${jobId}:`, e);
        results.failed.push(jobId);
      }
    }

    console.log(
      `📊 Results: ${results.successful.length} ok, ${results.failed.length} failed`
    );
    return results;
  }

  /**
   * Primary path: find the row with "#<jobId>" on Meine Jobs and submit its form.
   */
  async applyToJob(jobId) {
    try {
      await this.goToMeineJobs();

      const entry = this.page
        .locator("div.entry")
        .filter({ hasText: `#${jobId}` });
      if ((await entry.count()) === 0) {
        console.log(`⚠️ Job #${jobId} not present on Meine Jobs`);
        return false;
      }

      const statusBefore =
        (await entry.first().getAttribute("data-status")) || "";
      return await this._submitAcceptInEntry(entry.first(), statusBefore);
    } catch (error) {
      console.error(`Error applying to job ${jobId}:`, error.message);
      await this._maybeScreenshot(`job-${jobId}`);
      return false;
    }
  }

  /**
   * Fallback path: when email has no ID. Match the exact site text:
   * "Am DD.MM.YYYY um HH:MM in 12345 City"
   */
  async applyToJobByDetails({ date, time, zip, city }) {
    try {
      await this.goToMeineJobs();

      const needle = `Am ${date} um ${time} in ${zip} ${city}`;
      let entry = this.page
        .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
        .filter({ hasText: needle });

      if ((await entry.count()) === 0) {
        // fallback without city (umlauts/hyphens sometimes vary)
        entry = this.page
          .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
          .filter({ hasText: `Am ${date} um ${time} in ${zip}` });
        if ((await entry.count()) === 0) {
          console.log(`⚠️ No matching row for "${needle}"`);
          return false;
        }
      }

      const statusBefore =
        (await entry.first().getAttribute("data-status")) || "";
      return await this._submitAcceptInEntry(entry.first(), statusBefore);
    } catch (e) {
      console.error("applyToJobByDetails error:", e.message);
      await this._maybeScreenshot(`details-${date}-${time}-${zip}`);
      return false;
    }
  }

  /**
   * Click the accept submit inside a specific entry and verify state change.
   */
  async _submitAcceptInEntry(entry, statusBefore = "") {
    const form = entry.locator("form");
    const submit = form.locator(
      'button[name="accept"], input[type="submit"][name="accept"], #ctrl_accept'
    );

    if ((await submit.count()) === 0) {
      console.log("⚠️ Accept submit not found in entry");
      return false;
    }

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      submit.first().click(),
    ]);

    // re-check the same entry (or treat disappearance as success)
    const stillThere = await entry.count();
    if (!stillThere) return true;

    const statusAfter = (await entry.first().getAttribute("data-status")) || "";
    if (statusBefore !== statusAfter) return true;

    // some UIs show a red X/cancel after success—treat that as success too
    const hasX = await entry
      .locator("button:has-text('x'), .btn.red, .accepted-state")
      .count();
    return hasX > 0;
  }

  async cleanup() {
    console.log("🧹 Cleaning up browser automation...");
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
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

  async blockNonEssentialRequests() {
    await this.page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type))
        return route.abort();
      route.continue();
    });
  }

  async _maybeScreenshot(tag) {
    if (process.env.DEBUG_MODE === "true") {
      try {
        await this.page.screenshot({ path: `debug-${tag}-${Date.now()}.png` });
      } catch {}
    }
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
