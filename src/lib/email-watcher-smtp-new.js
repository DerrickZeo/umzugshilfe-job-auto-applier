// email-watcher-smtp.js - SIMPLIFIED: Details-only processing

const nodemailer = require("nodemailer");
const Imap = require("imap");

// Minimal RFC-2047 decoder for Q/B encoded words in Subject
const iconv = require("iconv-lite");

// RFC-2047 decoder with proper charset handling (UTF-8, ISO-8859-1, etc.)
function decodeRfc2047(subject) {
  if (!subject) return "";

  return subject.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_, charset, enc, data) => {
      try {
        const cs = String(charset || "").toLowerCase();

        if (enc.toLowerCase() === "b") {
          // Base64 → bytes → decode with charset
          const buf = Buffer.from(data, "base64");
          return iconv.decode(buf, cs);
        } else {
          // Q-encoding: underscores => spaces, =HH hex → bytes
          let bytes = data
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
              String.fromCharCode(parseInt(h, 16))
            );
          // bytes (latin1) → decode with charset
          const buf = Buffer.from(bytes, "latin1");
          return iconv.decode(buf, cs);
        }
      } catch {
        // If decoding fails, return raw chunk
        return data;
      }
    }
  );
}

// helper: zero-pad DD/MM/HH
const z2 = (n) => String(n).padStart(2, "0");

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
  // Details-only mode (no numeric IDs from body)
  async extractJobIdsFromEmail(/* uid */) {
    return [];
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
      const now = new Date();
      console.log(
        `🔭 ${now.getHours()}:${now
          .getMinutes()
          .toString()
          .padStart(2, "0")}:${now
          .getSeconds()
          .toString()
          .padStart(2, "0")} No new job emails found`
      );
      return;
    }

    console.log(`📧 Found ${uids.length} new job emails`);

    for (const uid of uids) {
      try {
        // Get decoded subject + INTERNALDATE
        const { subject, internalDate } = await this.getSubjectAndDate(uid);
        console.log(`📧 Subject: ${subject}`);

        // Try job IDs first if you still support ID flow (optional)

        const details = this.parseJobDetailsFromSubject(subject, internalDate);
        if (details) {
          console.log("➡️ Passing details to handler:", details);
          await jobHandler(details); // ✅ single-argument: details object
          await this.markAsRead(uid);
        } else {
          console.log("❌ Could not extract job details from subject");
          console.log("🧵 Email subject:", subject);
        }
      } catch (err) {
        console.error(`❌ Error processing email ${uid}:`, err);
      }
    }

    this.lastCheckTime = new Date();
  }

  async getSubjectAndDate(uid) {
    return new Promise((resolve, reject) => {
      const f = this.imapConnection.fetch(uid, {
        bodies: "HEADER.FIELDS (SUBJECT)",
        struct: false,
      });

      let raw = "";
      let internalDate = null;

      f.on("message", (msg) => {
        msg.on("body", (stream) => {
          stream.on("data", (d) => (raw += d.toString("utf8")));
        });
        msg.on("attributes", (attrs) => {
          // IMAP INTERNALDATE → a JS Date
          internalDate =
            attrs.date instanceof Date ? attrs.date : new Date(attrs.date);
        });
      });

      f.once("error", reject);
      f.once("end", () => {
        // Capture Subject plus any folded continuation lines up to next header
        const m = raw.match(/Subject:\s*([\s\S]*?)\r?\n(?=[A-Za-z-]+:|$)/i);
        let subjRaw = m ? m[1] : "";
        // Unfold: join CRLF + (space|tab) continuations
        subjRaw = subjRaw.replace(/\r?\n[ \t]+/g, " ").trim();
        let subject = decodeRfc2047(subjRaw).trim();
        subject = subject.replace(/\bU\s+hr\b/gi, "Uhr"); // "U hr" → "Uhr"
        // normalize spacing
        subject = subject.replace(/\s+/g, " ").trim();

        resolve({ subject, internalDate });
      });
    });
  }

  // parseJobDetailsFromSubject(subject, internalDate = new Date()) {
  //   if (!subject) return null;
  //   const s = subject.replace(/\s+/g, " ").trim();

  //   // Ignore non-job subjects quickly
  //   if (/registrierung|registration|verify|bestätigen/i.test(s)) return null;

  //   // --- DATE ---
  //   // a) DD.MM.YYYY
  //   let dateStr = null;
  //   let m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  //   if (m) {
  //     const [, d, mo, y] = m;
  //     dateStr = `${z2(d)}.${z2(mo)}.${y}`;
  //   } else {
  //     // b) DD.MM.  (no year) → use INTERNALDATE's year
  //     m = s.match(/\b(\d{1,2})\.(\d{1,2})\.?\b/);
  //     if (m) {
  //       const [, d, mo] = m;
  //       const y =
  //         internalDate instanceof Date
  //           ? internalDate.getFullYear()
  //           : new Date().getFullYear();
  //       dateStr = `${z2(d)}.${z2(mo)}.${y}`;
  //     }
  //   }
  //   if (!dateStr) return null;

  //   // --- TIME ---
  //   // prefer H:MM or H.MM; else H (→ :00). "ab/um" and "Uhr" optional.
  //   let hh = null,
  //     mm = null;

  //   // look for H:MM
  //   let t = s.match(/\b(\d{1,2}):(\d{2})\b/);
  //   if (t) {
  //     hh = t[1];
  //     mm = t[2];
  //   }

  //   // else look for H.MM (German style)
  //   if (!hh) {
  //     t = s.match(/\b(\d{1,2})\.(\d{2})\b/);
  //     if (t) {
  //       hh = t[1];
  //       mm = t[2];
  //     }
  //   }

  //   // else look for "H Uhr" or a lonely hour after ab/um
  //   if (!hh) {
  //     t = s.match(/(?:\b(?:ab|um)\s+)?\b(\d{1,2})\s*(?:Uhr\b)?/i);
  //     if (t) {
  //       hh = t[1];
  //       mm = "00";
  //     }
  //   }

  //   if (!hh) return null;
  //   const timeStr = `${z2(hh)}:${mm || "00"}`;

  //   // --- ZIP + CITY ---
  //   // zip = 5 digits, city = the words after zip until end / "gesucht"
  //   const loc = s.match(
  //     /\b(\d{5})\s+([A-Za-zÄÖÜäöüß\-.'()\/\s]+?)(?:\s+gesucht\b|$)/
  //   );
  //   if (!loc) return null;
  //   const zip = loc[1];
  //   const city = loc[2].trim().replace(/\s+/g, " ");

  //   return { date: dateStr, time: timeStr, zip, city };
  // }

  // SUBJECT → { date, time, zip, city }
  parseJobDetailsFromSubject(subject, internalDate = new Date()) {
    if (!subject) return null;

    // Normalize
    let s = subject.replace(/\s+/g, " ").trim();

    // Ignore obvious non-job mails
    if (/registrierung|registration|verify|best[äa]tig/i.test(s)) return null;

    // remove "morgen," noise if present
    s = s.replace(/\bmorgen,?\s*/i, "");

    // --- DATE ---
    let dateStr = null;
    let m;

    // With explicit year: DD.MM.YYYY
    m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (m) {
      dateStr = `${z2(m[1])}.${z2(m[2])}.${m[3]}`;
    } else {
      // Without year: DD.MM.  → choose a year
      m = s.match(/\b(\d{1,2})\.(\d{1,2})\.?\b/);
      if (!m) return null;

      // Prefer current year for missing-year subjects (more practical for live jobs)
      // You can flip this to internalDate.getFullYear() if you prefer.
      const y = new Date().getFullYear();
      dateStr = `${z2(m[1])}.${z2(m[2])}.${y}`;
    }

    // --- TIME (anchor to "um" or "ab" to avoid catching "29.04") ---
    let hh = null,
      mm = null;

    // um 12:30 / ab 12:30
    m = s.match(/\b(?:um|ab)\s+(\d{1,2}):(\d{2})\b/i);
    if (m) {
      hh = m[1];
      mm = m[2];
    }

    // um 9.30 / ab 9.30 (but not part of a date; disallow trailing dot)
    if (!hh && (m = s.match(/\b(?:um|ab)\s+(\d{1,2})\.(\d{2})(?!\.)\b/i))) {
      hh = m[1];
      mm = m[2];
    }

    // um 9 / ab 9 [Uhr]
    if (!hh && (m = s.match(/\b(?:um|ab)\s+(\d{1,2})(?:\s*Uhr)?\b/i))) {
      hh = m[1];
      mm = "00";
    }

    // Final fallbacks: standalone HH:MM or HH.MM that are NOT immediately after a digit+dot (date)
    if (!hh && (m = s.match(/(^|[^0-9.])(\d{1,2}):(\d{2})\b/))) {
      hh = m[2];
      mm = m[3];
    }
    if (!hh && (m = s.match(/(^|[^0-9.])(\d{1,2})\.(\d{2})\b(?!\.)/))) {
      hh = m[2];
      mm = m[3];
    }

    if (!hh) return null;
    const timeStr = `${z2(hh)}:${mm || "00"}`;

    // --- ZIP + CITY (Unicode letters, parentheses allowed) ---
    const loc = s.match(/\b(\d{5})\s+([\p{L}\-.'()\/\s]+?)(?:\s+gesucht\b|$)/u);
    if (!loc) return null;

    const zip = loc[1];
    const city = loc[2].replace(/\s+/g, " ").trim();

    return { date: dateStr, time: timeStr, zip, city };
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
