/**
 * GitHub's runners API sometimes reports every runner offline while they are online and running
 * jobs. On 2026-11-24 from 03:02 UTC it did so in windows of up to ~6 minutes (two polls), every
 * 10-15 minutes, with one runner mid-job and the hosts' telemetry still arriving. Each window
 * turned the whole dashboard red and logged a runner_offline event per runner. So an online runner is only shown offline once GitHub
 * has said so on `confirmPolls` polls in a row; until then it keeps its previous status and busy
 * flag, which also keeps its current job on the page.
 */
export interface PrevRunner {
  status: string;
  busy: number;
  offline_reports: number;
}

export interface EffectiveStatus {
  status: string;
  busy: boolean;
  offlineReports: number;
  /** True while a fresh offline report is being held back. */
  held: boolean;
}

export function effectiveRunnerStatus(
  reported: { status: string; busy: boolean },
  prev: PrevRunner | undefined,
  confirmPolls: number,
): EffectiveStatus {
  if (reported.status !== "offline") {
    return { status: reported.status, busy: reported.busy, offlineReports: 0, held: false };
  }
  const offlineReports = (prev?.offline_reports ?? 0) + 1;
  // A runner never seen before, or one already shown offline, has nothing to hold on to.
  if (!prev || prev.status === "offline" || offlineReports >= confirmPolls) {
    return { status: "offline", busy: reported.busy, offlineReports, held: false };
  }
  return { status: prev.status, busy: prev.busy === 1, offlineReports, held: true };
}
