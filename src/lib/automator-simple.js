// automator-simple.js - SIMPLIFIED: Remove all ID-based processing

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
      baseUrl: "https://studenten-umzugshilfe.com",
      headless: process.env.NODE_ENV === "production",
      timeout: 30000,
    };
  }

  async initialize() {
    console.log("🤖 Initializing browser automation...");

    if (!this.config.username || !this.config.password) {
      throw new Error("LOGIN_USERNAME and LOGIN_PASSWORD must be configured");
    }

    try {
      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ];

      if (process.platform !== "win32") {
        launchArgs.push("--no-zygote", "--single-process");
      }

      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: launchArgs,
        timeout: 60000,
      });

      this.page = await this.browser.newPage({
        viewport: { width: 1280, height: 720 },
      });

      this.page.setDefaultTimeout(this.config.timeout);

      this.page.on("crash", () => {
        console.error("❌ Page crashed during initialization");
      });

      this.page.on("error", (error) => {
        console.error("❌ Page error:", error.message);
      });

      await this.blockNonEssentialRequests();
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
        timeout: this.config.timeout,
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
        this.page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: this.config.timeout,
        }),
        this.page.click(
          'button[type="submit"], button:has-text("Anmelden"), button:has-text("Login")'
        ),
      ]);

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

  async goToMeineJobs() {
    try {
      if (this.page.url().includes("/intern/meine-jobs")) {
        await this.page.reload({
          waitUntil: "domcontentloaded",
          timeout: this.config.timeout,
        });

        await this.page
          .waitForSelector("div.entry, div.list, form button#ctrl_accept", {
            timeout: 10000,
          })
          .catch(() => {
            console.warn(
              "⚠️ Page elements not found after reload, but continuing..."
            );
          });

        const entryCount = await this.page.locator("div.entry").count();
        console.log(`📊 Current page has ${entryCount} job entries`);
        return;
      }

      if (!/\/intern\//.test(this.page.url())) {
        await this.page
          .goto(`${this.config.baseUrl}/intern/meine-daten`, {
            waitUntil: "domcontentloaded",
            timeout: this.config.timeout,
          })
          .catch(() => {
            console.warn(
              "⚠️ Failed to navigate to meine-daten, trying direct approach..."
            );
          });
      }

      if (!this.page || this.page.isClosed()) {
        throw new Error("Page or browser was closed unexpectedly");
      }

      const link = this.page.locator(
        'a[aria-label="Meine Jobs"], nav a:has-text("Meine Jobs"), a[href*="meine-jobs"]'
      );

      const linkCount = await link.count().catch(() => 0);
      console.log(`🔗 Found ${linkCount} "Meine Jobs" links`);

      if (linkCount > 0) {
        console.log("🖱️ Clicking Meine Jobs link...");

        try {
          await Promise.race([
            this.page.waitForURL(/\/intern\/meine-jobs/i, { timeout: 15000 }),
            link.first().click({ timeout: 10000 }),
          ]);
          console.log("✅ Successfully clicked Meine Jobs link");
        } catch (clickError) {
          console.warn(
            "⚠️ Click failed, trying direct navigation...",
            clickError.message
          );
          await this.page.goto(`${this.config.baseUrl}/intern/meine-jobs`, {
            waitUntil: "domcontentloaded",
            timeout: this.config.timeout,
          });
        }
      } else {
        console.log("🔄 No link found, navigating directly to Meine Jobs");
        await this.page.goto(`${this.config.baseUrl}/intern/meine-jobs`, {
          waitUntil: "domcontentloaded",
          timeout: this.config.timeout,
        });
      }

      try {
        await this.page.waitForSelector(
          "div.entry, div.list, form button#ctrl_accept",
          { timeout: 10000 }
        );
        console.log("✅ Meine Jobs page loaded successfully");

        const entryCount = await this.page.locator("div.entry").count();
        const newEntryCount = await this.page
          .locator('div.entry[data-status="new"], div.entry[data-status="neu"]')
          .count();
        console.log(
          `📊 Page loaded with ${entryCount} total entries, ${newEntryCount} new entries`
        );
      } catch (timeoutError) {
        console.warn("⚠️ Timeout waiting for page elements, but continuing...");
      }
    } catch (error) {
      console.error("❌ Error in goToMeineJobs:", error.message);
      throw error;
    }
  }

  // inside class
  _escapeRegExp(s = "") {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async _findEntryByLine({ date, time, zip, city }) {
    const d = this._escapeRegExp(date);
    const t = this._escapeRegExp(time);
    const z = this._escapeRegExp(zip);
    const c = city ? this._escapeRegExp(city).replace(/\s+/g, "\\s+") : null;

    // tolerate optional “Uhr” and flexible spacing in city
    const rx = c
      ? new RegExp(
          `\\bAm\\s+${d}\\s+um\\s+${t}(?:\\s+Uhr)?\\s+in\\s+${z}\\s+${c}\\b`,
          "i"
        )
      : new RegExp(
          `\\bAm\\s+${d}\\s+um\\s+${t}(?:\\s+Uhr)?\\s+in\\s+${z}\\b`,
          "i"
        );

    // Prefer fresh jobs
    const scopeNew = this.page.locator(
      'div.entry[data-status="new"], div.entry[data-status="neu"]'
    );
    const scopeAll = this.page.locator("div.entry");

    let entry = scopeNew.filter({ hasText: rx });
    if ((await entry.count()) === 0) entry = scopeAll.filter({ hasText: rx });

    return (await entry.count()) ? entry.first() : null;
  }

  // CORRECTED: Convert email format to exact website format
  // inside class
  // async applyToJobByDetails({ date, time, zip, city }) {
  //   await this.goToMeineJobs();

  //   const entry = await this._findEntryByLine({ date, time, zip, city });
  //   if (!entry) {
  //     console.log(
  //       `❌ No row found for: Am ${date} um ${time} in ${zip} ${city || ""}`
  //     );
  //     return false;
  //   }

  //   const before = (await entry.getAttribute("data-status")) || "";
  //   return this._submitAcceptInEntry(entry, before);
  // }
  // Enhanced applyToJobByDetails with better error handling
  async applyToJobByDetails({ date, time, zip, city }) {
    try {
      console.log(
        `🎯 Applying to job: ${date} ${time} in ${zip} ${city || ""}`
      );

      // Ensure we're logged in
      await this.ensureLoggedIn();

      // Navigate to jobs page with debugging
      await this.goToMeineJobs();

      // Wait for dynamic content to load
      await this.page.waitForTimeout(3000);

      // Try to find the entry
      const entry = await this._findEntryByLine({ date, time, zip, city });

      if (!entry) {
        console.log("❌ Entry not found, running comprehensive search...");

        // Try alternative search patterns
        const alternatives = [
          // Without city
          { date, time, zip, city: null },
          // With different time formats
          { date, time: time.replace(":", "."), zip, city },
          // With "Uhr" suffix
          { date, time: time + " Uhr", zip, city },
        ];

        for (const alt of alternatives) {
          console.log(`🔍 Trying alternative pattern:`, alt);
          const altEntry = await this._findEntryByLine(alt);
          if (altEntry) {
            console.log("✅ Found entry with alternative pattern!");
            return await this._submitAcceptInEntry(altEntry);
          }
        }

        // If still not found, debug the page content
        console.log("❌ No entry found with any pattern, debugging page...");
        await this._debugPageContent();

        return false;
      }

      console.log("✅ Entry found, proceeding with submission...");
      const statusBefore = (await entry.getAttribute("data-status")) || "";
      return await this._submitAcceptInEntry(entry, statusBefore);
    } catch (error) {
      console.error("❌ applyToJobByDetails failed:", error.message);

      // Take a screenshot for debugging if enabled
      if (process.env.DEBUG_MODE === "true") {
        await this._maybeScreenshot("error");
      }

      throw error;
    }
  }

  // ADDED: Improved submit handling with better selectors and error handling
  // FIXED: Better submit handling with corrected syntax
  // inside class
  async _submitAcceptInEntry(entry, statusBefore = "") {
    const accept = entry.locator(`
      button#ctrl_accept,
      button[name="accept"],
      input[type="submit"][name="accept"],
      button:has-text("Job annehmen"),
      button:has-text("Annehmen"),
      a:has-text("Job annehmen"),
      a:has-text("annehmen")
    `);

    const n = await accept.count();
    console.log(`🔘 accept controls found: ${n}`);
    if (!n) return false;

    await accept.first().scrollIntoViewIfNeeded();

    // Most rows do a full page POST → navigation
    try {
      await Promise.all([
        this.page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 15000,
        }),
        accept.first().click({ timeout: 8000 }),
      ]);
    } catch {
      // If no navigation (rare), still try to detect state change
      await accept
        .first()
        .click({ timeout: 8000 })
        .catch(() => {});
      await this.page.waitForTimeout(1200);
    }

    // Re-locate the same entry by its DOM ref and check if it changed/disappeared
    const stillThere = await entry.count();
    if (!stillThere) return true; // entry re-rendered/removed → success

    const after = (await entry.first().getAttribute("data-status")) || "";
    if (statusBefore !== after) return true;

    // Fallback: check for a red “cancel”/X button (many UIs show that only after success)
    const hasCancel = await entry
      .locator('button[name="cancel"], .btn.red, button:has-text("x")')
      .count();
    return hasCancel > 0;
  }

  // ADDED: Debug helper to see available entries
  async _debugAvailableEntries() {
    try {
      const allEntries = this.page.locator("div.entry");
      const totalCount = await allEntries.count();
      console.log(`🔍 Debug: ${totalCount} total entries on page`);

      for (let i = 0; i < Math.min(totalCount, 3); i++) {
        const entry = allEntries.nth(i);
        const status = await entry.getAttribute("data-status");
        const text = await entry.textContent();
        console.log(
          `📄 Entry ${i + 1} [${status}]: ${text?.substring(0, 150)}...`
        );
      }
    } catch (error) {
      console.log("🔍 Could not debug entries:", error.message);
    }
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
        console.log(
          `📸 Debug screenshot saved: debug-${tag}-${Date.now()}.png`
        );
      } catch (err) {
        console.error("❌ Failed to take screenshot:", err.message);
      }
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

  async checkLoginState() {
    try {
      const currentUrl = this.page.url();
      console.log("🔐 Checking login state, current URL:", currentUrl);

      // Check if we're on a login page
      if (currentUrl.includes("login") || currentUrl.includes("signin")) {
        console.log("❌ Redirected to login page - session expired");
        return false;
      }

      // Check for login-specific elements
      const loginIndicators = [
        'input[name="username"]',
        'input[name="password"]',
        'button:has-text("Anmelden")',
        'button:has-text("Login")',
        ".login-form",
      ];

      for (const selector of loginIndicators) {
        const exists = (await this.page.locator(selector).count()) > 0;
        if (exists) {
          console.log(`❌ Found login indicator: ${selector}`);
          return false;
        }
      }

      // Check for logged-in indicators
      const loggedInIndicators = [
        'a:has-text("Logout")',
        'a:has-text("Abmelden")',
        'a:has-text("Meine Jobs")',
        ".user-menu",
        ".navigation",
      ];

      let loggedInCount = 0;
      for (const selector of loggedInIndicators) {
        const exists = (await this.page.locator(selector).count()) > 0;
        if (exists) {
          console.log(`✅ Found logged-in indicator: ${selector}`);
          loggedInCount++;
        }
      }

      const isLoggedIn = loggedInCount > 0;
      console.log(
        `🎯 Login state assessment: ${
          isLoggedIn ? "LOGGED IN" : "NOT LOGGED IN"
        }`
      );

      return isLoggedIn;
    } catch (error) {
      console.error("❌ Login state check failed:", error.message);
      return false;
    }
  }

  async ensureLoggedIn() {
    const isLoggedIn = await this.checkLoginState();

    if (!isLoggedIn) {
      console.log("🔄 Login required, attempting to log in...");
      this.isLoggedIn = false;
      await this.login();
    } else {
      console.log("✅ Already logged in");
      this.isLoggedIn = true;
    }

    return this.isLoggedIn;
  }
}

module.exports = { UmzugshilfeAutomator };
