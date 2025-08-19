// email-watcher-smtp.js - SIMPLIFIED: Details-only processing

const nodemailer = require("nodemailer");
const Imap = require("imap");

class EmailWatcher {
  constructor() {
    this.transporter = null;
    this.imapConnection = null;

    // state flags
    this.smtpReady = false;
    this.imapReady = false;
    this.connected = false;

    this.jobHandler = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 5000;

    // polling
    this.pollingInterval = null;
    this.pollingFrequency = 15000;
    this.lastCheckTime = new Date();

    // Job tracking for simplified processing
    this.processedJobs = new Set();
    this.emailRetryCount = new Map();

    this.config = {
      smtp: {
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.EMAIL_SECURE === "true" || false,
        auth: {
          user: process.env.EMAIL_ADDRESS,
          pass: process.env.EMAIL_PASSWORD,
        },
        tls: { rejectUnauthorized: false },
      },
      imap: {
        user: process.env.EMAIL_ADDRESS,
        password: process.env.EMAIL_PASSWORD,
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        keepalive: true,
      },
    };
  }

  async checkForNewEmails(jobHandler) {
    if (!this.imapReady || !this.imapConnection || !this.connected) {
      console.log("⚠️ IMAP not connected, skipping email check");
      return;
    }

    if (!jobHandler || typeof jobHandler !== "function") {
      console.error("❌ Invalid jobHandler provided to checkForNewEmails");
      return;
    }

    await this.openInbox();

    const searchCriteria = ["UNSEEN", ["FROM", "studenten-umzugshilfe.com"]];
    const uids = await this.searchEmails(searchCriteria);
    if (!uids.length) {
      console.log("🔭 No new job emails found");
      return;
    }

    console.log(`📧 Found ${uids.length} new job emails`);

    for (const uid of uids) {
      let shouldMarkAsRead = false;

      try {
        // SIMPLIFIED: Only extract details from email
        const emailSubject = await this.getSubjectPlusBody(uid);
        console.log(
          `📄 Processing email ${uid}: ${emailSubject.substring(0, 150)}...`
        );

        const details = this.parseJobDetailsFromText(emailSubject);

        if (details) {
          console.log(
            `📅 Found job: ${details.date} ${details.time} in ${details.zip} ${details.city}`
          );

          // Create unique key for this job
          const jobKey = `${details.date}_${details.time}_${details.zip}`;

          // Check if already processed
          if (this.isJobAlreadyProcessed(jobKey)) {
            console.log(`🔄 Job ${jobKey} already processed, skipping`);
            shouldMarkAsRead = true;
          } else {
            // Process the job using details
            const result = await jobHandler(details);
            const success =
              result && result.results && result.results.successful.length > 0;

            if (success) {
              console.log(`✅ Successfully processed job: ${jobKey}`);
              shouldMarkAsRead = true;
              this.markJobAsProcessed(jobKey);
            } else {
              console.log(`❌ Failed to process job: ${jobKey}`);
              // Don't mark as read - let it retry later
              const retryCount = this.getEmailRetryCount(uid);
              if (retryCount >= 3) {
                console.log(
                  `⚠️ Max retries reached for ${uid}, marking as read`
                );
                shouldMarkAsRead = true;
              } else {
                this.incrementEmailRetryCount(uid);
              }
            }
          }
        } else {
          console.log("❌ Could not extract job details from email");
          console.log(`📝 Email subject: ${emailSubject}`);

          // CRITICAL: Handle parsing failures to prevent infinite loops
          const retryCount = this.getEmailRetryCount(uid);
          if (retryCount >= 2) {
            console.log(
              `⚠️ Parsing failed ${retryCount} times, marking as read to prevent infinite loop`
            );
            shouldMarkAsRead = true;
          } else {
            console.log(
              `🔄 Will retry parsing later (attempt ${retryCount + 1}/3)`
            );
            this.incrementEmailRetryCount(uid);
          }
        }
      } catch (err) {
        console.error(`❌ Error processing email ${uid}:`, err);

        const retryCount = this.getEmailRetryCount(uid);
        if (retryCount >= 2) {
          console.log(
            `⚠️ Processing failed ${retryCount} times, marking as read`
          );
          shouldMarkAsRead = true;
        } else {
          this.incrementEmailRetryCount(uid);
        }
      }

      // Mark as read only if we should
      if (shouldMarkAsRead) {
        try {
          await this.markAsRead(uid);
          console.log(`✅ Marked email ${uid} as read`);
          this.clearEmailRetryCount(uid);
        } catch (markError) {
          console.error(`❌ Failed to mark email as read:`, markError);
        }
      }
    }

    this.lastCheckTime = new Date();
  }

  // SIMPLIFIED: Parse ONLY from email subject line format
  parseJobDetailsFromText(text) {
    if (!text) {
      console.log("❌ No text provided for parsing");
      return null;
    }

    const cleanText = text.replace(/\s+/g, " ").trim();
    console.log(`🔍 Parsing email subject: ${cleanText.substring(0, 300)}...`);

    // ONLY SUBJECT FORMAT: "2 Umzugshelfer am 23.08.2025 ab 15:00 Uhr in 58452 Witten gesucht"
    const subjectPattern =
      /(\d+)\s+Umzugshelfer\s+am\s+(\d{1,2}\.\d{1,2}\.\d{4})\s+ab\s+(\d{1,2}:\d{2})\s+Uhr\s+in\s+(\d{5})\s+([A-ZÄÖÜa-zäöüß\-\.\s]+?)\s+gesucht/i;
    const subjectMatch = cleanText.match(subjectPattern);

    if (!subjectMatch) {
      console.log("❌ Subject line doesn't match expected format");
      console.log(
        `📝 Expected: "X Umzugshelfer am DD.MM.YYYY ab HH:MM Uhr in 12345 City gesucht"`
      );
      console.log(`📝 Received: ${cleanText}`);
      return null;
    }

    console.log("📧 Successfully matched subject line format");

    const date = subjectMatch[2]; // 23.08.2025
    const time = subjectMatch[3]; // 15:00
    const zip = subjectMatch[4]; // 58452
    const city = subjectMatch[5].trim(); // Witten

    // Format time properly (ensure HH:MM format)
    let formattedTime = time;
    const timeParts = formattedTime.split(":");
    if (timeParts.length === 2) {
      const hours = timeParts[0].padStart(2, "0");
      const minutes = timeParts[1];
      formattedTime = `${hours}:${minutes}`;
    }

    // Clean city name (remove any trailing words, punctuation)
    const cleanCity = city
      .replace(/\s+(gesucht|neu|wartend|new)$/i, "")
      .replace(/[.,!?]+$/, "")
      .trim();

    const result = {
      date: date,
      time: formattedTime,
      zip: zip,
      city: cleanCity,
    };

    console.log(`✅ Parsed from subject line:`, result);
    return result;
  }

  // FIXED: Get ONLY the subject line for parsing
  async getSubjectPlusBody(uid) {
    return new Promise((resolve, reject) => {
      const fetch = this.imapConnection.fetch(uid, {
        bodies: ["HEADER.FIELDS (SUBJECT)"], // Only get subject
        markSeen: false,
      });

      let subject = "";

      fetch.on("message", (msg) => {
        msg.on("body", (stream, info) => {
          let chunk = "";
          stream.on("data", (data) => {
            chunk += data.toString("utf8");
          });

          stream.once("end", () => {
            if (info.which === "HEADER.FIELDS (SUBJECT)") {
              const subjectMatch = chunk.match(/Subject:\s*(.+?)(?:\r?\n|$)/i);
              if (subjectMatch) {
                subject = subjectMatch[1].trim();
              }
            }
          });
        });
      });

      fetch.once("error", reject);
      fetch.once("end", () => {
        console.log(`📄 Extracted subject: ${subject}`);
        resolve(subject); // Return ONLY the subject line
      });
    });
  }

  isJobAlreadyProcessed(jobKey) {
    return this.processedJobs.has(jobKey);
  }

  markJobAsProcessed(jobKey) {
    this.processedJobs.add(jobKey);
    if (this.processedJobs.size > 1000) {
      const jobsArray = Array.from(this.processedJobs);
      this.processedJobs.clear();
      jobsArray.slice(-500).forEach((job) => this.processedJobs.add(job));
    }
  }

  getEmailRetryCount(uid) {
    return this.emailRetryCount.get(uid) || 0;
  }

  incrementEmailRetryCount(uid) {
    const current = this.getEmailRetryCount(uid);
    this.emailRetryCount.set(uid, current + 1);
  }

  clearEmailRetryCount(uid) {
    this.emailRetryCount.delete(uid);
  }

  // Core IMAP and SMTP methods from original code
  async initialize(jobHandler = null) {
    console.log("📧 Initializing SMTP email watcher...");

    if (jobHandler) {
      this.jobHandler = jobHandler;
    }

    if (!this.config.smtp.auth.user || !this.config.smtp.auth.pass) {
      throw new Error("EMAIL_ADDRESS and EMAIL_PASSWORD must be configured");
    }

    // SMTP setup
    const smtpConfigs = [
      {
        name: "Gmail TLS (587)",
        config: {
          host: "smtp.gmail.com",
          port: 587,
          secure: false,
          auth: this.config.smtp.auth,
          tls: { rejectUnauthorized: false },
          connectionTimeout: 10000,
          greetingTimeout: 5000,
          socketTimeout: 10000,
        },
      },
      {
        name: "Gmail SSL (465)",
        config: {
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          auth: this.config.smtp.auth,
          tls: { rejectUnauthorized: false },
          connectionTimeout: 10000,
          greetingTimeout: 5000,
          socketTimeout: 10000,
        },
      },
    ];

    let lastError;
    for (const { name, config } of smtpConfigs) {
      try {
        console.log(`📧 Trying ${name}...`);
        this.transporter = nodemailer.createTransport(config);
        await Promise.race([
          this.transporter.verify(),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("Verification timeout")), 15000)
          ),
        ]);
        console.log(`✅ SMTP connection verified using ${name}`);
        this.smtpReady = true;
        break;
      } catch (err) {
        console.log(`❌ ${name} failed: ${err.message}`);
        lastError = err;
        this.transporter = null;
      }
    }
    if (!this.transporter) {
      throw new Error(
        `All SMTP configurations failed. Last error: ${lastError?.message}`
      );
    }

    // IMAP setup
    console.log("📬 Initializing IMAP...");
    this.imapConnection = new Imap(this.config.imap);
    this.setupImapHandlers();

    await this.connectImap();
    await this.openInbox();

    this.imapReady = true;
    this.connected = true;
    this.attachPush();
    console.log("✅ Email watcher initialized (SMTP + IMAP push)");
  }

  setupImapHandlers() {
    this.imapConnection.on("ready", () =>
      console.log("📬 IMAP connection ready")
    );
    this.imapConnection.on("error", (err) => {
      console.error("❌ IMAP connection error:", err);
      this.scheduleReconnect("error");
    });
    this.imapConnection.on("end", () => {
      console.log("📭 IMAP connection ended");
      this.scheduleReconnect("end");
    });
  }

  attachPush() {
    let busy = false;
    this.imapConnection.on("mail", () => {
      if (busy) return;
      busy = true;

      if (this.jobHandler) {
        this.checkForNewEmails(this.jobHandler)
          .catch((err) => console.error("IDLE handler error:", err))
          .finally(() => (busy = false));
      } else {
        console.warn("⚠️ No jobHandler available for IMAP push notification");
        busy = false;
      }
    });
  }

  scheduleReconnect(reason) {
    if (this.reconnectTimer) return;
    this.connected = false;
    this.imapReady = false;

    try {
      this.imapConnection.end();
    } catch {}
    console.warn(
      `🔄 Reconnecting IMAP due to ${reason} in ${
        this.reconnectDelayMs / 1000
      }s...`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this._reconnectImap();
    }, this.reconnectDelayMs);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000);
  }

  async _reconnectImap() {
    try {
      this.imapConnection = new Imap({
        ...this.config.imap,
        keepalive: { interval: 30000, idleInterval: 300000, forceNoop: true },
      });
      this.setupImapHandlers();
      await this.connectImap();
      await this.openInbox();
      this.attachPush();

      this.imapReady = true;
      this.connected = true;
      this.reconnectDelayMs = 5000;
      console.log("✅ IMAP reconnected");
    } catch (e) {
      console.error("❌ Reconnect failed:", e.message);
      this.scheduleReconnect("retry");
    }
  }

  async connectImap() {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.imapConnection.removeListener("ready", onReady);
        this.imapConnection.removeListener("error", onError);
      };
      this.imapConnection.once("ready", onReady);
      this.imapConnection.once("error", onError);
      this.imapConnection.connect();
    });
  }

  async openInbox() {
    if (!this.imapConnection) throw new Error("IMAP not initialized");
    return new Promise((resolve, reject) => {
      this.imapConnection.openBox("INBOX", false, (err, box) =>
        err ? reject(err) : resolve(box)
      );
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

  async markAsRead(uid) {
    return new Promise((resolve, reject) => {
      this.imapConnection.addFlags(uid, ["\\Seen"], (err) =>
        err ? reject(err) : resolve()
      );
    });
  }

  async startPolling(jobHandler) {
    console.log(`🔍 Starting email polling every ${this.pollingFrequency}ms`);

    if (jobHandler && !this.jobHandler) {
      this.jobHandler = jobHandler;
    }

    if (this.pollingInterval) clearInterval(this.pollingInterval);
    this.pollingInterval = setInterval(() => {
      if (this.jobHandler) {
        this.checkForNewEmails(this.jobHandler).catch((err) =>
          console.error("❌ Error during email polling:", err)
        );
      }
    }, this.pollingFrequency);

    if (this.jobHandler) {
      await this.checkForNewEmails(this.jobHandler);
    }
  }

  async sendSuccessNotification(successfulJobs, responseTime) {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({
        from: this.config.smtp.auth.user,
        to: this.config.smtp.auth.user,
        subject: `✅ Job Applications Successful - ${successfulJobs.length} jobs`,
        text: `Success! Applied to ${
          successfulJobs.length
        } jobs in ${responseTime}ms.

Job IDs: ${successfulJobs.join(", ")}
Response time: ${responseTime}ms
Timestamp: ${new Date().toISOString()}
`,
      });
      console.log("✅ Success notification sent");
    } catch (e) {
      console.error("❌ Failed to send success notification:", e);
    }
  }

  async sendErrorNotification(error, jobIds) {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({
        from: this.config.smtp.auth.user,
        to: this.config.smtp.auth.user,
        subject: `❌ Job Application Error - ${jobIds.length} jobs failed`,
        text: `Error occurred while processing jobs:

Job IDs: ${jobIds.join(", ")}
Error: ${error.message}
Stack: ${error.stack}

Timestamp: ${new Date().toISOString()}
`,
      });
      console.log("📧 Error notification sent");
    } catch (e) {
      console.error("❌ Failed to send error notification:", e);
    }
  }

  async sendTestEmail() {
    if (!this.transporter) throw new Error("SMTP transporter not initialized");
    await this.transporter.sendMail({
      from: this.config.smtp.auth.user,
      to: this.config.smtp.auth.user,
      subject: "🧪 Test Email - Umzugshilfe Bot",
      text: `This is a test email from your Umzugshilfe job application bot.

SMTP Host: ${this.config.smtp.host}
SMTP Port: ${this.config.smtp.port}
Email: ${this.config.smtp.auth.user}

Timestamp: ${new Date().toISOString()}
`,
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
    this.connected = false;
    this.imapReady = false;
  }

  isConnected() {
    return this.imapReady && this.connected;
  }
}

module.exports = { EmailWatcher };
