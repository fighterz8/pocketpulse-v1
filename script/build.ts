import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

rmSync(path.join(root, "dist"), { recursive: true, force: true });
execSync("vite build", { stdio: "inherit", cwd: root, env: process.env });
execSync("tsc -p tsconfig.build.json", { stdio: "inherit", cwd: root, env: process.env });
