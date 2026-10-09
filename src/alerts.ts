import { getPollFailureState, logEvent, setPollAlertedAt } from "./db";
import type { Env } from "./types";

const REALERT_AFTER_MS = 6 * 60 * 60_000;

/** Best-effort push to ALERT_WEBHOOK_URL; a dead webhook must never break the poll itself. */
async function notify(env: Env, message: string) {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "text" is Slack's field, "content" is Discord's.
      body: JSON.stringify({ text: message, content: message }),
    });
  } catch (err) {
    console.warn(`alert webhook failed: ${err}`);
  }
}

/** Call after a failed poll has been recorded. Raises once the failure streak hits the threshold. */
export async function alertIfPollerFailing(env: Env, error: string, now: string) {
  const threshold = Number(env.POLLER_FAILURE_ALERT_RUNS) || 3;
  const state = await getPollFailureState(env.DB);
  if (!state || state.consecutive_failures < threshold) return;
  if (state.last_alert_at && Date.parse(now) - Date.parse(state.last_alert_at) < REALERT_AFTER_MS) return;

  const message = `runner-fleet-dashboard: poller has failed ${state.consecutive_failures} runs in a row, so runner data is stale. Last error: ${error.slice(0, 300)}`;
  await logEvent(env.DB, { severity: "error", kind: "poller_failing", message }, now);
  await setPollAlertedAt(env.DB, now);
  await notify(env, message);
}

/** Call before a successful poll is recorded, while the failure streak is still readable. */
export async function alertIfPollerRecovered(env: Env, now: string) {
  const threshold = Number(env.POLLER_FAILURE_ALERT_RUNS) || 3;
  const state = await getPollFailureState(env.DB);
  if (!state || state.consecutive_failures < threshold) return;

  const message = `runner-fleet-dashboard: poller recovered after ${state.consecutive_failures} failed runs`;
  await logEvent(env.DB, { severity: "info", kind: "poller_recovered", message }, now);
  await notify(env, message);
}
