// Plan W2 Task 9 — the deploy workflow must be hardened and must never
// deploy from a pull_request.
import { describe, expect, it } from "vitest";
import wf from "../.github/workflows/deploy.yml?raw";

describe("deploy.yml hardening", () => {
  it("pins every action to a full commit SHA", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
  it("uses node 22, npm cache, npm ci only", () => {
    expect(wf).toContain("node-version: '22'");
    expect(wf).toContain("cache: npm");
    expect(wf).not.toContain("npm install");
    expect(wf).not.toContain("|| npm");
  });
  it("is blocking: no continue-on-error, runs check, test and audit before deploy", () => {
    expect(wf).not.toContain("continue-on-error");
    const check = wf.indexOf("npm run check"), test = wf.indexOf("npm test"),
      audit = wf.indexOf("npm run audit:prod"), deploy = wf.indexOf("wrangler-action");
    for (const i of [check, test, audit]) { expect(i).toBeGreaterThan(-1); expect(i).toBeLessThan(deploy); }
  });
  it("runs on pull_request to main but deploys only on main push", () => {
    expect(wf).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(wf).toContain("if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'");
    expect(wf).toContain("- 'src/**'");
  });
  it("smoke test fails the job on a bad health response", () => {
    expect(wf).toContain(`grep -q '"status":"ok"'`);
    expect(wf).not.toContain("|| echo");
  });
});
