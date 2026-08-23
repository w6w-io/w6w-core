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
import type {
  Connection,
  HealthCheck,
  HealthCheckInput,
  HealthFeedInput,
  HealthReport,
  HealthState,
} from "@w6w/types";
import { healthCredential, healthScope, healthSeverity, redact } from "@w6w/types";
import type { LoadedApp, LoadedAuth, LoadedHealthCheck } from "./loader.ts";
import { W6WError } from "./errors.ts";
import { runHook } from "./sandbox/run-hook.ts";
import { signingFetch } from "./runtime.ts";
import { latestPerId, parseFeed } from "./feed.ts";

/** Entries handed to a hook when the source names no `limit`. */
const DEFAULT_FEED_LIMIT = 50;

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

  // The operator-facing half of every failure below. Nothing a probe failure
  // reveals is fit for `report.message`, and nothing it reveals should be thrown
  // away either — this is where the difference goes.
  const diagnose = (message: string, data?: unknown) =>
    opts.onLog?.("error", `health: ${app.manifest.id}: ${message}`, data);

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
    // A declared feed is fetched and parsed HOST-side, before the hook runs, so
    // the App receives entries rather than XML. See `fetchFeed`.
    const input: HealthCheckInput = check.feed
      ? { feed: await fetchFeed(app, loaded, opts, now, diagnose) }
      : {};
    const report = await runHealthHook(app, loaded, posture, opts, input);
    return stamp(normalizeReport(report, diagnose));
  } catch (err) {
    diagnose(`check "${key}" failed`, { error: (err as Error)?.message ?? String(err) });
    return stamp({ state: "unknown", message: probeFailureMessage(err) });
  }
}

/**
 * What a reader is told when a probe could not complete.
 *
 * `report.message` is rendered VERBATIM to end users (rfcs/healthcheck.md), so
 * nothing that was not written FOR an end user may land in it. A transport error
 * is the clearest violation: `invalid peer certificate: certificate is only valid
 * for DnsName("*.statuspage.io")` is a true fact about a vendor's TLS config and
 * a useless one to the person reading a status pill — it names a host they never
 * asked about, cannot be acted on, and reads like OUR failure rather than a gap
 * in what the vendor publishes.
 *
 * Two sentences, because a reader can act on the difference: a source that did
 * not answer in time may well answer on the next run, while one that could not be
 * read at all usually means it moved and the App needs updating. Neither names a
 * host, a certificate, or a status code — `state: "unknown"` already carries "we
 * could not tell", and the sentence only has to say why in terms the reader
 * shares. The raw error is not discarded; it goes to `onLog`, where an operator
 * can still find it.
 */
function probeFailureMessage(err: unknown): string {
  const timedOut = err instanceof W6WError && err.code === "hook_timeout";
  return timedOut
    ? "The status check did not complete in time."
    : "The status check could not be completed.";
}

/**
 * A hook may return anything; keep only what the report contract allows.
 *
 * A malformed report is an App bug, not a vendor fact, so the offending value is
 * logged rather than interpolated into the message — same rule as
 * `probeFailureMessage`: what reaches `message` is written for the reader.
 */
function normalizeReport(
  value: unknown,
  diagnose: (message: string, data?: unknown) => void,
): HealthReport {
  if (typeof value !== "object" || value === null) {
    diagnose("check returned no report", { value });
    return { state: "unknown", message: "The status check returned no result." };
  }
  const r = value as HealthReport;
  const states: HealthState[] = ["ok", "degraded", "down", "unknown"];
  if (!states.includes(r.state)) {
    diagnose("check returned an unrecognised state", { state: r.state });
    return { state: "unknown", message: "The status check returned an unrecognised result." };
  }
  return r;
}

/**
 * Fetch and parse a check's declared feed, host-side.
 *
 * Host-side and not in the hook because parsing Atom/RSS is generic and
 * identical for every publisher, while interpreting an entry is vendor-specific
 * — so the host does the part that is the same everywhere, and the App does the
 * part only it knows. The request is unsigned by construction (the posture rule
 * on `feed` guarantees it) and constrained to the check's own allowlist, into
 * which the feed's host was folded at load time.
 *
 * Never throws: a feed that cannot be read becomes `error` on the input, and a
 * check that sees it should report `unknown` — a broken feed says nothing about
 * the vendor.
 *
 * `error` is a fixed, end-user sentence rather than the underlying reason,
 * because the RFC's own worked pattern is `if (feed?.error) return { state:
 * "unknown", message: feed.error }` — so whatever this string holds is rendered
 * verbatim to a reader by every check that follows the pattern. A host that put
 * `feed fetch failed: <transport error>` here would be leaking its internals
 * through App code that did nothing wrong. The reason goes to `diagnose`.
 */
async function fetchFeed(
  app: LoadedApp,
  loaded: LoadedHealthCheck,
  opts: CheckHealthOptions,
  now: () => Date,
  diagnose: (message: string, data?: unknown) => void,
): Promise<HealthFeedInput> {
  const source = loaded.check.feed!;
  const fetchedAt = now().toISOString();
  const empty = (detail: string): HealthFeedInput => {
    diagnose(`feed for check "${loaded.check.key}" could not be read`, {
      url: source.url,
      detail,
    });
    return {
      entries: [],
      latest: [],
      fetchedAt,
      error: "The status feed could not be read.",
    };
  };

  try {
    // No auth: `feed` is bound to an unsigned posture, so `sign` never runs and
    // a status host never sees a credential.
    const res = await signingFetch(app, undefined, undefined, {
      timeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
    }, loaded.netAllowlist)({
      url: source.url,
      method: "GET",
      headers: { accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9" },
    });
    if (res.status < 200 || res.status >= 300) {
      return empty(`feed returned ${res.status}`);
    }
    const entries = parseFeed(new TextDecoder().decode(res.body), source.format ?? "auto");
    const limit = source.limit ?? DEFAULT_FEED_LIMIT;
    const capped = entries.slice(0, limit);
    return { entries: capped, latest: latestPerId(capped), fetchedAt };
  } catch (err) {
    return empty(`feed fetch failed: ${(err as Error).message}`);
  }
}

function runHealthHook(
  app: LoadedApp,
  loaded: LoadedHealthCheck,
  posture: ReturnType<typeof healthCredential>,
  opts: CheckHealthOptions,
  input: HealthCheckInput,
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
    input,
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
