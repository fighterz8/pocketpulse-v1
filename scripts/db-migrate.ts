import { runMigrations } from "../server/migrations.js";

await runMigrations();
console.log("migrations applied");
process.exit(0);
