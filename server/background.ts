import { waitUntil } from "@vercel/functions";

export function scheduleBackgroundTask(
  task: Promise<unknown>,
  label: string,
): void {
  const wrapped = task.catch((err) => {
    console.error(`[background] ${label} failed:`, err);
  });

  if (process.env.VERCEL) {
    waitUntil(wrapped);
    return;
  }

  void wrapped;
}
