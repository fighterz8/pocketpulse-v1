import { pool } from "../server/db.js";

async function run() {
  const client = await pool.connect();
  try {
    await client.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dev boolean NOT NULL DEFAULT false"
    );
    console.log("is_dev column added (or already existed)");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
