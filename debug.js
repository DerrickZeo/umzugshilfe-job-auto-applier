// debug.js - Quick debug script to check what's missing

console.log("🔍 Debugging Umzugshilfe App Setup");
console.log("==================================");

// Check Node.js version
console.log("Node.js version:", process.version);

// Check current directory
console.log("Current directory:", process.cwd());

// Check if main files exist
const fs = require("fs");
const path = require("path");

const requiredFiles = [
  "app.js",
  "package.json",
  ".env",
  "src/lib/automator-simple.js",
  "src/lib/email-watcher-smtp.js",
];

console.log("\n📁 File Check:");
requiredFiles.forEach((file) => {
  const exists = fs.existsSync(file);
  console.log(`${exists ? "✅" : "❌"} ${file}`);
});

// Check dependencies
console.log("\n📦 Dependency Check:");
try {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const requiredDeps = [
    "express",
    "playwright",
    "nodemailer",
    "imap",
    "dotenv",
  ];

  requiredDeps.forEach((dep) => {
    const installed = packageJson.dependencies && packageJson.dependencies[dep];
    console.log(
      `${installed ? "✅" : "❌"} ${dep}${installed ? ` (${installed})` : ""}`
    );
  });
} catch (error) {
  console.log("❌ Could not read package.json");
}

// Check environment variables
console.log("\n🔧 Environment Check:");
if (fs.existsSync(".env")) {
  require("dotenv").config();
  const requiredEnvVars = [
    "LOGIN_USERNAME",
    "LOGIN_PASSWORD",
    "EMAIL_ADDRESS",
    "EMAIL_PASSWORD",
  ];

  requiredEnvVars.forEach((envVar) => {
    const value = process.env[envVar];
    console.log(
      `${value ? "✅" : "❌"} ${envVar}${value ? " (set)" : " (missing)"}`
    );
  });
} else {
  console.log("❌ .env file not found");
}

// Try to require the main modules
console.log("\n🧪 Module Test:");
const modules = ["express", "playwright", "nodemailer", "imap"];

modules.forEach((moduleName) => {
  try {
    require(moduleName);
    console.log(`✅ ${moduleName}`);
  } catch (error) {
    console.log(`❌ ${moduleName}: ${error.message}`);
  }
});

// Try to require our custom modules
const customModules = [
  "./src/lib/automator-simple",
  "./src/lib/email-watcher-smtp",
];

customModules.forEach((modulePath) => {
  try {
    require(modulePath);
    console.log(`✅ ${modulePath}`);
  } catch (error) {
    console.log(`❌ ${modulePath}: ${error.message}`);
  }
});

console.log("\n🚀 If all items above show ✅, the app should work!");
console.log("If you see ❌, those items need to be fixed first.");
