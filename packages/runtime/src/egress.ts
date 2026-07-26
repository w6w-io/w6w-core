/**
 * Egress capture — turns one outbound request/response pair into the
 * `EgressInfo` record the host observes via `InvokeOptions.onEgress`.
 *
 * Two capture depths:
 *   - always — host, method, status, byte count, duration (metering);
 *   - opt-in (`captureEgress`) — the full URL, headers and bodies, so a host can
 *     persist an audit/debug log of what an app actually sent and got back.
 *
 * The captured request is the SIGNED one — it carries the credential the auth
 * `sign` hook injected. So capture is redaction-first: credential-bearing
 * headers, query params and request-body fields are replaced with `[redacted]`
 * BEFORE the record leaves this module. A host that persists `EgressInfo` never
 * holds a secret it wasn't already storing itself.
 */
import type { SignableRequest } from "@w6w/types";
import type { WireResponse } from "./sandbox/protocol.ts";

/** Per-body cap for captured request/response payloads. */
export const DEFAULT_EGRESS_BODY_LIMIT = 32 * 1024;

export const REDACTED = "[redacted]";

/** Header names whose value is (or may carry) a credential. */
const SENSITIVE_HEADER =
  /(authorization|cookie|api[-_]?key|apikey|token|secret|password|signature|credential)/i;

/** Query-param names whose value is (or may carry) a credential. */
const SENSITIVE_PARAM = SENSITIVE_HEADER;

/** JSON request-body keys whose value is (or may carry) a credential. */
const SENSITIVE_KEY =
  /^(authorization|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|token|credential)$/i;

/** One outbound (egress) request the runtime made on the app's behalf. */
export interface EgressInfo {
  host: string;
  method: string;
  /** HTTP status, or 0 when the request never produced a response. */
  status: number;
  responseBytes: number;
  durationMs: number;
  /** Full URL with sensitive query params redacted. Capture only. */
  url?: string;
  /** Signed request headers, credential values redacted. Capture only. */
  requestHeaders?: Record<string, string>;
  /** Request body as text, redacted and truncated to the cap. Capture only. */
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  /** Response body as text, truncated to the cap. Capture only. */
  responseBody?: string;
  /** True when a captured body hit the cap and was cut. */
  truncated?: boolean;
  /** Set when the request failed before a response (network / allowlist denial). */
  error?: string;
}

/** Replace credential-bearing header values with `[redacted]`. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADER.test(k) ? REDACTED : v;
  }
  return out;
}

/** Replace credential-bearing query-param values with `[redacted]`. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let touched = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) {
      parsed.searchParams.set(key, REDACTED);
      touched = true;
    }
  }
  return touched ? parsed.toString() : url;
}

/** Recursively replace credential-bearing JSON object values with `[redacted]`. */
function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactJson(v, depth + 1);
  }
  return out;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit
    ? { text: text.slice(0, limit), truncated: true }
    : { text, truncated: false };
}

/**
 * Redact a request body. JSON bodies are re-serialized with sensitive keys
 * masked; anything else (form-encoded, XML, binary) is passed through as text —
 * a form body's credential fields are masked by pattern instead.
 */
function captureRequestBody(body: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return truncate(JSON.stringify(redactJson(JSON.parse(body))), limit);
    } catch { /* not JSON after all — fall through to the raw path */ }
  }
  if (body.includes("=")) {
    // Form-encoded (or close enough): mask `sensitive=value` pairs.
    const masked = body.replace(
      /([^&=?]+)=([^&]*)/g,
      (m, k: string) => (SENSITIVE_PARAM.test(k) ? `${k}=${REDACTED}` : m),
    );
    return truncate(masked, limit);
  }
  return truncate(body, limit);
}

/** Decode response bytes as UTF-8 text, truncating at the cap. */
function captureResponseBody(
  bytes: Uint8Array,
  limit: number,
): { text: string; truncated: boolean } {
  if (!bytes?.length) return { text: "", truncated: false };
  const slice = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, truncated: bytes.length > limit };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export interface CaptureOptions {
  /** Include URL, headers and bodies. Off → the metering-shaped record only. */
  capture?: boolean;
  /** Per-body cap in bytes/chars. Defaults to `DEFAULT_EGRESS_BODY_LIMIT`. */
  bodyLimit?: number;
  durationMs: number;
}

/** Build the `EgressInfo` for a completed request/response pair. */
export function egressInfo(
  request: SignableRequest,
  response: WireResponse,
  opts: CaptureOptions,
): EgressInfo {
  const info: EgressInfo = {
    host: hostOf(request.url),
    method: request.method,
    status: response.status,
    responseBytes: response.body?.length ?? 0,
    durationMs: opts.durationMs,
  };
  if (!opts.capture) return info;

  const limit = opts.bodyLimit ?? DEFAULT_EGRESS_BODY_LIMIT;
  const req = request.body ? captureRequestBody(request.body, limit) : undefined;
  const res = captureResponseBody(response.body ?? new Uint8Array(), limit);
  info.url = redactUrl(request.url);
  info.requestHeaders = redactHeaders(request.headers);
  if (req) info.requestBody = req.text;
  info.responseHeaders = redactHeaders(response.headers ?? {});
  info.responseBody = res.text;
  if (req?.truncated || res.truncated) info.truncated = true;
  return info;
}

/** Build the `EgressInfo` for a request that never produced a response. */
export function egressFailure(
  request: SignableRequest,
  error: unknown,
  opts: CaptureOptions,
): EgressInfo {
  const info: EgressInfo = {
    host: hostOf(request.url),
    method: request.method,
    status: 0,
    responseBytes: 0,
    durationMs: opts.durationMs,
    error: (error as Error)?.message ?? String(error),
  };
  if (!opts.capture) return info;

  const limit = opts.bodyLimit ?? DEFAULT_EGRESS_BODY_LIMIT;
  info.url = redactUrl(request.url);
  info.requestHeaders = redactHeaders(request.headers);
  if (request.body) info.requestBody = captureRequestBody(request.body, limit).text;
  return info;
}
