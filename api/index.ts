import { createApp } from "../server/routes.js";

const app = createApp({ runStartupJobs: false });

export default app;
