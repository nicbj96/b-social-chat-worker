import { describe, expect, it } from "vitest";
import { validateUrl } from "./fetchguard";

describe("validateUrl — SSRF allow rules", () => {
  it("allows ordinary public http/https URLs", () => {
    expect(validateUrl("https://example.com")).not.toBeNull();
    expect(validateUrl("http://example.com/path?q=1")).not.toBeNull();
    expect(validateUrl("https://sub.domain.co.uk:443/contact")).not.toBeNull();
    expect(validateUrl("http://restaurangtyrol.se:80")).not.toBeNull();
  });

  it("blocks non-http(s) schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://host/x", "gopher://host", "data:text/html,x", "javascript:alert(1)"]) {
      expect(validateUrl(u)).toBeNull();
    }
  });

  it("blocks credentials smuggled into the authority", () => {
    expect(validateUrl("https://user:pass@example.com")).toBeNull();
    expect(validateUrl("https://admin@example.com")).toBeNull();
  });

  it("blocks non-standard ports", () => {
    expect(validateUrl("http://example.com:8080")).toBeNull();
    expect(validateUrl("https://example.com:22")).toBeNull();
    expect(validateUrl("http://example.com:6379")).toBeNull();
  });

  it("blocks loopback + localhost names", () => {
    for (const h of ["http://localhost", "http://localhost:80", "https://foo.localhost", "http://service.local", "http://db.internal"]) {
      expect(validateUrl(h)).toBeNull();
    }
  });

  it("blocks private + reserved IPv4 literals", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "10.255.255.255", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "100.64.0.1", "224.0.0.1"]) {
      expect(validateUrl(`http://${ip}/`)).toBeNull();
    }
  });

  it("allows public IPv4 literals that are not private (belt-and-suspenders)", () => {
    // 8.8.8.8 is public — not in any blocked range.
    expect(validateUrl("http://8.8.8.8/")).not.toBeNull();
    // 172.32 is just outside the private 172.16-31 block.
    expect(validateUrl("http://172.32.0.1/")).not.toBeNull();
  });

  it("blocks IPv6 loopback, link-local, ULA, and mapped literals", () => {
    for (const ip of ["[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12::34]", "[::ffff:127.0.0.1]", "[2001:db8::1]"]) {
      expect(validateUrl(`http://${ip}/`)).toBeNull();
    }
  });

  it("rejects malformed URLs", () => {
    expect(validateUrl("not a url")).toBeNull();
    expect(validateUrl("")).toBeNull();
  });
});
