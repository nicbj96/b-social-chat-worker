import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same stub the other suites use: index.ts imports "cloudflare:workers".
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { __test } from "./index";

const { isChatInputTruncated, tagTruncatedResponse, MAX_MESSAGE_CHARS, MAX_MESSAGES } = __test;

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function environment() {
  return {
    AI: { run: vi.fn(async () => ({ response: "Hej! Hvad kan jeg hjælpe med?" })) },
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "test-service-key",
  } as any;
}

// The worker fans out to Supabase and the command centre; unmocked those are
// real network calls that hang a test run.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function chat(body: unknown, ip = "203.0.113.240") {
  const env = environment();
  const response = await worker.fetch!(
    new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    executionContext(),
  );
  return response;
}

/**
 * The caps themselves (4000 chars/message, last 30 turns) already existed and
 * are enforced inside normalizePublicChatMessages. What did NOT exist was any
 * signal to the caller: a pasted 10k text was silently answered as if it were
 * 4k. A public endpoint must not edit a user's input and pretend it did not.
 *
 * Direction matters in both tests below: flagging truncation that did not
 * happen would put a false "your message was shortened" in front of users who
 * sent a short message — so the boundaries (exactly at the cap) stay unflagged.
 */
describe("isChatInputTruncated", () => {
  it("flags a single message over the per-message cap", () => {
    expect(isChatInputTruncated({ message: "a".repeat(MAX_MESSAGE_CHARS + 1) })).toBe(true);
  });

  it("flags an over-cap message inside a messages[] array", () => {
    expect(
      isChatInputTruncated({
        messages: [
          { role: "user", content: "hi" },
          { role: "user", content: "a".repeat(MAX_MESSAGE_CHARS + 1) },
        ],
      }),
    ).toBe(true);
  });

  it("flags a history longer than the retained turn cap", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short",
    }));
    expect(isChatInputTruncated({ messages })).toBe(true);
  });

  it("does NOT flag input exactly at the caps", () => {
    expect(isChatInputTruncated({ message: "a".repeat(MAX_MESSAGE_CHARS) })).toBe(false);
    const messages = Array.from({ length: MAX_MESSAGES }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "a".repeat(MAX_MESSAGE_CHARS),
    }));
    expect(isChatInputTruncated({ messages })).toBe(false);
  });

  it("does not flag ordinary short input", () => {
    expect(isChatInputTruncated({ message: "Hvad sker der i Aalborg i weekenden?" })).toBe(false);
    expect(isChatInputTruncated({ messages: [{ role: "user", content: "hej" }] })).toBe(false);
  });

  it("never throws on malformed bodies", () => {
    expect(isChatInputTruncated(null)).toBe(false);
    expect(isChatInputTruncated(undefined)).toBe(false);
    expect(isChatInputTruncated("just a string")).toBe(false);
    expect(isChatInputTruncated([1, 2, 3])).toBe(false);
    expect(isChatInputTruncated({ messages: [{ content: 12345 }] })).toBe(false);
    expect(isChatInputTruncated({ messages: "not-an-array" })).toBe(false);
    expect(isChatInputTruncated({})).toBe(false);
  });
});

describe("tagTruncatedResponse", () => {
  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Prompt-Version": "test" },
    });

  it("adds truncated:true to a JSON reply and keeps the existing fields", async () => {
    const out = await tagTruncatedResponse(jsonRes({ reply: "hej", tool_calls_made: [] }), true);
    const body = await out.json();
    expect(body).toMatchObject({ reply: "hej", tool_calls_made: [], truncated: true });
    expect(out.status).toBe(200);
  });

  it("keeps CORS and other headers across the re-wrap", async () => {
    const out = await tagTruncatedResponse(jsonRes({ reply: "hej" }), true);
    expect(out.headers.get("access-control-allow-origin")).toBe("*");
    expect(out.headers.get("x-prompt-version")).toBe("test");
  });

  it("returns the response untouched when there is nothing to flag", async () => {
    const original = jsonRes({ reply: "hej" });
    const out = await tagTruncatedResponse(original, false);
    expect(out).toBe(original);
  });

  it("passes non-JSON responses straight through", async () => {
    const original = new Response("plain text", { status: 200, headers: { "Content-Type": "text/plain" } });
    const out = await tagTruncatedResponse(original, true);
    expect(out).toBe(original);
  });

  it("never fails the request over the flag", async () => {
    const broken = new Response("{not json", { status: 502, headers: { "Content-Type": "application/json" } });
    const out = await tagTruncatedResponse(broken, true);
    expect(out.status).toBe(502);
    expect(await out.text()).toBe("{not json");
  });

  it("does not flag an error reply object (arrays/scalars pass through)", async () => {
    const arr = jsonRes([1, 2, 3]);
    expect(await tagTruncatedResponse(arr, true)).toBe(arr);
  });
});

/**
 * End-to-end through the worker handler: the flag has to survive the real
 * routing + response path, not just the pure helpers, or a client would still
 * see a silently shortened answer.
 */
describe("POST /chat — truncation reaches the caller", () => {
  it("flags a reply to an over-cap paste", async () => {
    const response = await chat({ message: "a".repeat(MAX_MESSAGE_CHARS + 500) }, "203.0.113.241");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { truncated?: boolean; reply?: string; error?: string };
    expect(body.truncated).toBe(true);
    expect(typeof body.reply === "string" || typeof body.error === "string").toBe(true);
  });

  it("does NOT put a truncated flag on an ordinary short message", async () => {
    const response = await chat({ message: "Hej, hvad sker der i weekenden?" }, "203.0.113.242");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { truncated?: boolean };
    expect(body.truncated).toBeUndefined();
  });

  it("twice the cap still answers (never a hard error) and is flagged", async () => {
    const response = await chat({ message: "b".repeat(MAX_MESSAGE_CHARS * 2) }, "203.0.113.243");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { truncated?: boolean }).truncated).toBe(true);
  });

  it("leaves 400s untouched (the flag is for answers, not rejects)", async () => {
    const response = await chat("{not json", "203.0.113.244");
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({ error: "Ugyldig JSON" });
  });
});
