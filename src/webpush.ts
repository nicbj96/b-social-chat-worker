// Minimal RFC 8291 Web Push encryption + VAPID ES256 JWT signer for Cloudflare Workers.
// No external deps — all Web Crypto API.

function b64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm.buffer.slice(ikm.byteOffset, ikm.byteOffset + ikm.byteLength) as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", salt, info, hash: "SHA-256" }, key, length * 8);
  return new Uint8Array(bits);
}

// ── VAPID JWT (ES256) ─────────────────────────────────────────────────
async function signVapidJwt(audience: string, subject: string, privateKeyB64: string, publicKeyB64: string): Promise<string> {
  // Public key is 65 bytes: 0x04 || x (32) || y (32)
  const pub = b64UrlToBytes(publicKeyB64);
  const x = bytesToB64Url(pub.slice(1, 33));
  const y = bytesToB64Url(pub.slice(33, 65));

  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x, y, d: privateKeyB64, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };

  const enc = new TextEncoder();
  const h64 = bytesToB64Url(enc.encode(JSON.stringify(header)));
  const p64 = bytesToB64Url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${h64}.${p64}`;

  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${bytesToB64Url(new Uint8Array(sig))}`;
}

// ── aes128gcm payload encryption (RFC 8291) ───────────────────────────
async function encryptPayload(payload: Uint8Array, clientP256dh: string, clientAuth: string): Promise<Uint8Array> {
  const clientPubBytes = b64UrlToBytes(clientP256dh);
  const authSecret = b64UrlToBytes(clientAuth);

  // Generate ephemeral server keypair
  const serverKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKey.publicKey)); // 65B
  const clientPub = await crypto.subtle.importKey("raw", clientPubBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);

  // ECDH shared secret
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientPub }, serverKey.privateKey, 256)
  );

  // Key material: HKDF(auth_secret, shared, "WebPush: info\0" || client_pub || server_pub) → 32 bytes
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), clientPubBytes, serverPubRaw);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // Random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK (16B) and nonce (12B) derived from IKM using salt
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  // Payload + 0x02 delimiter (single record)
  const plaintext = concat(payload, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  // Envelope: salt(16) || rs(4,BE) || idlen(1) || keyid(65) || ciphertext
  const recordSize = 4096;
  const envelope = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.length);
  envelope.set(salt, 0);
  new DataView(envelope.buffer).setUint32(16, recordSize, false);
  envelope[20] = 65;
  envelope.set(serverPubRaw, 21);
  envelope.set(ciphertext, 21 + 65);
  return envelope;
}

// ── Send push ─────────────────────────────────────────────────────────
export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}
export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;
}

export async function sendWebPush(sub: PushSubscription, message: PushMessage, vapid: VapidKeys): Promise<{ ok: boolean; status: number; statusText: string }> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await signVapidJwt(audience, vapid.subject, vapid.privateKey, vapid.publicKey);

  const payload = new TextEncoder().encode(JSON.stringify(message));
  const encrypted = await encryptPayload(payload, sub.p256dh, sub.auth);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "normal",
    },
    body: encrypted,
  });
  return { ok: res.ok, status: res.status, statusText: res.statusText };
}
