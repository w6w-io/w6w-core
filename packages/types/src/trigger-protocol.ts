/**
 * Trigger protocol declaration (rfcs/trigger-protocol.md §Shape › Manifest
 * declaration). A protocol trigger is delivered by a partner that w6w registers
 * with and that signs its fires; the app declares the partner endpoint once, and
 * each trigger declares which events it delivers.
 *
 * ONE pure shape check lives here so every enforcement point (the loader, the
 * validator, the registry's artifact arm, the host's registration and fire
 * paths) agrees on what a valid declaration is. No I/O, no Deno APIs.
 */
import type { Trigger } from "./trigger.ts";

/** App-level block: where the partner's registration API and signing keys live. */
export interface ProtocolManifest {
  /** Origin (and optional path prefix) of the partner API. */
  baseUrl: string;
  /** Where the partner publishes the public keys that sign fires. */
  jwksUrl: string;
  /** Protocol versions the app speaks. v1: `[1]`. */
  versions: number[];
}

/** Trigger-level block: which partner events this trigger delivers. */
export interface TriggerProtocol {
  /** Event types delivered (at least one). */
  events: string[];
  /** Filter grammar versions the trigger accepts. Default `[1]`. */
  filters?: { versions: number[] };
}

/** The only value `Trigger.delivery` may take. */
export const PROTOCOL_DELIVERY = "w6w-protocol" as const;

/** Hooks a protocol trigger must not declare: the host is the registration client. */
const FORBIDDEN_HOOKS = ["onSubscribe", "onUnsubscribe", "poll"] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);

/** True iff the trigger is delivered by the protocol (`delivery` set, or a pre-derived `type`). */
export function isProtocolTrigger(t: { delivery?: unknown; type?: unknown }): boolean {
  return t.delivery === PROTOCOL_DELIVERY || t.type === "protocol";
}

/** True iff the app declares the protocol anywhere: the manifest block or any protocol trigger. */
export function appDeclaresProtocol(
  manifest: { protocol?: unknown },
  triggers: ReadonlyArray<{ delivery?: unknown; type?: unknown }>,
): boolean {
  return manifest.protocol !== undefined || triggers.some(isProtocolTrigger);
}

/**
 * The partner event type one subscription of `trigger` registers (RFC rule 5): the
 * single `protocol.events` entry, else the `eventType` param's value when it is
 * one of `events`, else undefined.
 */
export function protocolEventType(
  trigger: { protocol?: { events?: readonly string[] } },
  params: Record<string, unknown> | undefined,
): string | undefined {
  const events = trigger.protocol?.events;
  if (!Array.isArray(events) || events.length === 0) return undefined;
  if (events.length === 1) return events[0];
  const v = params?.eventType;
  return typeof v === "string" && events.includes(v) ? v : undefined;
}

function urlErrors(field: string, raw: unknown, allow: readonly string[]): string[] {
  const at = `protocol.${field}`;
  if (typeof raw !== "string" || raw.length === 0) return [`${at} is required and must be a URL`];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [`${at} is not a parseable absolute URL`];
  }
  const out: string[] = [];
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(host)) {
      out.push(`${at} must use https (http is accepted only for a loopback host)`);
    }
  } else if (u.protocol !== "https:") {
    out.push(`${at} must use https`);
  }
  if (u.username !== "" || u.password !== "") out.push(`${at} must not carry userinfo`);
  if (u.search !== "" || raw.includes("?")) out.push(`${at} must not carry a query`);
  if (u.hash !== "" || raw.includes("#")) out.push(`${at} must not carry a fragment`);
  // Literal host equality only: no `*`, no `*.suffix`, no substring.
  const bare = host.replace(/^\[|\]$/g, "");
  const listed = allow.some((a) => {
    const l = a.toLowerCase();
    return l === host || l === bare;
  });
  if (!listed) out.push(`${at} host "${host}" must appear literally in network.allow`);
  return out;
}

/**
 * Every violation of the protocol declaration, one message each. Empty = valid.
 * `triggers` are the loaded form: the trigger config plus the hooks it defines.
 */
export function protocolDeclarationErrors(
  manifest: { protocol?: unknown; network?: unknown },
  triggers: ReadonlyArray<{ trigger: Trigger; hooks: Iterable<string> }>,
): string[] {
  const out: string[] = [];
  const block = manifest.protocol;
  if (block !== undefined) {
    if (!isObj(block)) {
      out.push("protocol must be an object");
    } else {
      const allowRaw = isObj(manifest.network) ? manifest.network.allow : undefined;
      const allow = Array.isArray(allowRaw)
        ? allowRaw.filter((a): a is string => typeof a === "string")
        : [];
      out.push(...urlErrors("baseUrl", block.baseUrl, allow));
      out.push(...urlErrors("jwksUrl", block.jwksUrl, allow));
      const v = block.versions;
      if (
        !Array.isArray(v) || v.length === 0 || !v.every((n) => Number.isInteger(n)) ||
        !v.includes(1)
      ) {
        out.push("protocol.versions must be a non-empty integer array containing 1");
      }
    }
  }

  for (const { trigger, hooks } of triggers) {
    if (!isProtocolTrigger(trigger)) continue;
    const who = `Trigger "${trigger.key}"`;
    if (block === undefined) {
      out.push(`${who} is delivered by the protocol but the app declares no \`protocol\` block`);
    }
    if (trigger.delivery !== PROTOCOL_DELIVERY) {
      out.push(`${who} must set \`delivery\` to "${PROTOCOL_DELIVERY}"`);
    }
    const p: unknown = trigger.protocol;
    const events = isObj(p) ? p.events : undefined;
    const eventsOk = Array.isArray(events) && events.length > 0 &&
      events.every((e) => typeof e === "string" && e.length > 0);
    if (!eventsOk) {
      out.push(`${who} \`protocol.events\` must be a non-empty array of non-empty strings`);
    }
    const declared = new Set(hooks);
    for (const h of FORBIDDEN_HOOKS) {
      if (declared.has(h)) {
        out.push(
          `${who} declares \`${h}\`: the host is the registration client of a protocol trigger`,
        );
      }
    }
    if (eventsOk && (events as string[]).length > 1) {
      const sel = (trigger.params ?? []).find((q) => q.key === "eventType");
      const opts = sel?.options;
      const values = Array.isArray(opts) ? opts.map((o) => String(o.value)) : undefined;
      if (
        sel?.type !== "select" || values === undefined || values.length === 0 ||
        !values.every((x) => (events as string[]).includes(x))
      ) {
        out.push(
          `${who} lists several events, so it must declare an \`eventType\` select param whose options are a subset of \`protocol.events\``,
        );
      }
    }
  }
  return out;
}
