/**
 * Health Check — a declared, side-effect-free probe an App publishes so a host
 * can answer "is this working?" without guessing.
 * See rfcs/healthcheck.md.
 */
import type { HealthCheckHook } from "./hooks.ts";

/**
 * `unknown` is deliberately distinct from `down`: a status API that itself 500s
 * tells you nothing about the vendor, and reporting that as an outage would be
 * a lie.
 */
export type HealthState = "ok" | "degraded" | "down" | "unknown";

/** What the answer tells you. */
export type HealthKind = "service" | "credential" | "quota" | "dependency";

/**
 * What the answer is about. `app` results are computed once and shared across
 * every Connection — running a vendor status check per Connection would
 * multiply one useful call by the number of users.
 */
export type HealthScope = "app" | "connection";

/**
 * What the check needs on the wire. Three postures, not two: whether a check
 * needs a CREDENTIAL is a different question from whether it is per-CONNECTION.
 *
 * - `none`    — no Connection at all; `ctx.connection` is absent and `sign` never runs.
 *               Vendor status pages, unauthenticated pings.
 * - `context` — the Connection supplies the URL (a tenant subdomain, a self-hosted
 *               site) but no credential is needed to interpret the answer. The hook
 *               sees the redacted Connection; `sign` still never runs.
 * - `signed`  — the credential goes on the wire, injected by `sign` exactly as for
 *               an Action.
 */
export type CredentialPosture = "none" | "context" | "signed";

/** How much a failure is allowed to worsen a roll-up verdict. */
export type HealthSeverity = "fatal" | "degraded" | "informational";

/** Per-component detail inside a report. */
export interface HealthComponentReport {
  state: HealthState;
  message?: string;
}

/** A quota reading. Populated by `kind: "quota"` checks. */
export interface HealthQuota {
  /** Bucket name when the vendor meters several (GitHub's `core`, `search`, …). */
  id?: string;
  limit?: number;
  remaining?: number;
  /** ISO 8601. */
  resetAt?: string;
  /** e.g. `"requests"`, `"tokens"`. */
  unit?: string;
}

/**
 * One entry in a vendor's own structured incident history — populated only
 * when a check reads that history from an API that states it, never from a
 * status feed's prose. See `resolvedAt` below for why that distinction is a
 * hard rule rather than a preference.
 */
export interface HealthTimelineEntry {
  /** Stable identity, when the source states one — an incident id, not a title. */
  id?: string;
  title: string;
  state: HealthState;
  /** Component ids (matching `HealthReport.components`) this entry is about. */
  components?: string[];
  /** ISO 8601 — when the incident began. */
  startedAt?: string;
  /** ISO 8601 — when the incident was last updated. */
  updatedAt?: string;
  /**
   * ISO 8601 — when the incident was resolved. MUST be set only from a field
   * the source states STRUCTURALLY (a vendor API's own `resolved_at`, a
   * machine-readable status code) — never inferred by sniffing an entry's
   * prose for words like "resolved". Absence means "not stated", not "still
   * open": a check that cannot tell the difference must not guess either way,
   * the same discipline `HealthState.unknown` already applies to a whole
   * report.
   */
  resolvedAt?: string;
  /** Link to the vendor's own incident/status page entry, when it has one. */
  link?: string;
}

/**
 * What a check hook returns. A report, not a boolean — one call to a vendor's
 * status API can light up several components, which is how those APIs are
 * actually shaped.
 */
export interface HealthReport {
  state: HealthState;
  /** Human explanation. Rendered verbatim — MUST NOT contain credential material. */
  message?: string;
  /** Component id -> state. Lets one probe report many things. */
  components?: Record<string, HealthComponentReport>;
  quota?: HealthQuota[];
  /** How long a host may serve this result from cache. */
  ttlSeconds?: number;
  /** Host-stamped when the hook omits it. */
  latencyMs?: number;
  /**
   * A structured incident history, when the vendor's own status API exposes
   * one directly (a JSON `/incidents` or `/history` endpoint) rather than
   * only a prose feed. This is a SEPARATE surface from a declared `feed`
   * (`HealthCheckInput.feed`): a feed is host-parsed, generic Atom/RSS,
   * useful when that is all a vendor publishes; `timeline` is vendor-specific
   * structured history the App itself reads and reports back, because only
   * the App knows the shape of that response. A hook returning this is
   * responsible for `resolvedAt`'s structural-only rule above — the field
   * merely gives a report somewhere to put the answer.
   */
  timeline?: HealthTimelineEntry[];
}

/** Declares that no check exists — a positive fact, not an omission. */
export interface HealthUnavailable {
  reason: string;
}

/**
 * A Health Check's serializable configuration — its metadata minus the `check`
 * function. This is what `describe()` returns.
 */
export interface HealthCheck {
  /**
   * Machine name, unique within the App. Lowercase kebab-case. The `auth:`
   * prefix is reserved for checks derived from an Auth method's `test` hook.
   */
  key: string;
  title: string;
  description?: string;
  kind: HealthKind;
  /** Defaults to `app` for `kind: "service"`, `connection` otherwise. */
  scope?: HealthScope;
  /**
   * Selectors this check speaks for, so a host can attribute a failure rather
   * than greying out the whole App: `"*"`, `"action:<key>"`, `"resource:<name>"`,
   * `"auth:<key>"`, `"component:<id>"`. Defaults to `["*"]`.
   */
  covers?: string[];
  /** Defaults to `none` for `kind: "service"`, `signed` otherwise. */
  credential?: CredentialPosture;
  /**
   * Hosts this check may reach, IN ADDITION to the App's allowlist and only
   * inside this hook's worker.
   *
   * Bound to an unsigned posture: a check declaring this MUST be `none` or
   * `context`. Widening egress without that constraint would be a
   * credential-exfiltration path — third-party status hosts are exactly the
   * hosts that must never see a credential.
   */
  network?: { allow?: string[] };
  /**
   * An Atom or RSS status feed the host fetches and parses BEFORE running the
   * hook, handing the result to `check` as `input.feed`.
   *
   * Declared rather than fetched by the hook because the two halves of reading
   * a feed belong in different places: parsing Atom/RSS is generic, fiddly and
   * identical for every publisher, while interpreting what an entry MEANS is
   * vendor-specific and belongs to the App. See rfcs/healthcheck.md
   * § "Feed-backed checks".
   *
   * The feed's host is added to this hook's allowlist implicitly, exactly as
   * OAuth endpoint hosts are — so a publisher need not restate it in `network`.
   * Bound to an unsigned posture for the same reason as `network`: a feed lives
   * on a status host, and status hosts must never see a credential.
   */
  feed?: HealthFeedSource;
  /** Publisher's floor on how often a host may run it. */
  minIntervalSeconds?: number;
  /** Defaults to `fatal` for `kind: "credential"`, `degraded` otherwise. */
  severity?: HealthSeverity;
  /** Present instead of `check` when the vendor publishes nothing. */
  unavailable?: HealthUnavailable;
}

/** Which feed syntax to expect. `auto` (the default) sniffs the payload. */
export type HealthFeedFormat = "atom" | "rss" | "auto";

/** A status feed a check reads. See `HealthCheck.feed`. */
export interface HealthFeedSource {
  /** Absolute http(s) URL of the Atom or RSS document. */
  url: string;
  /**
   * Defaults to `auto`, which detects the syntax from the payload rather than
   * the URL or content-type — status hosts serve both from paths that do not
   * always say which is which.
   */
  format?: HealthFeedFormat;
  /** Cap on entries handed to the hook, newest first. Defaults to 50. */
  limit?: number;
}

/**
 * One feed entry, normalised across Atom and RSS.
 *
 * JSON-safe by construction: this crosses the sandbox boundary, so the
 * timestamp is an ISO string rather than a `Date`.
 */
export interface HealthFeedEntry {
  /**
   * Stable identity — Atom `<id>`, RSS `<guid>`, else the link. Several entries
   * sharing one id are successive UPDATES to the same incident, which is the
   * distinction `latest` exists to resolve.
   */
  id?: string;
  title: string;
  /** Body as plain text: CDATA unwrapped, markup stripped, entities decoded. */
  summary: string;
  /** Body with markup intact, for when the markup carries meaning (an `<li>` list of components). */
  summaryHtml: string;
  link?: string;
  /** ISO 8601. Absent when the entry carried no readable date. */
  publishedAt?: string;
}

/** What the host hands a feed-backed check as `input.feed`. */
export interface HealthFeedInput {
  /** Every entry, newest first, capped at the source's `limit`. */
  entries: HealthFeedEntry[];
  /**
   * The newest entry per `id` — successive updates folded onto the incident
   * they describe, newest first. This is almost always what a check wants: a
   * feed is a log of updates, not a statement of current state, so the newest
   * entry overall says nothing about whether its incident is still open.
   */
  latest: HealthFeedEntry[];
  /**
   * The feed's own channel-level link — Atom's `<link rel="alternate">`, RSS's
   * `<channel><link>` — i.e. the vendor's status PAGE, distinct from this
   * feed document's own URL. A host assembling a check's status-page link
   * tries this FIRST, ahead of `check.network.allow[0]` (rfcs/healthcheck.md
   * § "Feed-backed checks"). Absent when the document states none.
   */
  channelLink?: string;
  /** The feed/channel-level title — Atom's `<title>`, RSS's `<channel><title>`. */
  channelTitle?: string;
  /** ISO 8601 — when the host fetched it. */
  fetchedAt: string;
  /**
   * Set when the feed could not be fetched or parsed; `entries` and `latest`
   * are then empty. A check seeing this should report `unknown`, never `down` —
   * a broken feed says nothing about the vendor.
   */
  error?: string;
}

/**
 * What a health `check` hook receives. Empty unless the check declares a
 * `feed`, so a hook that ignores its input keeps working unchanged.
 */
export interface HealthCheckInput {
  feed?: HealthFeedInput;
}

/**
 * A health-check module's shape: config and probe co-located, the same
 * code-first model as ActionDefinition.
 *
 * ```ts
 * const serviceHealth: HealthCheckDefinition = {
 *   key: "service", title: "Platform status", kind: "service",
 *   network: { allow: ["status.example.com"] },
 *   async check(_input, ctx) { … },
 * };
 * ```
 */
export interface HealthCheckDefinition extends HealthCheck {
  /** Required unless `unavailable` is set. */
  check?: HealthCheckHook;
}

/**
 * The tag that promotes an existing Action into the health surface, so an
 * Action that is already the right probe need not be duplicated. A tagged
 * Action MUST be safe to invoke with `{}`.
 */
export type ActionHealthTag = Omit<HealthCheck, "key" | "title" | "unavailable"> & {
  /** Defaults to the Action's own key. */
  key?: string;
  /** Defaults to the Action's own title. */
  title?: string;
};

// --- default resolution -----------------------------------------------------
// Defaults are conveniences, not couplings: `scope` and `credential` are
// independent axes. A `none` + `connection` check is exactly the `context`
// case, and `signed` + `app` is possible when the credential is host-supplied.

export function healthScope(check: HealthCheck): HealthScope {
  return check.scope ?? (check.kind === "service" ? "app" : "connection");
}

export function healthCredential(check: HealthCheck): CredentialPosture {
  return check.credential ?? (check.kind === "service" ? "none" : "signed");
}

export function healthSeverity(check: HealthCheck): HealthSeverity {
  return check.severity ?? (check.kind === "credential" ? "fatal" : "degraded");
}

export function healthCovers(check: HealthCheck): string[] {
  return check.covers ?? ["*"];
}

/** Does this check speak for `selector` (e.g. `"action:message-post"`)? */
export function coversSelector(check: HealthCheck, selector: string): boolean {
  const covers = healthCovers(check);
  if (covers.includes("*") || covers.includes(selector)) return true;
  // `resource:message` also covers an Action selector the caller cannot expand
  // on its own; callers pass both forms when they know the Action's resource.
  return false;
}

/** Worst-first ordering. `unknown` outranks `ok` so an unverifiable target is never shown healthy. */
export const HEALTH_STATE_RANK: Record<HealthState, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

export function worstHealthState(states: readonly HealthState[]): HealthState {
  let worst: HealthState = "ok";
  for (const s of states) {
    if (HEALTH_STATE_RANK[s] > HEALTH_STATE_RANK[worst]) worst = s;
  }
  return worst;
}
