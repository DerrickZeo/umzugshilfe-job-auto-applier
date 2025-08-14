// Gmail Push Notification Integration
// This sets up real-time email monitoring using Gmail API Push Notifications

const { google } = require("googleapis");
const AWS = require("aws-sdk");

const CONFIG = {
  GMAIL_CREDENTIALS: {
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  },
  PUBSUB_TOPIC: process.env.PUBSUB_TOPIC,
  TARGET_SENDER: "job@studenten-umzugshilfe.com",
  LAMBDA_FUNCTION_NAME: process.env.MAIN_LAMBDA_FUNCTION,
};

class GmailWatcher {
  constructor() {
    this.gmail = null;
    this.oauth2Client = null;
    this.lambda = new AWS.Lambda();
  }

  async initialize() {
    console.log("🔧 Initializing Gmail API...");

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

  async setupPushNotifications() {
    try {
      console.log("📡 Setting up Gmail push notifications...");

      const request = {
        userId: "me",
        requestBody: {
          topicName: CONFIG.PUBSUB_TOPIC,
          labelIds: ["INBOX"],
          labelFilterAction: "include",
        },
      };

      const response = await this.gmail.users.watch(request);
      console.log("✅ Push notifications configured:", response.data);

      return response.data;
    } catch (error) {
      console.error("❌ Failed to setup push notifications:", error);
      throw error;
    }
  }

  async searchJobEmails(query = null) {
    try {
      const searchQuery =
        query || `from:${CONFIG.TARGET_SENDER} subject:"#" is:unread`;
      console.log(`🔍 Searching emails with query: ${searchQuery}`);

      const response = await this.gmail.users.messages.list({
        userId: "me",
        q: searchQuery,
        maxResults: 10,
      });

      const messages = response.data.messages || [];
      console.log(`📧 Found ${messages.length} job emails`);

      return messages;
    } catch (error) {
      console.error("❌ Failed to search emails:", error);
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

      // Extract subject and sender
      const subject = headers.find((h) => h.name === "Subject")?.value || "";
      const from = headers.find((h) => h.name === "From")?.value || "";

      // Extract body content
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

      return {
        messageId,
        subject,
        from,
        body,
        snippet: message.snippet,
      };
    } catch (error) {
      console.error(`❌ Failed to get email content for ${messageId}:`, error);
      return null;
    }
  }

  async markAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });
      console.log(`✅ Marked email ${messageId} as read`);
    } catch (error) {
      console.error(`❌ Failed to mark email ${messageId} as read:`, error);
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

    return [...new Set(matches)]; // Remove duplicates
  }

  async triggerJobProcessing(jobIds, emailInfo) {
    try {
      console.log(`🚀 Triggering job processing for IDs: ${jobIds.join(", ")}`);

      const payload = {
        jobIds: jobIds,
        source: "gmail_watcher",
        emailInfo: emailInfo,
        timestamp: new Date().toISOString(),
      };

      const params = {
        FunctionName: CONFIG.LAMBDA_FUNCTION_NAME,
        InvocationType: "Event", // Async invocation
        Payload: JSON.stringify(payload),
      };

      await this.lambda.invoke(params).promise();
      console.log("✅ Job processing triggered successfully");
    } catch (error) {
      console.error("❌ Failed to trigger job processing:", error);
      throw error;
    }
  }

  async processNewEmails() {
    try {
      const messages = await this.searchJobEmails();

      for (const message of messages) {
        const emailContent = await this.getEmailContent(message.id);

        if (!emailContent) continue;

        // Check if it's from the job platform
        if (!emailContent.from.includes(CONFIG.TARGET_SENDER)) {
          console.log(`⏭️ Skipping email from ${emailContent.from}`);
          continue;
        }

        const jobIds = this.extractJobIds(emailContent);

        if (jobIds.length > 0) {
          console.log(
            `📋 Found job IDs: ${jobIds.join(", ")} in email: ${
              emailContent.subject
            }`
          );

          await this.triggerJobProcessing(jobIds, {
            messageId: message.id,
            subject: emailContent.subject,
            from: emailContent.from,
          });

          // Mark as read to avoid reprocessing
          await this.markAsRead(message.id);
        } else {
          console.log(`📧 No job IDs found in email: ${emailContent.subject}`);
        }
      }
    } catch (error) {
      console.error("❌ Error processing emails:", error);
      throw error;
    }
  }
}

// Lambda handler for Pub/Sub notifications
exports.pubsubHandler = async (event) => {
  console.log("📡 Gmail Pub/Sub notification received");
  console.log("Event:", JSON.stringify(event, null, 2));

  const watcher = new GmailWatcher();

  try {
    await watcher.initialize();
    await watcher.processNewEmails();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Email processing completed",
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("💥 Error in Pub/Sub handler:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
};

// Lambda handler for periodic email checking (fallback)
exports.pollingHandler = async (event) => {
  console.log("⏰ Periodic email check triggered");

  const watcher = new GmailWatcher();

  try {
    await watcher.initialize();
    await watcher.processNewEmails();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Periodic email check completed",
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("💥 Error in polling handler:", error);
    throw error;
  }
};

// Setup function for initial configuration
exports.setupHandler = async (event) => {
  console.log("🛠️ Setting up Gmail integration...");

  const watcher = new GmailWatcher();

  try {
    await watcher.initialize();
    const watchResponse = await watcher.setupPushNotifications();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Gmail integration setup completed",
        watchResponse: watchResponse,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("💥 Setup error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
};

// For testing
if (require.main === module) {
  const watcher = new GmailWatcher();

  watcher
    .initialize()
    .then(() => watcher.processNewEmails())
    .then(() => console.log("✅ Test completed"))
    .catch((error) => console.error("❌ Test failed:", error));
}
