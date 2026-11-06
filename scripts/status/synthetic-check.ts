// Synthetic checks for the status page: real requests against production in test mode (free).
//
//   VC_TEST_KEY=vc_test_… npx tsx scripts/status/synthetic-check.ts > run.json
//   API_BASE / APP_BASE / SITE_BASE override the URLs (for staging or local).
//
// Prints one JSON run: { at, checks: [{ id, ok, status, ms, error? }] }. Always exits 0 so a failed
// check is recorded rather than stopping the workflow.

export const COMPONENTS = [
  { id: "website", name: "Website", group: "Website and dashboard" },
  { id: "dashboard", name: "Dashboard", group: "Website and dashboard" },
  { id: "api", name: "API gateway", group: "API" },
  { id: "email", name: "Email validation", group: "API" },
  { id: "phone", name: "Phone validation", group: "API" },
  { id: "ip", name: "IP lookups", group: "API" },
  { id: "domain", name: "Domain checks", group: "API" },
  { id: "account", name: "Account and credits", group: "API" },
] as const;

export interface Check {
  id: string;
  ok: boolean;
  status: number;
  ms: number;
  error?: string;
}

const API = (process.env.API_BASE ?? "https://api.validationcheck.net").replace(/\/$/, "");
const APP = (process.env.APP_BASE ?? "https://app.validationcheck.net").replace(/\/$/, "");
const SITE = (process.env.SITE_BASE ?? "https://validationcheck.net").replace(/\/$/, "");
const KEY = process.env.VC_TEST_KEY ?? "";

async function probe(id: string, url: string, init: RequestInit = {}, expect: (status: number, body: unknown) => string | null = (s) => (s === 200 ? null : `HTTP ${s}`)): Promise<Check> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // HTML pages
    }
    const problem = expect(res.status, body);
    return { id, ok: !problem, status: res.status, ms: Date.now() - started, ...(problem ? { error: problem } : {}) };
  } catch (err) {
    return { id, ok: false, status: 0, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A test-mode lookup that must succeed with the documented answer. */
function lookup(id: string, path: string, input: unknown, action: string): Promise<Check> {
  return probe(
    id,
    `${API}${path}`,
    { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(input) },
    (status, body) => {
      if (status !== 200) return `HTTP ${status}${(body as { error?: { code?: string } })?.error?.code ? ` ${(body as { error: { code: string } }).error.code}` : ""}`;
      const got = (body as { data?: { recommendation?: { action?: string } } })?.data?.recommendation?.action;
      return got === action ? null : `Expected ${action}, got ${got}`;
    },
  );
}

export async function runChecks(): Promise<{ at: number; checks: Check[] }> {
  if (!KEY.startsWith("vc_test_")) throw new Error("Set VC_TEST_KEY to a vc_test_ key.");
  const checks = await Promise.all([
    probe("website", `${SITE}/`),
    probe("dashboard", `${APP}/login`),
    probe("api", `${API}/health`, {}, (s, b) => (s === 200 && (b as { status?: string })?.status === "ok" ? null : `HTTP ${s} ${JSON.stringify(b).slice(0, 80)}`)),
    lookup("email", "/v1/email", { email: "valid@test.validationcheck.net" }, "approve"),
    lookup("phone", "/v1/phone", { phone: "+15550100001" }, "approve"),
    lookup("ip", "/v1/ip", { ip: "203.0.113.10" }, "approve"),
    lookup("domain", "/v1/domain/age", { domain: "example.com" }, "approve"),
    probe("account", `${API}/v1/account`, { headers: { Authorization: `Bearer ${KEY}` } }),
  ]);
  return { at: Date.now(), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runChecks()));
}
