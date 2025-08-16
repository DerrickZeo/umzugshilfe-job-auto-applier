// app.js - Simplified EC2 Application with SMTP for Maximum Speed
// No database, no OAuth complexity - just pure competitive advantage

// Load environment variables first
require("dotenv").config();

const express = require("express");
const { UmzugshilfeAutomator } = require("./src/lib/automator-simple");
const { EmailWatcher } = require("./src/lib/email-watcher-smtp");

class UmzugshilfeService {
  constructor() {
    this.app = express();
    this.automator = new UmzugshilfeAutomator();
    this.emailWatcher = new EmailWatcher();

    this.isProcessing = false;
    this.stats = {
      totalJobsProcessed: 0,
      successCount: 0,
      failCount: 0,
      startTime: Date.now(),
    };

    this.setupExpress();
    this.setupGracefulShutdown();
  }

  setupExpress() {
    this.app.use(express.json());

    // Simple health check
    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        uptime: Date.now() - this.stats.startTime,
        browserReady: this.automator.isReady(),
        emailConnected: this.emailWatcher.isConnected(),
        smtpConfigured: !!process.env.EMAIL_ADDRESS,
      });
    });

    // Basic stats
    this.app.get("/stats", (req, res) => {
      res.json({
        ...this.stats,
        uptime: Date.now() - this.stats.startTime,
        isProcessing: this.isProcessing,
        successRate:
          this.stats.totalJobsProcessed > 0
            ? Math.round(
                (this.stats.successCount / this.stats.totalJobsProcessed) * 100
              )
            : 0,
      });
    });

    // Manual job trigger for testing
    this.app.post("/trigger", async (req, res) => {
      const { jobIds } = req.body;
      if (!jobIds || !Array.isArray(jobIds)) {
        return res.status(400).json({ error: "Invalid jobIds array" });
      }

      try {
        const result = await this.handleNewJobs(jobIds);
        res.json({ success: true, processed: result });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Test email sending
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
    console.log("🚀 Initializing simplified Umzugshilfe Service with SMTP...");

    try {
      // Initialize browser and login
      await this.automator.initialize();
      console.log("✅ Browser ready and logged in");

      // Initialize email watcher with SMTP
      await this.emailWatcher.initialize();
      console.log("✅ SMTP connection established");

      // Start email monitoring
      this.emailWatcher.startPolling(this.handleNewJobs.bind(this));
      console.log("✅ Email monitoring active");

      // Start Express server
      const port = process.env.PORT || 3000;
      this.app.listen(port, () => {
        console.log(`🌐 Server running on port ${port}`);
        console.log("🎯 Ready for lightning-fast job applications!");
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

  async handleNewJobs(jobIds) {
    if (!jobIds || jobIds.length === 0) return;

    const startTime = Date.now();
    console.log(`⚡ NEW JOBS: ${jobIds.join(", ")} - Processing immediately!`);

    if (this.isProcessing) {
      console.log("⚠️ Already processing jobs, queuing...");
      // Simple queue - just wait a bit and try again
      setTimeout(() => this.handleNewJobs(jobIds), 1000);
      return;
    }

    this.isProcessing = true;

    try {
      // Process jobs immediately
      const results = await this.automator.processJobs(jobIds);

      const responseTime = Date.now() - startTime;

      // Update simple stats
      this.stats.totalJobsProcessed += jobIds.length;
      this.stats.successCount += results.successful.length;
      this.stats.failCount += results.failed.length;

      // Send success notification via email
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
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("❌ Job processing failed:", error);
      this.stats.failCount += jobIds.length;

      // Send error notification
      await this.emailWatcher.sendErrorNotification(error, jobIds);

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n📡 Received ${signal}, shutting down...`);

      try {
        // Stop email polling
        this.emailWatcher.stop();

        // Wait for current processing to complete (max 30s)
        let waitTime = 0;
        while (this.isProcessing && waitTime < 30000) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          waitTime += 1000;
        }

        // Clean up browser
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
