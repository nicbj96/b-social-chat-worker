import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendWebPush, type PushSubscription, type VapidKeys } from "./webpush";

// webpush.ts (RFC 8291 encryption + VAPID ES256 signing) shipped with no test
// and no other test imported it (audit #22). It has no exported pure helpers, so
// this exercises the one public entry point sendWebPush end-to-end with REAL Web
// Crypto and a mocked fetch, asserting the wire contract a push service checks:
// the VAPID Authorization header + JWT structure, the aes128gcm content coding,
// and the RFC 8291 envelope layout. A regression in the crypto/subscription path
// would change one of these.

const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const fromB64url = (s: string) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

let vapid: VapidKeys;
let sub: PushSubscription;

beforeAll(async () => {
  // A real VAPID keypair: publicKey as the raw 65-byte point, privateKey as the
  // JWK `d` — exactly the two shapes signVapidJwt consumes.
  const vapidPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array((await crypto.subtle.exportKey("raw", vapidPair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)) as JsonWebKey;
  vapid = { publicKey: b64url(rawPub), privateKey: jwk.d as string, subject: "mailto:nicbj96@gmail.com" };

  // A real client subscription: p256dh is the client's raw ECDH point, auth is a
  // 16-byte secret — the two values encryptPayload needs to run without throwing.
  const clientPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const clientRaw = new Uint8Array((await crypto.subtle.exportKey("raw", clientPair.publicKey)) as ArrayBuffer);
  sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    p256dh: b64url(clientRaw),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
});

afterEach(() => { vi.restoreAllMocks(); });

describe("sendWebPush", () => {
  it("POSTs the VAPID + aes128gcm contract the push service expects", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, status: 201, statusText: "Created" } as Response;
    }));

    const out = await sendWebPush(sub, { title: "Hej", body: "Der er et nyt event" }, vapid);
    expect(out).toEqual({ ok: true, status: 201, statusText: "Created" });

    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["TTL"]).toBe("86400");

    // Authorization: "vapid t=<jwt>, k=<publicKey>"
    expect(h["Authorization"]).toMatch(/^vapid t=[^,]+, k=/);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h["Authorization"]);
    expect(m).not.toBeNull();
    const [, jwt, k] = m!;
    expect(k).toBe(vapid.publicKey);

    // JWT: three base64url segments; header {typ:JWT,alg:ES256}; payload aud/exp/sub.
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    expect(payload.aud).toBe("https://fcm.googleapis.com"); // scheme+host of the endpoint
    expect(payload.sub).toBe(vapid.subject);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000)); // not already expired
  });

  it("builds an RFC 8291 envelope: salt(16) | rs=4096 | idlen=65 | keyid(65) | ciphertext", async () => {
    let body: Uint8Array | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as Uint8Array;
      return { ok: true, status: 201, statusText: "Created" } as Response;
    }));

    await sendWebPush(sub, { title: "T", body: "B", url: "/event/1" }, vapid);
    expect(body).toBeInstanceOf(Uint8Array);
    const env = body!;
    // Header is 16 + 4 + 1 + 65 = 86 bytes, then a non-empty ciphertext.
    expect(env.length).toBeGreaterThan(86);
    const rs = new DataView(env.buffer, env.byteOffset, env.byteLength).getUint32(16, false);
    expect(rs).toBe(4096);            // record size
    expect(env[20]).toBe(65);         // key id length
    expect(env[21]).toBe(0x04);       // uncompressed EC point prefix of the server key
  });

  it("returns a failed result (not a throw) when the push service rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 410, statusText: "Gone" } as Response)));
    const out = await sendWebPush(sub, { title: "T", body: "B" }, vapid);
    expect(out).toEqual({ ok: false, status: 410, statusText: "Gone" });
  });
});
