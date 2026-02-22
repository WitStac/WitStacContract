import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { createHash } from "node:crypto";

function answerBuf(text: string): Uint8Array {
  const buf = Buffer.alloc(128, 0); Buffer.from(text, "utf8").copy(buf); return buf;
}
function commitHash(text: string): Uint8Array {
  return createHash("sha256").update(answerBuf(text)).digest();
}
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1  = accounts.get("wallet_1")!;

describe("diag", () => {
  it("logs types", () => {
    const hash = commitHash("Paris");
    simnet.callPublicFn("witstac", "add-question", [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("T"), Cl.uint(1), Cl.uint(0)], deployer);
    simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(5_000_000)], deployer);
    simnet.callPublicFn("witstac", "commit-answer", [Cl.uint(1), Cl.buffer(hash)], wallet1);
    simnet.callPublicFn("witstac", "reveal-answer", [Cl.uint(1), Cl.buffer(answerBuf("Paris"))], wallet1);

    const stats = simnet.callReadOnlyFn("witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1);
    console.log("STATS:", JSON.stringify(stats.result));
    const lb = simnet.callReadOnlyFn("witstac", "get-leaderboard-entry", [Cl.principal(wallet1)], wallet1);
    console.log("LB:", JSON.stringify(lb.result));
    const attempt = simnet.callReadOnlyFn("witstac", "get-attempt", [Cl.principal(wallet1), Cl.uint(1)], wallet1);
    console.log("ATTEMPT:", JSON.stringify(attempt.result));
    const hc = simnet.callReadOnlyFn("witstac", "has-answered-correctly", [Cl.principal(wallet1), Cl.uint(1)], wallet1);
    console.log("HC:", JSON.stringify(hc.result));
    const streak = simnet.callReadOnlyFn("witstac", "get-streak", [Cl.principal(wallet1)], wallet1);
    console.log("STREAK:", JSON.stringify(streak.result));
    expect(true).toBe(true);
  });
});
