// Gmail integration handler for Umzugshilfe Job Auto-Applier
// Optimized for real-time job detection and processing

const { google } = require("googleapis");
const AWS = require("aws-sdk");

const lambda = new AWS.Lambda();

const CONFIG = {
  GMAIL_CREDENTIALS: {
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  },
  TARGET_SENDER: "job@studenten-umzugshilfe.com",
  MAIN_LAMBDA_FUNCTION:
    process.env.MAIN_LAMBDA_FUNCTION || "umzugshilfe-job-processor",
};

class GmailClient {
  constructor() {
    this.gmail = null;
    this.oauth2Client = null;
  }

  async initialize() {
    console.log("📧 Initializing Gmail API...");

    this.oauth2Client = new google.auth.OAuth2(
      CONFIG.GMAIL_CREDENTIALS.client_id,
      CONFIG.GMAIL_CREDENTIALS.client_secret
    );

    this.oauth2Client.setCredentials({
      refresh_token: CONFIG.GMAIL_CREDENTIALS.refresh_token,
    });

    this.gmail = google.gmail({ version: "v1", auth: this.oauth2Client });
    console.log("✅ Gmail API initialized");
  }

  async checkForNewJobEmails() {
    try {
      const searchQuery = `from:${CONFIG.TARGET_SENDER} subject:"#" is:unread`;
      console.log(`🔍 Searching emails: ${searchQuery}`);

      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: searchQuery,
        maxResults: 10,
      });

      const messages = response.data.messages || [];
      console.log(`📧 Found ${messages.length} job emails`);

      const jobIds = [];

      for (const message of messages) {
        const emailContent = await this.getEmailContent(message.id);
        if (emailContent && emailContent.from.includes(CONFIG.TARGET_SENDER)) {
          const extractedIds = this.extractJobIds(emailContent);
          jobIds.push(...extractedIds);

          // Mark as read to avoid reprocessing
          await this.markAsRead(message.id);
        }
      }

      return [...new Set(jobIds)]; // Remove duplicates
    } catch (error) {
      console.error("❌ Failed to check emails:", error);
      return [];
    }
  }

  async getEmailContent(messageId) {
    try {
      const response = await this.gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const message = response.data;
      const headers = message.payload.headers;

      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";

      let body = "";
      if (message.payload.body && message.payload.body.data) {
        body = Buffer.from(message.payload.body.data, "base64").toString();
      } else if (message.payload.parts) {
        for (const part of message.payload.parts) {
          if (part.mimeType === "text/plain" && part.body.data) {
            body += Buffer.from(part.body.data, "base64").toString();
          }
        }
      }

      return { messageId, subject, from, body, snippet: message.snippet };
    } catch (error) {
      console.error(`❌ Failed to get email content for ${messageId}:`, error);
      return null;
    }
  }

  extractJobIds(emailContent) {
    const jobIdRegex = /#(\d+)/g;
    const matches = [];
    let match;

    const searchText = `${emailContent.subject} ${emailContent.body} ${emailContent.snippet}`;

    while ((match = jobIdRegex.exec(searchText)) !== null) {
      matches.push(match[1]);
    }

    return matches;
  }

  async markAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
      console.log(`✅ Marked email ${messageId} as read`);
    } catch (error) {
      console.error(`❌ Failed to mark email as read:`, error);
    }
  }

  async triggerJobProcessing(jobIds) {
    try {
      console.log(`🚀 Triggering job processing for: ${jobIds.join(", ")}`);

      await lambda
        .invoke({
          FunctionName: CONFIG.MAIN_LAMBDA_FUNCTION,
          InvocationType: "Event",
          Payload: JSON.stringify({
            jobIds: jobIds,
            source: "gmail_watcher",
            timestamp: new Date().toISOString(),
          }),
        })
        .promise();

      console.log("✅ Job processing triggered successfully");
    } catch (error) {
      console.error("❌ Failed to trigger job processing:", error);
      throw error;
    }
  }
}

exports.handler = async (event) => {
  console.log("📧 Gmail watcher triggered");
  console.log("Event:", JSON.stringify(event, null, 2));

  const gmailClient = new GmailClient();

  try {
    await gmailClient.initialize();
    const jobIds = await gmailClient.checkForNewJobEmails();

    if (jobIds.length > 0) {
      await gmailClient.triggerJobProcessing(jobIds);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processed ${jobIds.length} new jobs`,
        jobIds: jobIds,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("💥 Gmail handler error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
};

exports.pollingHandler = async (event) => {
  console.log("⏰ Periodic email check triggered");
  return exports.handler(event);
};
