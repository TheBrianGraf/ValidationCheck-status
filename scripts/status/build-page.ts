// Builds the public status page from synthetic-check runs. Used by .github/workflows/status.yml:
//
//   npx tsx scripts/status/build-page.ts <run.json> <site-dir>
//
// <site-dir> holds history.json from earlier runs (created if missing). Writes history.json,
// status.json (for ops-hub and anyone polling) and index.html. Incidents are written by hand in
// scripts/status/incidents.json: [{ "title", "status": "investigating|identified|monitoring|resolved",
// "started": ISO, "resolved"?: ISO, "components": ["email"], "updates": [{ "at": ISO, "text" }] }].
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENTS, type Check } from "./synthetic-check";

type Run = { at: number; checks: Check[] };
/** One run, compact: component id → [ok, ms]. */
type Entry = { t: number; c: Record<string, [0 | 1, number]> };
/**
 * Every run from the last two days (for current state and latency) plus per-day counts for 90
 * days (for the bars and uptime), so the file stays small.
 */
export type History = { recent: Entry[]; daily: Record<string, Record<string, [ok: number, total: number]>> };
type Incident = { title: string; status: string; started: string; resolved?: string; components?: string[]; updates?: Array<{ at: string; text: string }> };

const DAY = 86_400_000;
const KEEP_DAYS = 90;
const RECENT_MS = 2 * DAY;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function emptyHistory(): History {
  return { recent: [], daily: {} };
}

export function addRun(history: History, run: Run): History {
  const entry: Entry = { t: run.at, c: Object.fromEntries(run.checks.map((c) => [c.id, [c.ok ? 1 : 0, c.ms]])) };
  const key = dayKey(run.at);
  const today = { ...(history.daily[key] ?? {}) };
  for (const c of run.checks) {
    const [ok, total] = today[c.id] ?? [0, 0];
    today[c.id] = [ok + (c.ok ? 1 : 0), total + 1];
  }
  const oldest = dayKey(run.at - (KEEP_DAYS - 1) * DAY);
  const daily = Object.fromEntries(Object.entries({ ...history.daily, [key]: today }).filter(([d]) => d >= oldest));
  return { recent: [...history.recent, entry].filter((e) => e.t > run.at - RECENT_MS), daily };
}

export type State = "operational" | "degraded" | "down" | "unknown";

/** Down: the last two runs failed. Degraded: the last run failed, or it was slow (over 5 s). */
export function componentState(history: History, id: string): State {
  const recent = history.recent.filter((e) => e.c[id]).slice(-2);
  if (!recent.length) return "unknown";
  const last = recent.at(-1)!.c[id]!;
  if (recent.length === 2 && recent.every((e) => e.c[id]![0] === 0)) return "down";
  if (last[0] === 0 || last[1] > 5000) return "degraded";
  return "operational";
}

/** Share of successful checks on the days from `since` (UTC) to today. */
export function uptime(history: History, id: string, since: number): number | null {
  let ok = 0;
  let total = 0;
  for (const [day, counts] of Object.entries(history.daily)) {
    if (day < dayKey(since) || !counts[id]) continue;
    ok += counts[id]![0];
    total += counts[id]![1];
  }
  return total ? ok / total : null;
}

function dayUptime(history: History, id: string, day: string): number | null {
  const c = history.daily[day]?.[id];
  return c && c[1] ? c[0] / c[1] : null;
}

/** Uptime over the last 24 hours exactly, from the detailed runs. */
function recentUptime(history: History, id: string, since: number): number | null {
  const runs = history.recent.filter((e) => e.t >= since && e.c[id]);
  return runs.length ? runs.filter((e) => e.c[id]![0] === 1).length / runs.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const STATE_TEXT: Record<State, string> = { operational: "Operational", degraded: "Degraded", down: "Outage", unknown: "No data" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (v: number | null) => (v === null ? "—" : `${(Math.floor(v * 10000) / 100).toFixed(2)}%`);

export function buildStatus(history: History, now: number, incidents: Incident[]) {
  const components = COMPONENTS.map((c) => ({
    id: c.id,
    name: c.name,
    group: c.group,
    state: componentState(history, c.id),
    uptime: { day: recentUptime(history, c.id, now - DAY), week: uptime(history, c.id, now - 6 * DAY), ninety: uptime(history, c.id, now - (KEEP_DAYS - 1) * DAY) },
    latencyMs: median(history.recent.filter((e) => e.t >= now - DAY && e.c[c.id]?.[0]).map((e) => e.c[c.id]![1])),
    days: Array.from({ length: KEEP_DAYS }, (_, i) => dayUptime(history, c.id, dayKey(now - (KEEP_DAYS - 1 - i) * DAY))),
  }));
  const order: State[] = ["down", "degraded", "unknown", "operational"];
  const open = incidents.filter((i) => i.status !== "resolved");
  const overall = order.find((s) => components.some((c) => c.state === s && s !== "unknown")) ?? "operational";
  return { updated: new Date(now).toISOString(), overall: open.length && overall === "operational" ? "degraded" : overall, components, incidents };
}

function page(s: ReturnType<typeof buildStatus>): string {
  const banner = {
    operational: ["All systems operational", "ok"],
    degraded: ["Some systems are degraded", "warn"],
    down: ["Partial outage", "bad"],
    unknown: ["Checking…", "warn"],
  }[s.overall as State];
  const groups = [...new Set(s.components.map((c) => c.group))];
  const bar = (v: number | null) => `<i class="d ${v === null ? "n" : v >= 0.999 ? "ok" : v >= 0.95 ? "warn" : "bad"}" title="${v === null ? "No data" : pct(v)}"></i>`;
  const incidents = s.incidents
    .slice()
    .sort((a, b) => b.started.localeCompare(a.started))
    .slice(0, 10)
    .map(
      (i) => `<article class="inc"><h3>${esc(i.title)} <span class="tag ${i.status === "resolved" ? "ok" : "warn"}">${esc(i.status)}</span></h3>
      <p class="muted">${new Date(i.started).toUTCString()}${i.resolved ? ` → ${new Date(i.resolved).toUTCString()}` : ""}</p>
      ${(i.updates ?? []).map((u) => `<p><b>${new Date(u.at).toUTCString().slice(17, 22)} UTC</b> ${esc(u.text)}</p>`).join("")}</article>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ValidationCheck Status</title><meta name="description" content="Live status of the ValidationCheck API, dashboard and website.">
<meta http-equiv="refresh" content="300"><link rel="alternate" type="application/json" href="status.json">
<style>
:root{--bg:#f6f7fb;--card:#fff;--fg:#0b1220;--muted:#5b6478;--line:#e6e8ef;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--none:#cfd4df}
@media (prefers-color-scheme:dark){:root{--bg:#070b14;--card:#0e1524;--fg:#e8edf7;--muted:#9aa7bf;--line:#1c2538;--none:#2a3346}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
a{color:inherit}.brand{font-weight:700;font-size:18px;text-decoration:none}.muted{color:var(--muted);font-size:13px}
.banner{margin:24px 0;padding:18px 20px;border-radius:14px;color:#fff;font-weight:600;font-size:17px}.banner.ok{background:var(--ok)}.banner.warn{background:var(--warn)}.banner.bad{background:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:6px 20px;margin-bottom:16px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:20px 0 8px}
.row{padding:14px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}.top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.tag{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px}.tag.ok,.state-operational{color:var(--ok)}.tag.warn,.state-degraded,.state-unknown{color:var(--warn)}.state-down{color:var(--bad)}
.bars{display:flex;gap:2px;margin:10px 0 4px}.d{flex:1;height:28px;border-radius:2px;background:var(--none)}.d.ok{background:var(--ok)}.d.warn{background:var(--warn)}.d.bad{background:var(--bad)}
.legend{display:flex;justify-content:space-between}.inc{border-bottom:1px solid var(--line);padding:14px 0}.inc:last-child{border:0}.inc h3{margin:0;font-size:16px}
</style></head><body><main>
<header><a class="brand" href="https://validationcheck.net">ValidationCheck <span class="muted">Status</span></a><span class="muted">Updated ${new Date(s.updated).toUTCString()} · checks every hour · <a href="status.json">JSON</a></span></header>
<div class="banner ${banner[1]}">${banner[0]}</div>
${s.incidents.some((i) => i.status !== "resolved") ? `<h2>Current incidents</h2><div class="card">${incidents}</div>` : ""}
${groups
  .map(
    (g) => `<h2>${esc(g)}</h2><div class="card">${s.components
      .filter((c) => c.group === g)
      .map(
        (c) => `<div class="row"><div class="top"><b>${esc(c.name)}</b><span class="state-${c.state}">${STATE_TEXT[c.state]}</span></div>
<div class="bars">${c.days.map(bar).join("")}</div>
<div class="legend muted"><span>90 days ago</span><span>${pct(c.uptime.ninety)} uptime · 24 h ${pct(c.uptime.day)}${c.latencyMs !== null ? ` · ${c.latencyMs} ms` : ""}</span><span>Today</span></div></div>`,
      )
      .join("")}</div>`,
  )
  .join("")}
${s.incidents.some((i) => i.status === "resolved") ? `<h2>Past incidents</h2><div class="card">${incidents}</div>` : ""}
<p class="muted">Checks run from GitHub Actions against production in test mode and don't depend on our own infrastructure. Questions: <a href="mailto:support@validationcheck.net">support@validationcheck.net</a></p>
</main></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [runPath, siteDir] = process.argv.slice(2);
  if (!runPath || !siteDir) throw new Error("Usage: build-page.ts <run.json> <site-dir>");
  mkdirSync(siteDir, { recursive: true });
  const historyPath = join(siteDir, "history.json");
  const stored = existsSync(historyPath) ? (JSON.parse(readFileSync(historyPath, "utf8")) as History) : null;
  const history = stored && Array.isArray(stored.recent) ? stored : emptyHistory();
  const run = JSON.parse(readFileSync(runPath, "utf8")) as Run;
  const incidentsPath = join(dirname(fileURLToPath(import.meta.url)), "incidents.json");
  const incidents = existsSync(incidentsPath) ? (JSON.parse(readFileSync(incidentsPath, "utf8")) as Incident[]) : [];
  const next = addRun(history, run);
  const status = buildStatus(next, run.at, incidents);
  writeFileSync(historyPath, JSON.stringify(next));
  writeFileSync(join(siteDir, "status.json"), JSON.stringify(status, null, 2));
  writeFileSync(join(siteDir, "index.html"), page(status));
  writeFileSync(join(siteDir, "CNAME"), "status.validationcheck.net\n");
  console.log(`${status.overall}: ${status.components.map((c) => `${c.id}=${c.state}`).join(" ")}`);
}
