/** Test-only RSA key generation: a PKCS8 PEM plus the matching public key. */

export interface TestKey {
  pem: string;
  publicKey: CryptoKey;
}

function pemOf(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

let cached: Promise<TestKey> | undefined;

export function testKey(): Promise<TestKey> {
  cached ??= (async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    return { pem: pemOf(der), publicKey: pair.publicKey };
  })();
  return cached;
}
