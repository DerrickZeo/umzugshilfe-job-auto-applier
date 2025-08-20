// scripts/test-apply.js
require("dotenv").config();
const { UmzugshilfeAutomator } = require("../src/lib/automator-simple");

// allow args: node scripts/test-apply.js 23.08.2025 15:00 58452 "Witten"
const [, , A_DATE, A_TIME, A_ZIP, ...CITY_PARTS] = process.argv;
const CITY = CITY_PARTS.join(" ");

async function main() {
  const details = {
    date: A_DATE || "23.08.2025",
    time: A_TIME || "15:00",
    zip: A_ZIP || "58452",
    city: CITY || "Witten",
  };

  console.log("➡️  Will try:", details);

  const automator = new UmzugshilfeAutomator();

  try {
    await automator.initialize(); // launches browser + logs in
    const ok = await automator.applyToJobByDetails(details); // 🔥 clicks “annehmen”
    console.log(ok ? "✅ SUCCESS" : "❌ NOT FOUND / NOT APPLIED");
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error("❌ Test error:", e);
    process.exit(2);
  } finally {
    await automator.cleanup();
  }
}

main();
