import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

execSync("vite build", { stdio: "inherit", cwd: root, env: process.env });
execSync("tsc -p tsconfig.build.json", { stdio: "inherit", cwd: root, env: process.env });
