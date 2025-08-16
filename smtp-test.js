// src/lib/email-watcher-smtp.js
// SMTP-based email monitoring for maximum simplicity and reliability

const nodemailer = require("nodemailer");
const Imap = require("imap");
const { inspect } = require("util");

class EmailWatcher {
  constructor() {
    this.transporter = null;
    this.imapConnection = null;
    this.isConnected = false;
    this.pollingInterval = null;
    this.pollingFrequency = 30000; // 30 seconds
    this.lastCheckTime = new Date();

    this.config = {
      smtp: {
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.EMAIL_SECURE === "true" || false,
        auth: {
          user: process.env.EMAIL_ADDRESS,
          pass: process.env.EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false,
        },
      },
      imap: {
        user: process.env.EMAIL_ADDRESS,
        password: process.env.EMAIL_PASSWORD,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      },
    };
  }

  async initialize() {
    console.log("🔧 Initializing SMTP email watcher...");

    if (!this.config.smtp.auth.user || !this.config.smtp.auth.pass) {
      throw new Error("EMAIL_ADDRESS and EMAIL_PASSWORD must be configured");
    }

    // Initialize SMTP transporter
    this.transporter = nodemailer.createTransport(this.config.smtp);

    // Verify SMTP connection
    try {
      await this.transporter.verify();
      console.log("✅ SMTP connection verified");
    } catch (error) {
      throw new Error(`SMTP verification failed: ${error.message}`);
    }

    // Initialize IMAP connection
    this.imapConnection = new Imap(this.config.imap);

    // Set up IMAP event handlers
    this.setupImapHandlers();

    // Test IMAP connection
    await this.connectImap();

    this.isConnected = true;
    console.log("✅ Email watcher initialized successfully");
  }

  setupImapHandlers() {
    this.imapConnection.once("ready", () => {
      console.log("📬 IMAP connection ready");
    });

    this.imapConnection.once("error", (err) => {
      console.error("❌ IMAP connection error:", err);
      this.isConnected = false;
    });

    this.imapConnection.once("end", () => {
      console.log("📭 IMAP connection ended");
      this.isConnected = false;
    });
  }

  async connectImap() {
    return new Promise((resolve, reject) => {
      this.imapConnection.once("ready", resolve);
      this.imapConnection.once("error", reject);
      this.imapConnection.connect();
    });
  }

  async startPolling(jobHandler) {
    console.log(`🔍 Starting email polling every ${this.pollingFrequency}ms`);

    this.pollingInterval = setInterval(async () => {
      try {
        await this.checkForNewEmails(jobHandler);
      } catch (error) {
        console.error("❌ Error during email polling:", error);
      }
    }, this.pollingFrequency);

    // Initial check
    await this.checkForNewEmails(jobHandler);
  }

  async checkForNewEmails(jobHandler) {
    if (!this.isConnected) {
      console.log("⚠️ IMAP not connected, skipping email check");
      return;
    }

    try {
      await this.openInbox();

      // Search for new emails since last check
      const searchCriteria = [
        "UNSEEN",
        ["FROM", "job@studenten-umzugshilfe.com"],
      ];

      const uids = await this.searchEmails(searchCriteria);

      if (uids.length === 0) {
        console.log("📭 No new job emails found");
        return;
      }

      console.log(`📧 Found ${uids.length} new job emails`);

      for (const uid of uids) {
        try {
          const jobIds = await this.extractJobIdsFromEmail(uid);
          if (jobIds.length > 0) {
            await jobHandler(jobIds);
          }

          // Mark as read
          await this.markAsRead(uid);
        } catch (error) {
          console.error(`❌ Error processing email ${uid}:`, error);
        }
      }

      this.lastCheckTime = new Date();
    } catch (error) {
      console.error("❌ Error checking emails:", error);
    }
  }

  async openInbox() {
    return new Promise((resolve, reject) => {
      this.imapConnection.openBox("INBOX", false, (err, box) => {
        if (err) reject(err);
        else resolve(box);
      });
    });
  }

  async searchEmails(criteria) {
    return new Promise((resolve, reject) => {
      this.imapConnection.search(criteria, (err, results) => {
        if (err) reject(err);
        else resolve(results || []);
      });
    });
  }

  async extractJobIdsFromEmail(uid) {
    return new Promise((resolve, reject) => {
      const fetch = this.imapConnection.fetch(uid, {
        bodies: "TEXT",
        markSeen: false,
      });

      let jobIds = [];

      fetch.on("message", (msg) => {
        msg.on("body", (stream) => {
          let buffer = "";
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
          });

          stream.once("end", () => {
            // Extract job IDs from email content
            // This regex should match your specific email format
            const jobIdPattern = /job[_\-]?id[:\s]*([A-Z0-9]+)/gi;
            const matches = buffer.match(jobIdPattern);

            if (matches) {
              jobIds = matches.map((match) => {
                const id = match.replace(/job[_\-]?id[:\s]*/gi, "").trim();
                return id;
              });
            }

            // Alternative: look for URLs with job IDs
            const urlPattern = /umzugshilfe\.com\/job\/([A-Z0-9]+)/gi;
            const urlMatches = [...buffer.matchAll(urlPattern)];
            urlMatches.forEach((match) => {
              if (match[1] && !jobIds.includes(match[1])) {
                jobIds.push(match[1]);
              }
            });

            console.log(
              `📧 Extracted job IDs from email: ${jobIds.join(", ")}`
            );
          });
        });
      });

      fetch.once("error", reject);
      fetch.once("end", () => resolve(jobIds));
    });
  }

  async markAsRead(uid) {
    return new Promise((resolve, reject) => {
      this.imapConnection.addFlags(uid, ["\\Seen"], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async sendSuccessNotification(successfulJobs, responseTime) {
    if (!this.transporter) return;

    const subject = `✅ Job Applications Successful - ${successfulJobs.length} jobs`;
    const text = `
Success! Applied to ${successfulJobs.length} jobs in ${responseTime}ms.

Job IDs: ${successfulJobs.join(", ")}

Response time: ${responseTime}ms
Timestamp: ${new Date().toISOString()}

Your competitive advantage is working! 🚀
`;

    try {
      await this.transporter.sendMail({
        from: this.config.smtp.auth.user,
        to: this.config.smtp.auth.user,
        subject,
        text,
      });
      console.log("✅ Success notification sent");
    } catch (error) {
      console.error("❌ Failed to send success notification:", error);
    }
  }

  async sendErrorNotification(error, jobIds) {
    if (!this.transporter) return;

    const subject = `❌ Job Application Error - ${jobIds.length} jobs failed`;
    const text = `
Error occurred while processing jobs:

Job IDs: ${jobIds.join(", ")}
Error: ${error.message}
Stack: ${error.stack}

Timestamp: ${new Date().toISOString()}

Please check the application logs for more details.
`;

    try {
      await this.transporter.sendMail({
        from: this.config.smtp.auth.user,
        to: this.config.smtp.auth.user,
        subject,
        text,
      });
      console.log("📧 Error notification sent");
    } catch (sendError) {
      console.error("❌ Failed to send error notification:", sendError);
    }
  }

  async sendTestEmail() {
    if (!this.transporter) {
      throw new Error("SMTP transporter not initialized");
    }

    const subject = "🧪 Test Email - Umzugshilfe Bot";
    const text = `
This is a test email from your Umzugshilfe job application bot.

Configuration:
- SMTP Host: ${this.config.smtp.host}
- SMTP Port: ${this.config.smtp.port}
- Email: ${this.config.smtp.auth.user}

If you receive this email, your SMTP configuration is working correctly! ✅

Timestamp: ${new Date().toISOString()}
`;

    await this.transporter.sendMail({
      from: this.config.smtp.auth.user,
      to: this.config.smtp.auth.user,
      subject,
      text,
    });

    console.log("📧 Test email sent successfully");
  }

  stop() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log("⏹️ Email polling stopped");
    }

    if (this.imapConnection) {
      this.imapConnection.end();
      console.log("📭 IMAP connection closed");
    }

    this.isConnected = false;
  }

  isConnected() {
    return this.isConnected;
  }
}

module.exports = { EmailWatcher };
