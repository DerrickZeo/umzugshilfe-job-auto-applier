// app.js - SIMPLIFIED: Details-only processing

require("dotenv").config();

const express = require("express");
const { UmzugshilfeAutomator } = require("./src/lib/automator-simple-new");
const { EmailWatcher } = require("./src/lib/email-watcher-smtp-new");
// ── Normalization helpers for details coming from email subjects ──
const z2 = (n) => String(n).padStart(2, "0");

// "10.3 0" / "9.30" / "9:30" / "9" -> "HH:MM"
function normalizeTime(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/\s+/g, " ").trim();

  // heal broken digits like "10.3 0" -> "10.30"
  t = t.replace(/(\d)\s+(?=\d)/g, "$1");

  let m = t.match(/^(\d{1,2})[.:](\d{2})$/); // 9.30 / 9:30
  if (m) return `${z2(m[1])}:${m[2]}`;

  m = t.match(/^(\d{1,2})$/); // 9 -> 09:00
  if (m) return `${z2(m[1])}:00`;

  m = t.match(/^(\d{2}):(\d{2})$/); // 09:00
  if (m) return `${m[1]}:${m[2]}`;

  return null;
}

function normalizeDate(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\s+/g, "").trim();
  const m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return m ? `${z2(m[1])}.${z2(m[2])}.${m[3]}` : null;
}

function normalizeZip(raw) {
  const z = String(raw || "").trim();
  return /^\d{5}$/.test(z) ? z : null;
}

function normalizeCity(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim(); // keep Unicode, collapse spaces
}

function normalizeDetails(details) {
  if (!details) return null;
  const date = normalizeDate(details.date);
  const time = normalizeTime(details.time);
  const zip = normalizeZip(details.zip);
  const city = normalizeCity(details.city);
  if (!date || !time || !zip) return null; // city may be empty
  return { date, time, zip, city };
}

class UmzugshilfeService {
  constructor() {
    this.app = express();
    this.automator = new UmzugshilfeAutomator();
    this.emailWatcher = new EmailWatcher();

    this.isProcessing = false;
    this.processedJobs = new Set();
    this.jobQueue = [];
    this.stats = {
      totalJobsProcessed: 0,
      successCount: 0,
      failCount: 0,
      startTime: Date.now(),
    };

    this.setupExpress();
    this.setupGracefulShutdown();
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🔔 Received ${signal}, shutting down...`);

      try {
        this.emailWatcher.stop();

        let waitTime = 0;
        while (this.isProcessing && waitTime < 30000) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          waitTime += 1000;
        }

        await this.automator.cleanup();
        console.log("✅ Shutdown completed");
        process.exit(0);
      } catch (error) {
        console.error("❌ Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  // SIMPLIFIED: Only handle job details, no more jobIds parameter
  // SIMPLIFIED: Only handle job details, no more jobIds parameter
  async handleNewJob(jobDetails) {
    // Log raw details to see what the watcher delivered
    console.log("📦 Raw details:", jobDetails);

    // Normalize/validate
    const norm = normalizeDetails(jobDetails);
    if (!norm) {
      console.log("❌ Invalid job details provided (after normalize)");
      return { results: { successful: [], failed: ["INVALID_DETAILS"] } };
    }

    const startTime = Date.now();
    const jobKey = `${norm.date}_${norm.time}_${norm.zip}`;

    console.log(
      `⚡ NEW JOB: ${norm.date} ${norm.time} in ${norm.zip} ${
        norm.city || ""
      } - Processing immediately!`
    );

    // Prevent duplicate processing
    if (this.processedJobs.has(jobKey)) {
      console.log(`🔄 Job ${jobKey} already processed, skipping...`);
      return { results: { successful: [jobKey], failed: [] } };
    }
    this.processedJobs.add(jobKey);

    if (this.isProcessing) {
      console.log("⚠️ Already processing a job, adding to queue...");
      this.jobQueue.push({ jobDetails: norm, startTime });
      return { results: { successful: [], failed: [] }, queued: true };
    }

    this.isProcessing = true;

    try {
      console.log("🔄 Processing job using details method...");
      const success = await this.automator.applyToJobByDetails(norm);

      const results = {
        successful: success ? [jobKey] : [],
        failed: success ? [] : [jobKey],
      };

      const responseTime = Date.now() - startTime;

      this.stats.totalJobsProcessed += 1;
      this.stats.successCount += results.successful.length;
      this.stats.failCount += results.failed.length;

      if (results.successful.length > 0) {
        await this.emailWatcher.sendSuccessNotification(
          results.successful,
          responseTime
        );
      }

      console.log(
        `✅ Completed in ${responseTime}ms - Success: ${results.successful.length}, Failed: ${results.failed.length}`
      );

      return {
        responseTime,
        results,
        method: "job_details",
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("❌ Job processing failed:", error);
      this.stats.failCount += 1;
      await this.emailWatcher.sendErrorNotification(error, [jobKey]);
      return {
        results: { successful: [], failed: [jobKey] },
        error: error.message,
      };
    } finally {
      this.isProcessing = false;
      this.processQueuedJobs();
    }
  }

  // async handleNewJob(jobDetails) {
  //   if (
  //     !jobDetails ||
  //     !jobDetails.date ||
  //     !jobDetails.time ||
  //     !jobDetails.zip
  //   ) {
  //     console.log("❌ Invalid job details provided");
  //     return { results: { successful: [], failed: ["INVALID_DETAILS"] } };
  //   }

  //   const startTime = Date.now();
  //   const jobKey = `${jobDetails.date}_${jobDetails.time}_${jobDetails.zip}`;

  //   console.log(
  //     `⚡ NEW JOB: ${jobDetails.date} ${jobDetails.time} in ${jobDetails.zip} ${
  //       jobDetails.city || ""
  //     } - Processing immediately!`
  //   );

  //   // Prevent duplicate processing
  //   if (this.processedJobs.has(jobKey)) {
  //     console.log(`🔄 Job ${jobKey} already processed, skipping...`);
  //     return { results: { successful: [jobKey], failed: [] } };
  //   }

  //   // Mark as processed immediately
  //   this.processedJobs.add(jobKey);

  //   if (this.isProcessing) {
  //     console.log("⚠️ Already processing a job, adding to queue...");
  //     this.jobQueue.push({ jobDetails, startTime });
  //     return { results: { successful: [], failed: [] }, queued: true };
  //   }

  //   this.isProcessing = true;

  //   try {
  //     console.log("🔄 Processing job using details method...");
  //     const success = await this.automator.applyToJobByDetails(jobDetails);

  //     const results = {
  //       successful: success ? [jobKey] : [],
  //       failed: success ? [] : [jobKey],
  //     };

  //     const responseTime = Date.now() - startTime;

  //     this.stats.totalJobsProcessed += 1;
  //     this.stats.successCount += results.successful.length;
  //     this.stats.failCount += results.failed.length;

  //     if (results.successful.length > 0) {
  //       await this.emailWatcher.sendSuccessNotification(
  //         results.successful,
  //         responseTime
  //       );
  //     }

  //     console.log(
  //       `✅ Completed in ${responseTime}ms - Success: ${results.successful.length}, Failed: ${results.failed.length}`
  //     );

  //     return {
  //       responseTime,
  //       results,
  //       method: "job_details",
  //       timestamp: new Date().toISOString(),
  //     };
  //   } catch (error) {
  //     console.error("❌ Job processing failed:", error);

  //     this.stats.failCount += 1;
  //     await this.emailWatcher.sendErrorNotification(error, [jobKey]);

  //     return {
  //       results: { successful: [], failed: [jobKey] },
  //       error: error.message,
  //     };
  //   } finally {
  //     this.isProcessing = false;
  //     this.processQueuedJobs();
  //   }
  // }

  // SIMPLIFIED: Process queued jobs
  async processQueuedJobs() {
    if (this.jobQueue.length > 0 && !this.isProcessing) {
      const nextJob = this.jobQueue.shift();
      console.log(`📦 Processing queued job...`);

      setTimeout(() => {
        this.handleNewJob(nextJob.jobDetails);
      }, 1000);
    }
  }

  setupExpress() {
    this.app.use(express.json());

    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        uptime: Date.now() - this.stats.startTime,
        browserReady: this.automator.isReady(),
        emailConnected: this.emailWatcher.isConnected(),
        smtpConfigured: !!process.env.EMAIL_ADDRESS,
        processing: "details_only", // Indicate simplified mode
      });
    });

    this.app.get("/stats", (req, res) => {
      res.json({
        ...this.stats,
        uptime: Date.now() - this.stats.startTime,
        isProcessing: this.isProcessing,
        queueLength: this.jobQueue.length,
        processedJobsCount: this.processedJobs.size,
        successRate:
          this.stats.totalJobsProcessed > 0
            ? Math.round(
                (this.stats.successCount / this.stats.totalJobsProcessed) * 100
              )
            : 0,
      });
    });

    // SIMPLIFIED: Manual trigger now only accepts job details
    this.app.post("/trigger", async (req, res) => {
      const { date, time, zip, city } = req.body;

      if (!date || !time || !zip) {
        return res.status(400).json({
          error: "date, time, and zip are required fields",
        });
      }

      const jobDetails = { date, time, zip, city };

      try {
        const result = await this.handleNewJob(jobDetails);
        res.json({ success: true, processed: result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post("/test-email", async (req, res) => {
      try {
        await this.emailWatcher.sendTestEmail();
        res.json({ success: true, message: "Test email sent successfully" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  async initialize() {
    console.log(
      "🚀 Initializing SIMPLIFIED Umzugshilfe Service (Details-Only Mode)..."
    );

    try {
      await this.automator.initialize();
      console.log("✅ Browser ready and logged in");

      await this.emailWatcher.initialize();
      console.log("✅ SMTP connection established");

      // SIMPLIFIED: Pass the simplified handler that expects details object
      this.emailWatcher.startPolling((details) => this.handleNewJob(details));
      console.log("✅ Email monitoring active (details-only mode)");

      setInterval(() => this.cleanupProcessedJobs(), 60000);

      const port = process.env.PORT || 3000;
      this.app.listen(port, () => {
        console.log(`🌐 Server running on port ${port}`);
        console.log("🎯 Ready for lightning-fast job applications!");
        console.log("📋 Processing Mode: DETAILS ONLY (no ID extraction)");
        console.log(
          `📧 Monitoring emails from: ${
            process.env.EMAIL_ADDRESS || "Not configured"
          }`
        );
      });
    } catch (error) {
      console.error("❌ Failed to initialize:", error);
      process.exit(1);
    }
  }

  cleanupProcessedJobs() {
    if (this.processedJobs.size > 1000) {
      const jobsArray = Array.from(this.processedJobs);
      this.processedJobs.clear();
      jobsArray.slice(-500).forEach((job) => this.processedJobs.add(job));
    }
  }
}

// Start the service
if (require.main === module) {
  const service = new UmzugshilfeService();
  service.initialize().catch((error) => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  });
}

module.exports = UmzugshilfeService;
