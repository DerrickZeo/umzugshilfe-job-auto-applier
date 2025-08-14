// Umzugshilfe Job Auto-Applier - Main Lambda Handler (Playwright Edition)
// Optimized for maximum speed and reliability with Playwright

const { chromium } = require("playwright-aws-lambda");
const AWS = require("aws-sdk");

// AWS Services
const sns = new AWS.SNS();
const eventbridge = new AWS.EventBridge();
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Configuration
const CONFIG = {
  LOGIN_URL: "https://studenten-umzugshilfe.com/login",
  JOBS_URL: "https://studenten-umzugshilfe.com/intern/meine-jobs",
  EMAIL_SENDER: "job@studenten-umzugshilfe.com",
  TABLE_NAME: process.env.JOBS_TABLE || "umzugshilfe-jobs",
  ERROR_TOPIC_ARN: process.env.ERROR_TOPIC_ARN,
  MAX_CONCURRENT_JOBS: 10,
  LOGIN_CREDENTIALS: {
    username: process.env.LOGIN_USERNAME,
    password: process.env.LOGIN_PASSWORD,
  },
  TIMEOUTS: {
    PAGE_LOAD: 15000,
    ELEMENT_WAIT: 10000,
    NAVIGATION: 20000,
  },
};

class UmzugshilfeAutomator {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoggedIn = false;
    this.sessionStartTime = Date.now();
  }

  async initialize() {
    console.log("🎭 Initializing Playwright browser...");
    const startTime = Date.now();

    // Launch browser with optimized settings for Lambda
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--single-process",
      ],
    });

    // Create browser context with realistic settings
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });

    // Create page with optimized settings
    this.page = await this.context.newPage();

    // Set timeouts
    this.page.setDefaultTimeout(CONFIG.TIMEOUTS.ELEMENT_WAIT);
    this.page.setDefaultNavigationTimeout(CONFIG.TIMEOUTS.NAVIGATION);

    // Block unnecessary resources for speed
    await this.page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "font", "media"].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const initTime = Date.now() - startTime;
    console.log(`✅ Browser initialized in ${initTime}ms`);
  }

  async login() {
    if (this.isLoggedIn) {
      console.log("📝 Already logged in, checking session validity...");

      // Check if session is still valid (30 minutes max)
      const sessionAge = Date.now() - this.sessionStartTime;
      if (sessionAge > 30 * 60 * 1000) {
        console.log("🔄 Session expired, re-logging in...");
        this.isLoggedIn = false;
      } else {
        return true;
      }
    }

    try {
      console.log("🔑 Attempting login...");
      const loginStart = Date.now();

      // Navigate to login page
      await this.page.goto(CONFIG.LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.TIMEOUTS.PAGE_LOAD,
      });

      // Wait for login form to be visible
      await this.page.waitForSelector(
        'input[name="username"], #username, [placeholder*="Benutzername"], [placeholder*="benutzername"]',
        {
          timeout: CONFIG.TIMEOUTS.ELEMENT_WAIT,
        }
      );

      // Find username field with multiple fallback selectors
      const usernameSelectors = [
        'input[name="username"]',
        "#username",
        'input[type="text"]',
        '[placeholder*="Benutzername"]',
        '[placeholder*="benutzername"]',
      ];

      let usernameField = null;
      for (const selector of usernameSelectors) {
        try {
          usernameField = await this.page.locator(selector).first();
          if (await usernameField.isVisible()) break;
        } catch (e) {
          continue;
        }
      }

      if (!usernameField) {
        throw new Error("Username field not found");
      }

      // Find password field
      const passwordField = this.page.locator('input[type="password"]').first();
      await passwordField.waitFor({ state: "visible" });

      // Fill credentials
      await usernameField.fill(CONFIG.LOGIN_CREDENTIALS.username);
      await passwordField.fill(CONFIG.LOGIN_CREDENTIALS.password);

      // Find and click submit button
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Anmelden")',
        'button:has-text("Login")',
        '.btn:has-text("Anmelden")',
      ];

      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          submitButton = this.page.locator(selector).first();
          if (await submitButton.isVisible()) break;
        } catch (e) {
          continue;
        }
      }

      if (!submitButton) {
        throw new Error("Submit button not found");
      }

      // Submit form and wait for navigation
      await Promise.all([
        this.page.waitForURL((url) => !url.includes("login"), {
          timeout: CONFIG.TIMEOUTS.NAVIGATION,
        }),
        submitButton.click(),
      ]);

      // Verify login success
      const currentUrl = this.page.url();
      if (currentUrl.includes("login")) {
        throw new Error("Login failed - still on login page");
      }

      this.isLoggedIn = true;
      this.sessionStartTime = Date.now();

      const loginTime = Date.now() - loginStart;
      console.log(`✅ Login successful in ${loginTime}ms`);
      return true;
    } catch (error) {
      console.error("❌ Login failed:", error.message);
      await this.sendErrorNotification("Login Failed", error.message);
      return false;
    }
  }

  async navigateToJobsPage() {
    try {
      console.log("📄 Navigating to jobs page...");
      const navStart = Date.now();

      await this.page.goto(CONFIG.JOBS_URL, {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.TIMEOUTS.PAGE_LOAD,
      });

      // Wait for jobs container to load with multiple selectors
      const jobContainerSelectors = [
        ".job",
        '[id*="job"]',
        ".entry",
        "[data-job-id]",
        ".mod_article",
        ".ce_text",
      ];

      let jobsLoaded = false;
      for (const selector of jobContainerSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 5000 });
          jobsLoaded = true;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!jobsLoaded) {
        console.log("⚠️ Jobs container not detected, proceeding anyway...");
      }

      const navTime = Date.now() - navStart;
      console.log(`✅ Jobs page loaded in ${navTime}ms`);
      return true;
    } catch (error) {
      console.error("❌ Failed to navigate to jobs page:", error.message);
      return false;
    }
  }

  async findAndApplyToJob(jobId) {
    try {
      console.log(`🎯 Looking for job ${jobId}...`);
      const jobStart = Date.now();

      // Refresh page to get latest jobs
      await this.page.reload({ waitUntil: "domcontentloaded" });

      // Multiple strategies to find the job
      const findStrategies = [
        // Strategy 1: Direct ID selectors
        async () => {
          const selectors = [
            `#${jobId}`,
            `[data-job-id="${jobId}"]`,
            `[id*="${jobId}"]`,
          ];
          for (const selector of selectors) {
            try {
              const element = this.page.locator(selector);
              if ((await element.count()) > 0) return element.first();
            } catch (e) {}
          }
          return null;
        },

        // Strategy 2: Text content search
        async () => {
          try {
            return this.page.locator(`text=#${jobId}`).first();
          } catch (e) {
            return null;
          }
        },

        // Strategy 3: XPath search
        async () => {
          try {
            return this.page
              .locator(`xpath=//*[contains(text(), "#${jobId}")]`)
              .first();
          } catch (e) {
            return null;
          }
        },
      ];

      let jobElement = null;
      for (const strategy of findStrategies) {
        jobElement = await strategy();
        if (jobElement && (await jobElement.count()) > 0) {
          console.log(`📍 Job ${jobId} found using search strategy`);
          break;
        }
      }

      if (!jobElement || (await jobElement.count()) === 0) {
        console.log(`⚠️ Job ${jobId} not found on page`);
        return false;
      }

      // Look for green apply button near the job
      const greenButtonStrategies = [
        // Strategy 1: Look within job element
        async () => {
          try {
            return jobElement
              .locator('button, .btn, input[type="submit"]')
              .filter({
                hasText: /annehmen|anwenden|bewerben|apply/i,
              })
              .first();
          } catch (e) {
            return null;
          }
        },

        // Strategy 2: Look for green colored buttons
        async () => {
          try {
            return jobElement
              .locator("button")
              .filter({
                has: this.page.locator('[style*="green"], .green, .success'),
              })
              .first();
          } catch (e) {
            return null;
          }
        },

        // Strategy 3: Look for checkmark buttons
        async () => {
          try {
            return jobElement
              .locator("button")
              .filter({
                has: this.page.locator("svg, .fa-check, .checkmark"),
              })
              .first();
          } catch (e) {
            return null;
          }
        },
      ];

      let applyButton = null;
      for (const strategy of greenButtonStrategies) {
        applyButton = await strategy();
        if (
          applyButton &&
          (await applyButton.count()) > 0 &&
          (await applyButton.isVisible())
        ) {
          break;
        }
      }

      if (!applyButton || (await applyButton.count()) === 0) {
        console.log(
          `⚠️ No apply button found for job ${jobId} - job may already be taken`
        );
        return false;
      }

      // Click the apply button
      await applyButton.click();

      // Wait for confirmation or page change
      await this.page.waitForTimeout(2000);

      // Check for success indicators
      const successIndicators = [
        "text=erfolgreich",
        "text=angenommen",
        "text=beworben",
        ".success",
        ".alert-success",
      ];

      let applicationSuccess = false;
      for (const indicator of successIndicators) {
        try {
          if ((await this.page.locator(indicator).count()) > 0) {
            applicationSuccess = true;
            break;
          }
        } catch (e) {}
      }

      const jobTime = Date.now() - jobStart;

      if (applicationSuccess) {
        console.log(`✅ Successfully applied to job ${jobId} in ${jobTime}ms`);
      } else {
        console.log(
          `⚠️ Applied to job ${jobId} in ${jobTime}ms (success unclear)`
        );
      }

      // Track application
      await this.trackJobApplication(jobId, applicationSuccess);

      return true;
    } catch (error) {
      console.error(`❌ Failed to apply to job ${jobId}:`, error.message);
      await this.sendErrorNotification(
        `Job Application Failed - ${jobId}`,
        error.message
      );
      return false;
    }
  }

  async trackJobApplication(jobId, success = true) {
    try {
      await dynamodb
        .put({
          TableName: CONFIG.TABLE_NAME,
          Item: {
            jobId: jobId,
            appliedAt: new Date().toISOString(),
            status: success ? "applied" : "attempted",
            ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days TTL
          },
        })
        .promise();
    } catch (error) {
      console.error("Failed to track job application:", error);
    }
  }

  async processJobQueue(jobIds) {
    console.log(`📋 Processing ${jobIds.length} jobs concurrently...`);
    const processStart = Date.now();

    if (!(await this.login())) {
      return { success: false, error: "Login failed" };
    }

    if (!(await this.navigateToJobsPage())) {
      return { success: false, error: "Navigation failed" };
    }

    // Process jobs in chunks to avoid overwhelming the system
    const chunkSize = Math.min(CONFIG.MAX_CONCURRENT_JOBS, jobIds.length);
    const results = {
      successful: [],
      failed: [],
      total: jobIds.length,
    };

    for (let i = 0; i < jobIds.length; i += chunkSize) {
      const chunk = jobIds.slice(i, i + chunkSize);
      console.log(
        `🔄 Processing chunk ${Math.floor(i / chunkSize) + 1}: [${chunk.join(
          ", "
        )}]`
      );

      const chunkPromises = chunk.map(async (jobId) => {
        const success = await this.findAndApplyToJob(jobId);
        if (success) {
          results.successful.push(jobId);
        } else {
          results.failed.push(jobId);
        }
        return { jobId, success };
      });

      await Promise.allSettled(chunkPromises);

      // Small delay between chunks to be respectful
      if (i + chunkSize < jobIds.length) {
        await this.page.waitForTimeout(1000);
      }
    }

    const totalTime = Date.now() - processStart;
    console.log(
      `✅ Completed processing in ${totalTime}ms. Success: ${results.successful.length}, Failed: ${results.failed.length}`
    );

    return results;
  }

  async sendErrorNotification(subject, message) {
    try {
      if (!CONFIG.ERROR_TOPIC_ARN) {
        console.log("⚠️ No error topic configured, skipping notification");
        return;
      }

      await sns
        .publish({
          TopicArn: CONFIG.ERROR_TOPIC_ARN,
          Subject: `Umzugshilfe Bot Error: ${subject}`,
          Message: `Error occurred in Umzugshilfe automation:\n\n${message}\n\nTime: ${new Date().toISOString()}\nFunction: ${
            process.env.AWS_LAMBDA_FUNCTION_NAME || "local"
          }`,
        })
        .promise();
    } catch (error) {
      console.error("Failed to send error notification:", error);
    }
  }

  async takeScreenshot(name = "debug") {
    try {
      if (this.page) {
        const screenshot = await this.page.screenshot({
          fullPage: true,
          type: "png",
        });
        console.log(
          `📸 Screenshot taken: ${name} (${screenshot.length} bytes)`
        );
        return screenshot;
      }
    } catch (error) {
      console.error("Failed to take screenshot:", error);
    }
  }

  async cleanup() {
    try {
      if (this.context) {
        await this.context.close();
      }
      if (this.browser) {
        await this.browser.close();
      }
      console.log("🧹 Browser cleanup completed");
    } catch (error) {
      console.error("Cleanup error:", error);
    }
  }
}

// Utility functions
function extractJobIdsFromEmail(emailContent) {
  const jobIdRegex = /#(\d+)/g;
  const matches = [];
  let match;

  const searchText =
    typeof emailContent === "string"
      ? emailContent
      : `${emailContent.subject || ""} ${emailContent.body || ""} ${
          emailContent.snippet || ""
        }`;

  while ((match = jobIdRegex.exec(searchText)) !== null) {
    matches.push(match[1]);
  }

  return [...new Set(matches)]; // Remove duplicates
}

function validateEnvironment() {
  const required = ["LOGIN_USERNAME", "LOGIN_PASSWORD"];
  const missing = required.filter((env) => !process.env[env]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

// Main Lambda handler
exports.handler = async (event) => {
  console.log("🚀 Umzugshilfe Job Auto-Applier started (Playwright version)");
  console.log(`📊 Event: ${JSON.stringify(event, null, 2)}`);

  const startTime = Date.now();
  const automator = new UmzugshilfeAutomator();

  try {
    // Validate environment
    validateEnvironment();

    // Initialize browser
    await automator.initialize();

    let jobIds = [];
    let eventSource = "unknown";

    // Handle different event sources
    if (event.source === "gmail.push" || event.source === "gmail_watcher") {
      eventSource = "gmail";
      if (event.emailContent) {
        jobIds = extractJobIdsFromEmail(event.emailContent);
      } else if (event.Records && event.Records[0]?.Sns?.Message) {
        const message = JSON.parse(event.Records[0].Sns.Message);
        jobIds = extractJobIdsFromEmail(message);
      }
    } else if (event.jobIds && Array.isArray(event.jobIds)) {
      eventSource = "direct";
      jobIds = event.jobIds;
    } else if (event.source === "periodic" || event.source === "test") {
      eventSource = event.source;
      // For periodic checks, we would typically check for new emails
      // For now, we'll just log and return
      console.log(`📅 ${event.source} check completed - no jobs to process`);
    }

    if (jobIds.length > 0) {
      console.log(
        `📧 Processing ${
          jobIds.length
        } job IDs from ${eventSource}: ${jobIds.join(", ")}`
      );
      const results = await automator.processJobQueue(jobIds);

      const totalTime = Date.now() - startTime;
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Job processing completed successfully",
          source: eventSource,
          results: results,
          executionTime: `${totalTime}ms`,
          timestamp: new Date().toISOString(),
        }),
      };
    } else {
      console.log(`📭 No job IDs found in ${eventSource} event`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "No jobs to process",
          source: eventSource,
          timestamp: new Date().toISOString(),
        }),
      };
    }
  } catch (error) {
    console.error("💥 Fatal error:", error);
    await automator.sendErrorNotification("Fatal Error", error.message);

    // Take screenshot for debugging if possible
    await automator.takeScreenshot("error-debug");

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      }),
    };
  } finally {
    await automator.cleanup();
    const totalExecutionTime = Date.now() - startTime;
    console.log(`⏱️ Total execution time: ${totalExecutionTime}ms`);
  }
};

// Export for testing
module.exports = { UmzugshilfeAutomator, extractJobIdsFromEmail };

// Local testing capability
if (require.main === module) {
  const testEvent = {
    jobIds: ["49982", "49978"],
    source: "test",
  };

  exports
    .handler(testEvent)
    .then((result) => {
      console.log("✅ Test result:", result);
    })
    .catch((error) => {
      console.error("❌ Test error:", error);
    });
}
