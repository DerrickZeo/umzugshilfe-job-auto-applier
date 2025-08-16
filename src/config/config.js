// Configuration management for Umzugshilfe Job Auto-Applier
module.exports = {
  umzugshilfe: {
    loginUrl: "https://studenten-umzugshilfe.com/login",
    jobsUrl: "https://studenten-umzugshilfe.com/intern/meine-jobs",
    credentials: {
      username: process.env.LOGIN_USERNAME,
      password: process.env.LOGIN_PASSWORD,
    },
  },
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    targetSender: "job@studenten-umzugshilfe.com",
  },
  aws: {
    region: process.env.AWS_REGION || "eu-central-1",
    errorTopicArn: process.env.ERROR_TOPIC_ARN,
    jobsTable: process.env.JOBS_TABLE || "umzugshilfe-jobs",
  },
  processing: {
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS) || 10,
    timeout: parseInt(process.env.PROCESSING_TIMEOUT) || 300,
    debugMode: process.env.DEBUG_MODE === "true",
  },
  timeouts: {
    pageLoad: 15000,
    elementWait: 10000,
    navigation: 20000,
  },
  performance: {
    responseTimeTarget: 3000,
    successRateTarget: 95,
    maxRetries: 3,
    retryDelay: 2000,
  },
  security: {
    enableIpWhitelist: process.env.ENABLE_IP_WHITELIST === "true",
    allowedIps: process.env.ALLOWED_IPS?.split(",") || [],
    encryptionKey: process.env.ENCRYPTION_KEY,
  },
  monitoring: {
    enableMetrics: process.env.ENABLE_METRICS === "true",
    metricsNamespace: process.env.METRICS_NAMESPACE || "UmzugshilfeBot",
    logLevel: process.env.LOG_LEVEL || "info",
  },
};
