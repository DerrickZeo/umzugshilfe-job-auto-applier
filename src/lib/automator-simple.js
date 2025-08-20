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
  async applyToJobByDetails({ date, time, zip, city }) {
    await this.goToMeineJobs();

    const entry = await this._findEntryByLine({ date, time, zip, city });
    if (!entry) {
      console.log(
        `❌ No row found for: Am ${date} um ${time} in ${zip} ${city || ""}`
      );
      return false;
    }

    const before = (await entry.getAttribute("data-status")) || "";
    return this._submitAcceptInEntry(entry, before);
  }

  // async applyToJobByDetails({ date, time, zip, city }) {
  //   try {
  //     console.log(
  //       `🔍 Looking for job: ${date} ${time} in ${zip} ${city || ""}`
  //     );

  //     await this.goToMeineJobs();

  //     // CRITICAL FIX: Correct format conversion
  //     // Email:   "am 23.08.2025 ab 15:00 Uhr in 58452 Witten"
  //     // Website: "Am 23.08.2025 um 15:00 in 58452 Witten"

  //     const searchPatterns = [
  //       `Am ${date} um ${time} in ${zip} ${city}`, // Exact website format
  //       `Am ${date} um ${time} in ${zip}`, // Without city (safer)
  //       `${date} um ${time} in ${zip} ${city}`, // Without "Am" prefix
  //       `${date} um ${time} in ${zip}`, // Minimal safe pattern
  //       `${date}.*${time}.*${zip}`, // Flexible regex pattern
  //       `${date}.*${zip}.*${city}`, // Date + location only
  //     ];

  //     let matchingEntry = null;
  //     let usedPattern = "";

  //     // Try exact pattern matching first
  //     for (const pattern of searchPatterns) {
  //       console.log(`🔍 Trying pattern: "${pattern}"`);

  //       // Look for entries with status "new" or "neu"
  //       const entries = this.page.locator(
  //         'div.entry[data-status="new"], div.entry[data-status="neu"]'
  //       );
  //       const filteredEntries = entries.filter({ hasText: pattern });
  //       const count = await filteredEntries.count();

  //       console.log(`📊 Found ${count} entries matching pattern`);

  //       if (count > 0) {
  //         matchingEntry = filteredEntries.first();
  //         usedPattern = pattern;
  //         console.log(`✅ Found match using pattern: "${pattern}"`);
  //         break;
  //       }
  //     }

  //     // ENHANCED: More aggressive partial matching if exact fails
  //     if (!matchingEntry) {
  //       console.log(
  //         "🔍 No exact match found, trying enhanced partial matching..."
  //       );

  //       const allNewEntries = this.page.locator(
  //         'div.entry[data-status="new"], div.entry[data-status="neu"]'
  //       );
  //       const entryCount = await allNewEntries.count();

  //       console.log(
  //         `📋 Checking ${entryCount} new entries for partial matches...`
  //       );

  //       for (let i = 0; i < entryCount; i++) {
  //         const entry = allNewEntries.nth(i);
  //         const entryText = await entry.textContent();

  //         console.log(`📄 Entry ${i + 1}: ${entryText?.substring(0, 150)}...`);

  //         if (entryText) {
  //           // Try multiple matching strategies
  //           const hasDate = entryText.includes(date);
  //           const hasTime = entryText.includes(time);
  //           const hasZip = entryText.includes(zip);
  //           const hasCity = city
  //             ? entryText.toLowerCase().includes(city.toLowerCase())
  //             : true;

  //           console.log(
  //             `🔍 Match check - Date:${hasDate} Time:${hasTime} Zip:${hasZip} City:${hasCity}`
  //           );

  //           // STRATEGY 1: All three main elements (date, time, zip)
  //           if (hasDate && hasTime && hasZip) {
  //             console.log(`🎯 Found strong partial match in entry ${i + 1}!`);
  //             matchingEntry = entry;
  //             usedPattern = "strong_partial_match";
  //             break;
  //           }

  //           // STRATEGY 2: Date and zip (time might be formatted differently)
  //           if (hasDate && hasZip && hasCity) {
  //             console.log(`🎯 Found good partial match in entry ${i + 1}!`);
  //             matchingEntry = entry;
  //             usedPattern = "good_partial_match";
  //             break;
  //           }

  //           // STRATEGY 3: Just date and zip (most reliable)
  //           if (hasDate && hasZip) {
  //             console.log(`🎯 Found basic partial match in entry ${i + 1}!`);
  //             matchingEntry = entry;
  //             usedPattern = "basic_partial_match";
  //             // Don't break - keep looking for better matches
  //           }
  //         }
  //       }
  //     }

  //     if (!matchingEntry) {
  //       console.log(
  //         `❌ No matching job found for: ${date} ${time} in ${zip} ${
  //           city || ""
  //         }`
  //       );
  //       await this._debugAvailableEntries();
  //       return false;
  //     }

  //     console.log(`✅ Found matching entry using: ${usedPattern}`);

  //     const statusBefore =
  //       (await matchingEntry.getAttribute("data-status")) || "";
  //     console.log(`📋 Job status: ${statusBefore}`);

  //     const result = await this._submitAcceptInEntry(
  //       matchingEntry,
  //       statusBefore
  //     );

  //     if (result) {
  //       console.log(
  //         `✅ Successfully applied to job: ${date} ${time} in ${zip} ${
  //           city || ""
  //         }`
  //       );
  //     } else {
  //       console.log(
  //         `❌ Failed to apply to job: ${date} ${time} in ${zip} ${city || ""}`
  //       );
  //     }

  //     return result;
  //   } catch (error) {
  //     console.error(`❌ Error in applyToJobByDetails:`, error.message);
  //     await this._maybeScreenshot(`details-${date}-${time}-${zip}`);
  //     return false;
  //   }
  // }

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
      a:has-text("Annehmen")
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

  // async _submitAcceptInEntry(entry, statusBefore = "") {
  //   try {
  //     const form = entry.locator("form");

  //     const submit = form.locator(`
  //       button#ctrl_accept,
  //       button[name="accept"],
  //       input[type="submit"][name="accept"],
  //       button:has-text("Job annehmen"),
  //       button:has-text("annehmen"),
  //       button.submit
  //     `);

  //     const submitCount = await submit.count();
  //     console.log(`🔘 Found ${submitCount} submit buttons`);

  //     if (submitCount === 0) {
  //       console.log("⚠️ No accept button found");
  //       const formHTML = await form
  //         .innerHTML()
  //         .catch(() => "Could not get HTML");
  //       console.log("🔍 Form HTML:", formHTML.substring(0, 300));
  //       return false;
  //     }

  //     console.log("🚀 Clicking accept button...");

  //     // Try multiple click strategies
  //     try {
  //       await Promise.all([
  //         this.page.waitForNavigation({
  //           waitUntil: "domcontentloaded",
  //           timeout: 15000,
  //         }),
  //         submit.first().click(),
  //       ]);
  //     } catch (navError) {
  //       console.warn("⚠️ Navigation wait failed, trying direct click...");
  //       await submit.first().click();
  //       await this.page.waitForTimeout(2000);
  //     }

  //     console.log("✅ Click completed");

  //     // Wait for changes
  //     await this.page.waitForTimeout(1000);

  //     // Check for success indicators
  //     const stillThere = await entry.count();
  //     if (!stillThere) {
  //       console.log("✅ Entry disappeared - success!");
  //       return true;
  //     }

  //     const statusAfter =
  //       (await entry.first().getAttribute("data-status")) || "";
  //     if (statusBefore !== statusAfter) {
  //       console.log(`✅ Status changed: '${statusBefore}' → '${statusAfter}'`);
  //       return true;
  //     }

  //     const successIndicators = await entry
  //       .locator(
  //         `
  //       button:has-text("x"),
  //       .btn.red,
  //       .accepted-state,
  //       [data-status="accepted"],
  //       [data-status="angenommen"]
  //     `
  //       )
  //       .count();

  //     if (successIndicators > 0) {
  //       console.log("✅ Found success indicator");
  //       return true;
  //     }

  //     const buttonDisabled = !(await submit
  //       .first()
  //       .isEnabled()
  //       .catch(() => true));
  //     if (buttonDisabled) {
  //       console.log("✅ Button disabled - likely successful");
  //       return true;
  //     }

  //     console.log("⚠️ No clear success indication");
  //     return false;
  //   } catch (error) {
  //     console.error(`❌ Error in submit: ${error.message}`);
  //     return false;
  //   }
  // }

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
}

module.exports = { UmzugshilfeAutomator };
