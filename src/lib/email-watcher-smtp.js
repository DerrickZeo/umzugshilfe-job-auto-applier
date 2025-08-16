// src/lib/email-watcher-smtp.js
// SMTP + IMAP watcher (push + fallback polling)

const nodemailer = require("nodemailer");
const Imap = require("imap");

class EmailWatcher {
  constructor() {
    this.transporter = null;
    this.imapConnection = null;

    // state flags
    this.smtpReady = false;
    this.imapReady = false;
    this.connected = false; // renamed (avoid isConnected() name clash)

    this.jobHandler = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = 5000; // backoff start (5s), max 60s

    // polling
    this.pollingInterval = null;
    this.pollingFrequency = 30000; // 30s safety poll
    this.lastCheckTime = new Date();

    this.config = {
      smtp: {
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.EMAIL_SECURE === "true" || false,
        auth: {
          user: process.env.EMAIL_ADDRESS,
          pass: process.env.EMAIL_PASSWORD, // use a Gmail App Password
        },
        tls: { rejectUnauthorized: false },
      },
      imap: {
        user: process.env.EMAIL_ADDRESS,
        password: process.env.EMAIL_PASSWORD, // App Password
        host: "imap.gmail.com",
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        keepalive: true, // node-imap keeps IDLE alive
      },
    };
  }

  // pass jobHandler in so push handler can call it
  async initialize(jobHandler) {
    console.log("🔧 Initializing SMTP email watcher...");
    this.jobHandler = jobHandler;

    if (!this.config.smtp.auth.user || !this.config.smtp.auth.pass) {
      throw new Error("EMAIL_ADDRESS and EMAIL_PASSWORD must be configured");
    }

    // Try both SMTP flavors
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
        console.log(`🔄 Trying ${name}...`);
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
      console.log(
        "💡 SMTP Tips:\n  - Enable 2FA in Google\n  - Use an App Password\n  - Check firewall/VPN"
      );
      throw new Error(
        `All SMTP configurations failed. Last error: ${lastError?.message}`
      );
    }

    // --- IMAP (push) ---
    console.log("📬 Initializing IMAP…");
    this.imapConnection = new Imap(this.config.imap);
    this.setupImapHandlers();

    await this.connectImap(); // waits for 'ready'
    await this.openInbox(); // select INBOX

    // Push: trigger immediately on new mail (IDLE)
    let busy = false; // simple debounce
    this.imapConnection.on("mail", () => {
      if (busy) return;
      busy = true;
      this.checkForNewEmails(jobHandler)
        .catch((err) => console.error("IDLE error:", err))
        .finally(() => {
          busy = false;
        });
    });

    this.imapReady = true;
    this.connected = true;
    this.attachPush();
    console.log("✅ IMAP connected");
    console.log("✅ Email watcher initialized (SMTP + IMAP push)");
  }

  setupImapHandlers() {
    this.imapConnection.on("ready", () =>
      console.log("📬 IMAP connection ready")
    );
    this.imapConnection.on("error", (err) => {
      console.error("❌ IMAP connection error:", err);
      this.scheduleReconnect("error");
      // this.connected = false;
      // this.imapReady = false;
    });
    this.imapConnection.on("end", () => {
      console.log("📭 IMAP connection ended");
      this.scheduleReconnect("end");
      //  this.connected = false;
      // this.imapReady = false;
    });
  }

  attachPush() {
    // debounce so we don't overlap scans
    let busy = false;
    this.imapConnection.on("mail", () => {
      if (busy) return;
      busy = true;
      this.checkForNewEmails(this.jobHandler)
        .catch((err) => console.error("IDLE handler error:", err))
        .finally(() => (busy = false));
    });
  }

  scheduleReconnect(reason) {
    if (this.reconnectTimer) return; // already scheduled
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

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60000); // cap at 60s
  }

  async _reconnectImap() {
    try {
      this.imapConnection = new Imap({
        ...this.config.imap,
        // keepalive helps after network blips / sleep
        keepalive: { interval: 30000, idleInterval: 300000, forceNoop: true },
      });
      this.setupImapHandlers();
      await this.connectImap();
      await this.openInbox();
      this.attachPush();

      this.imapReady = true;
      this.connected = true;
      this.reconnectDelayMs = 5000; // reset backoff
      console.log("✅ IMAP reconnected");
    } catch (e) {
      console.error("❌ Reconnect failed:", e.message);
      this.scheduleReconnect("retry"); // schedule next attempt
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

  async startPolling(jobHandler) {
    console.log(`🔍 Starting email polling every ${this.pollingFrequency}ms`);
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    this.pollingInterval = setInterval(() => {
      this.checkForNewEmails(jobHandler).catch((err) =>
        console.error("❌ Error during email polling:", err)
      );
    }, this.pollingFrequency);

    // do an immediate scan as well
    await this.checkForNewEmails(jobHandler);
  }

  async checkForNewEmails(jobHandler) {
    if (!this.imapReady || !this.imapConnection || !this.connected) {
      console.log("⚠️ IMAP not connected, skipping email check");
      return;
    }
    await this.openInbox();

    // UNSEEN + from domain
    const searchCriteria = ["UNSEEN", ["FROM", "studenten-umzugshilfe.com"]];
    const uids = await this.searchEmails(searchCriteria);
    if (!uids.length) {
      console.log("📭 No new job emails found");
      return;
    }

    console.log(`📧 Found ${uids.length} new job emails`);
    for (const uid of uids) {
      try {
        const jobIds = await this.extractJobIdsFromEmail(uid);
        if (jobIds.length > 0) {
          await jobHandler(jobIds); // your app handles applying
        } else {
          console.log("ℹ️ No numeric job IDs in this email (subject/body)");
          // If you want the no-ID fallback by details, you can:
          // const text = await this.getSubjectPlusBody(uid);
          // const details = this.parseJobDetailsFromText(text);
          // if (details) await jobHandler([], details);
        }
        await this.markAsRead(uid); // optional
      } catch (err) {
        console.error(`❌ Error processing email ${uid}:`, err);
      }
    }

    this.lastCheckTime = new Date();
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

  async extractJobIdsFromEmail(uid) {
    return new Promise((resolve, reject) => {
      const fetch = this.imapConnection.fetch(uid, {
        bodies: ["HEADER.FIELDS (SUBJECT)", "TEXT"],
        markSeen: false,
      });

      let buffer = "";
      fetch.on("message", (msg) => {
        msg.on("body", (stream) => {
          let chunk = "";
          stream.on("data", (d) => (chunk += d.toString("utf8")));
          stream.once("end", () => {
            buffer += "\n" + chunk;
          });
        });
      });
      fetch.once("error", reject);
      fetch.once("end", () => {
        const ids = new Set();

        // "ID: 49768" / "#49768"
        for (const m of buffer.matchAll(/(?:\bID[\s:–-]*|#)(\d{4,7})\b/gi))
          ids.add(m[1]);

        // URLs: .../job/49768 or .../jobs/49768
        for (const m of buffer.matchAll(
          /studenten-umzugshilfe\.com\/(?:job|jobs)\/(\d{4,7})/gi
        ))
          ids.add(m[1]);

        const out = [...ids];
        console.log(
          out.length
            ? `📧 Extracted job IDs: ${out.join(", ")}`
            : "📧 No job IDs found in this email"
        );
        resolve(out);
      });
    });
  }

  // optional helper if you later want details matching (date, time, zip, city)
  parseJobDetailsFromText(text) {
    const s = (text || "").replace(/\s+/g, " ").trim();
    const dateMatch = s.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
    const timeMatch = s.match(/\b(\d{1,2}:\d{2})\b/);
    const locMatch = s.match(/\b(\d{5})\s+([A-Za-zÄÖÜäöüß\-\.]+)\b/);
    if (!dateMatch || !timeMatch || !locMatch) return null;
    const [h, m] = timeMatch[1].split(":");
    const time = `${String(h).padStart(2, "0")}:${m}`;
    return { date: dateMatch[1], time, zip: locMatch[1], city: locMatch[2] };
  }

  async markAsRead(uid) {
    return new Promise((resolve, reject) => {
      this.imapConnection.addFlags(uid, ["\\Seen"], (err) =>
        err ? reject(err) : resolve()
      );
    });
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

  // health helper used by your app.js
  isConnected() {
    return this.imapReady && this.connected;
  }
}

module.exports = { EmailWatcher };
