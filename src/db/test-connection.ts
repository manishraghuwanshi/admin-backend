import { sql } from "drizzle-orm";
import { db } from "./index.js";

async function testConnection() {
  try {
    const result = await db.execute(sql`SELECT NOW()`);

    console.log("✅ Neon connection successful!");
    console.log("Database time:", result);
  } catch (error) {
    console.error("❌ Neon connection failed:", error);
    process.exitCode = 1;
  }
}

testConnection();