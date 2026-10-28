/**
 * RS256 signing over WebCrypto. Algorithm mirrors `apps/apps/snowflake/lib/jwt.ts`
 * (base64Url, normalizePem, pemToPkcs8, importSigningKey), except the key is imported
 * non-extractable and failures never interpolate the WebCrypto error.
 */

const enc = new TextEncoder();

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (no padding) of a string (UTF-8) or raw bytes. */
export function base64Url(data: string | Uint8Array): string {
  return toB64Url(typeof data === "string" ? enc.encode(data) : data);
}

/** `\\n` -> newline, trimmed. */
export function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, "\n").trim();
}

const PKCS8_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PKCS8_END = "-----END PRIVATE KEY-----";

/** The base64 body of a PKCS8 PEM with whitespace removed, or null when malformed. */
export function pkcs8Body(pem: string): string | null {
  const start = pem.indexOf(PKCS8_BEGIN);
  const end = pem.indexOf(PKCS8_END);
  if (start < 0 || end < start) return null;
  const body = pem.slice(start + PKCS8_BEGIN.length, end).replace(/\s+/g, "");
  if (body.length === 0 || body.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  return body;
}

export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pkcs8Body(pem);
  if (body === null) throw new Error("pem");
  const bin = atob(body);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import a PKCS8 PEM as a non-extractable RSASSA-PKCS1-v1_5 / SHA-256 signing key. */
export function importSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Build and sign a compact JWS (`header.claims.signature`). */
export async function signJwt(
  key: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
  return `${input}.${base64Url(new Uint8Array(sig))}`;
}
