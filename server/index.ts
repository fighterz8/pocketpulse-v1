import http from "node:http";

import { createApp } from "./routes.js";

const app = createApp();
const isProduction = process.env.NODE_ENV === "production";
const port = Number(
  isProduction ? (process.env.PORT ?? "5000") : (process.env.API_PORT ?? "5001"),
);
const server = http.createServer(app);

if (isProduction) {
  const { setupStatic } = await import("./static.js");
  setupStatic(app);
} else {
  const { setupVite } = await import("./vite.js");
  await setupVite(app, server);
}

server.listen(port, () => {
  console.log(`server listening on ${port}`);
});
