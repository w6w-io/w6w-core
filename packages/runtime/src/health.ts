/**
 * Health checks — running an App's declared probes and rolling the results up.
 * See rfcs/healthcheck.md.
 *
 * The posture rules the RFC states are enforced here, not merely documented:
 *
 *   - a `none` check gets no Connection and no `sign`;
 *   - a `context` check gets the REDACTED Connection and still no `sign`;
 *   - only a `signed` check is routed through the auth `sign` hook;
 *   - a check's extra `network.allow` hosts are honoured only when unsigned,
 *     so widening egress can never hand a third party the credential.
 */
import type { Connection, HealthCheck, HealthReport, HealthState } from "@w6w/types";
import { healthCredential, healthScope, healthSeverity, redact } from "@w6w/types";
import type { LoadedApp, LoadedAuth, LoadedHealthCheck } from "./loader.ts";
import { runHook } from "./sandbox/run-hook.ts";
import { signingFetch } from "./runtime.ts";

/** One check's outcome, with enough provenance to attribute a verdict. */
export interface HealthResult {
  key: string;
  check: HealthCheck;
  report: HealthReport;
  /** Host-stamped, ISO 8601. */
  checkedAt: string;
  durationMs: number;
}

export interface CheckHealthOptions {
  /** Required for a `context` or `signed` check; ignored by a `none` one. */
  connection?: Connection;
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
  /** Injected so results are stampable without the runtime reaching for a clock. */
  now?: () => Date;
}

/**
 * Run one declared health check.
 *
 * Never throws for a failing probe: a health check that threw would be
 * indistinguishable from a host bug, and the whole point is to report. A hook
 * that blows up becomes `state: "unknown"` — the vendor might be fine; we just
 * cannot tell.
 */
export async function checkHealth(
  app: LoadedApp,
  key: string,
  opts: CheckHealthOptions = {},
): Promise<HealthResult> {
  const loaded = app.healthChecks.get(key);
  if (!loaded) {
    throw new Error(`App "${app.manifest.id}" declares no health check "${key}".`);
  }
  const { check } = loaded;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();

  const stamp = (report: HealthReport): HealthResult => {
    const finishedAt = now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    return {
      key,
      check,
      report: { latencyMs: durationMs, ...report },
      checkedAt: finishedAt.toISOString(),
      durationMs,
    };
  };

  // An `unavailable` declaration is a positive fact, not a failure: the vendor
  // publishes nothing, and saying so is more useful than a silent gap.
  if (check.unavailable) {
    return stamp({ state: "unknown", message: check.unavailable.reason });
  }
  if (!loaded.hasHook) {
    return stamp({ state: "unknown", message: "check declares no probe" });
  }

  const posture = healthCredential(check);
  if (posture !== "none" && !opts.connection) {
    return stamp({
      state: "unknown",
      message: `check requires a connection (credential: "${posture}")`,
    });
  }

  try {
    const report = await runHealthHook(app, loaded, posture, opts);
    return stamp(normalizeReport(report));
  } catch (err) {
    return stamp({
      state: "unknown",
      message: `probe failed: ${(err as Error).message}`,
    });
  }
}

/** A hook may return anything; keep only what the report contract allows. */
function normalizeReport(value: unknown): HealthReport {
  if (typeof value !== "object" || value === null) {
    return { state: "unknown", message: "probe returned no report" };
  }
  const r = value as HealthReport;
  const states: HealthState[] = ["ok", "degraded", "down", "unknown"];
  if (!states.includes(r.state)) {
    return { state: "unknown", message: `probe returned an unrecognised state: ${r.state}` };
  }
  return r;
}

function runHealthHook(
  app: LoadedApp,
  loaded: LoadedHealthCheck,
  posture: ReturnType<typeof healthCredential>,
  opts: CheckHealthOptions,
): Promise<unknown> {
  const conn = opts.connection;
  // Passing `auth: undefined` is how the caller says "do not sign this", which
  // is the whole contract for a `none` or `context` check.
  const auth: LoadedAuth | undefined = posture === "signed" && conn
    ? app.auths.find((a) => a.auth.key === conn.auth) ?? app.auths[0]
    : undefined;

  return runHook<unknown>({
    entryPath: app.entryPath,
    selector: { kind: "health", key: loaded.check.key },
    input: {},
    readScope: app.dir,
    timeoutMs: opts.timeoutMs,
    onLog: opts.onLog,
    // `none` sees no Connection at all — a status page has no business knowing
    // who is asking. `context` sees the redacted projection, never a credential.
    connection: posture === "none" || !conn ? undefined : redact(conn),
    onFetch: signingFetch(
      app,
      auth,
      posture === "signed" ? conn?.credential : undefined,
      { timeoutMs: opts.timeoutMs, onLog: opts.onLog },
      loaded.netAllowlist,
    ),
  });
}

// --- roll-up ----------------------------------------------------------------

export interface HealthVerdict {
  state: HealthState;
  /** Keys of the checks that produced the verdict, so a UI can say what broke. */
  attributedTo: string[];
  results: HealthResult[];
}

/**
 * Roll many results into one verdict, per the RFC's algorithm.
 *
 * `unknown` ranks above `ok` so an unverifiable target is never presented as
 * healthy, and below `degraded` so a broken status page never masquerades as a
 * vendor outage. An `informational` check never worsens the verdict.
 */
export function rollUpHealth(
  results: readonly HealthResult[],
  opts: { now?: () => Date } = {},
): HealthVerdict {
  const now = (opts.now ?? (() => new Date()))().getTime();
  const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

  let state: HealthState = "ok";
  const attributedTo: string[] = [];

  for (const r of results) {
    const severity = healthSeverity(r.check);
    if (severity === "informational") continue;

    // A result past its ttl tells us nothing current.
    let s = r.report.state;
    const ttl = r.report.ttlSeconds;
    if (ttl !== undefined && now - new Date(r.checkedAt).getTime() > ttl * 1000) {
      s = "unknown";
    }

    // `degraded` severity caps how bad a failure is allowed to make the verdict.
    const effective: HealthState = severity === "degraded" && s === "down" ? "degraded" : s;
    if (RANK[effective] > RANK[state]) {
      state = effective;
      attributedTo.length = 0;
    }
    if (RANK[effective] === RANK[state] && effective !== "ok") attributedTo.push(r.key);
  }

  return { state, attributedTo, results: [...results] };
}

/** Checks that speak for `selector` — `"*"`, `"action:x"`, `"auth:y"`, … */
export function checksCovering(app: LoadedApp, selector: string): LoadedHealthCheck[] {
  return [...app.healthChecks.values()].filter(({ check }) => {
    const covers = check.covers ?? ["*"];
    return covers.includes("*") || covers.includes(selector);
  });
}

/** Checks a host should run per Connection rather than once per App. */
export function connectionScopedChecks(app: LoadedApp): LoadedHealthCheck[] {
  return [...app.healthChecks.values()].filter((h) => healthScope(h.check) === "connection");
}

/** Checks whose result is shared across every Connection of the App. */
export function appScopedChecks(app: LoadedApp): LoadedHealthCheck[] {
  return [...app.healthChecks.values()].filter((h) => healthScope(h.check) === "app");
}
