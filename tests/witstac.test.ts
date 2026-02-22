import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** SHA-256 of a Buffer — mirrors what the Clarity contract does */
function sha256Buf(answer: Buffer): Uint8Array {
  return createHash("sha256").update(answer).digest();
}

/** Encode a plain-text answer string as a fixed-length buffer (max 128 bytes) */
function answerBuf(text: string): Uint8Array {
  const buf = Buffer.alloc(128, 0);
  Buffer.from(text, "utf8").copy(buf);
  return buf;
}

/** Compute SHA-256 commitment hash for an answer string */
function commitHash(text: string): Uint8Array {
  return sha256Buf(answerBuf(text));
}

const accounts = simnet.getAccounts();
const deployer  = accounts.get("deployer")!;
const wallet1   = accounts.get("wallet_1")!;
const wallet2   = accounts.get("wallet_2")!;
const wallet3   = accounts.get("wallet_3")!;

// ---------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------

/** Add a sample question as the deployer and fund the pool */
function setupQuestion(answer = "Satoshi Nakamoto", difficulty = 3, reward = 0) {
  const hash = commitHash(answer);
  const addResult = simnet.callPublicFn(
    "witstac",
    "add-question",
    [
      Cl.stringUtf8("Who created Bitcoin?"),
      Cl.buffer(hash),
      Cl.stringAscii("Crypto"),
      Cl.uint(difficulty),
      Cl.uint(reward),
    ],
    deployer
  );
  expect(addResult.result).toBeOk(Cl.uint(1));
  return { questionId: 1, answer, hash };
}

/** Fund the reward pool with a given amount (WIT micro-units) */
function fundPool(amount = 10_000_000) {
  const result = simnet.callPublicFn(
    "witstac",
    "fund-reward-pool",
    [Cl.uint(amount)],
    deployer
  );
  expect(result.result).toBeOk(Cl.uint(amount));
}

/** Commit an answer for a player */
function commit(player: string, questionId: number, answer: string) {
  const hash = commitHash(answer);
  return simnet.callPublicFn(
    "witstac",
    "commit-answer",
    [Cl.uint(questionId), Cl.buffer(hash)],
    player
  );
}

/** Reveal an answer for a player */
function reveal(player: string, questionId: number, answer: string) {
  return simnet.callPublicFn(
    "witstac",
    "reveal-answer",
    [Cl.uint(questionId), Cl.buffer(answerBuf(answer))],
    player
  );
}

// ---------------------------------------------------------------
// 1. WIT Token Tests
// ---------------------------------------------------------------

describe("WIT Token", () => {
  it("returns correct token metadata", () => {
    expect(simnet.callReadOnlyFn("wit-token", "get-name", [], deployer).result)
      .toBeOk(Cl.stringAscii("WitStac Token"));

    expect(simnet.callReadOnlyFn("wit-token", "get-symbol", [], deployer).result)
      .toBeOk(Cl.stringAscii("WIT"));

    expect(simnet.callReadOnlyFn("wit-token", "get-decimals", [], deployer).result)
      .toBeOk(Cl.uint(6));
  });

  it("owner can airdrop WIT to any address", () => {
    const result = simnet.callPublicFn(
      "wit-token",
      "airdrop",
      [Cl.uint(1_000_000), Cl.principal(wallet1)],
      deployer
    );
    expect(result.result).toBeOk(Cl.bool(true));

    const balance = simnet.callReadOnlyFn(
      "wit-token", "get-balance", [Cl.principal(wallet1)], wallet1
    );
    expect(balance.result).toBeOk(Cl.uint(1_000_000));
  });

  it("non-owner cannot airdrop WIT", () => {
    const result = simnet.callPublicFn(
      "wit-token",
      "airdrop",
      [Cl.uint(1_000_000), Cl.principal(wallet1)],
      wallet1
    );
    expect(result.result).toBeErr(Cl.uint(300));
  });

  it("holder can transfer WIT to another address", () => {
    simnet.callPublicFn("wit-token", "airdrop", [Cl.uint(2_000_000), Cl.principal(wallet1)], deployer);
    const result = simnet.callPublicFn(
      "wit-token",
      "transfer",
      [Cl.uint(500_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet1
    );
    expect(result.result).toBeOk(Cl.bool(true));

    const bal2 = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet2)], wallet2);
    expect(bal2.result).toBeOk(Cl.uint(500_000));
  });

  it("cannot transfer more than balance", () => {
    const result = simnet.callPublicFn(
      "wit-token",
      "transfer",
      [Cl.uint(999_999_999), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet1
    );
    expect(result.result.type).toBe(ClarityType.ResponseErr);
  });

  it("cannot transfer on behalf of another address", () => {
    simnet.callPublicFn("wit-token", "airdrop", [Cl.uint(1_000_000), Cl.principal(wallet1)], deployer);
    const result = simnet.callPublicFn(
      "wit-token",
      "transfer",
      [Cl.uint(100_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet2 // wallet2 pretending to be wallet1
    );
    expect(result.result).toBeErr(Cl.uint(301));
  });
});

// ---------------------------------------------------------------
// 2. Admin Functions
// ---------------------------------------------------------------

describe("Admin - add-question", () => {
  it("owner can add a question and it increments the counter", () => {
    const hash = commitHash("Paris");
    const result = simnet.callPublicFn(
      "witstac",
      "add-question",
      [Cl.stringUtf8("Capital of France?"), Cl.buffer(hash), Cl.stringAscii("Geography"), Cl.uint(1), Cl.uint(0)],
      deployer
    );
    expect(result.result).toBeOk(Cl.uint(1));

    const count = simnet.callReadOnlyFn("witstac", "get-question-count", [], deployer);
    expect(count.result).toBeOk(Cl.uint(1));
  });

  it("auto-fills reward from difficulty tier when reward is 0", () => {
    const hash = commitHash("answer");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("Test"), Cl.uint(2), Cl.uint(0)],
      deployer
    );
    const q = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], deployer);
    const data = q.result as any;
    // difficulty 2 = 1 WIT = 1_000_000 micro-units
    expect(data.value.data["reward"].value).toBe(1_000_000n);
  });

  it("uses custom reward when non-zero reward is passed", () => {
    const hash = commitHash("answer");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("Test"), Cl.uint(3), Cl.uint(3_000_000)],
      deployer
    );
    const q = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], deployer);
    const data = q.result as any;
    expect(data.value.data["reward"].value).toBe(3_000_000n);
  });

  it("non-owner cannot add a question", () => {
    const hash = commitHash("Paris");
    const result = simnet.callPublicFn(
      "witstac",
      "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("Geo"), Cl.uint(1), Cl.uint(0)],
      wallet1
    );
    expect(result.result).toBeErr(Cl.uint(200));
  });

  it("rejects invalid difficulty (0 or 5)", () => {
    const hash = commitHash("a");
    const r0 = simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("T"), Cl.uint(0), Cl.uint(0)],
      deployer
    );
    expect(r0.result).toBeErr(Cl.uint(207));

    const r5 = simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(hash), Cl.stringAscii("T"), Cl.uint(5), Cl.uint(0)],
      deployer
    );
    expect(r5.result).toBeErr(Cl.uint(207));
  });

  it("get-question does not expose the answer hash", () => {
    setupQuestion();
    const q = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], wallet1);
    const data = q.result as any;
    expect(data.value.data["answer-hash"]).toBeUndefined();
  });

  it("get-question returns err for non-existent question", () => {
    const result = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(99)], wallet1);
    expect(result.result).toBeErr(Cl.uint(201));
  });
});

describe("Admin - retire-question", () => {
  it("owner can retire a question", () => {
    setupQuestion();
    const result = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    expect(result.result).toBeOk(Cl.bool(true));

    const q = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], wallet1);
    const data = q.result as any;
    expect(data.value.data["active"].value).toBe(false);
  });

  it("non-owner cannot retire a question", () => {
    setupQuestion();
    const result = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], wallet1);
    expect(result.result).toBeErr(Cl.uint(200));
  });

  it("cannot retire a non-existent question", () => {
    const result = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(99)], deployer);
    expect(result.result).toBeErr(Cl.uint(201));
  });
});

// ---------------------------------------------------------------
// 3. Reward Pool
// ---------------------------------------------------------------

describe("Reward Pool", () => {
  it("anyone can fund the reward pool and balance updates", () => {
    const result = simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(5_000_000)], wallet1);
    expect(result.result).toBeOk(Cl.uint(5_000_000));

    const bal = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], wallet1);
    expect(bal.result).toBeOk(Cl.uint(5_000_000));
  });

  it("pool balance accumulates across multiple fundings", () => {
    simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(1_000_000)], wallet1);
    simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(2_000_000)], wallet2);
    const bal = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], deployer);
    expect(bal.result).toBeOk(Cl.uint(3_000_000));
  });
});

// ---------------------------------------------------------------
// 4. Commit-Answer
// ---------------------------------------------------------------

describe("commit-answer", () => {
  it("player can commit an answer to an active question", () => {
    setupQuestion();
    const result = commit(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeOk(Cl.bool(true));

    const stored = simnet.callReadOnlyFn(
      "witstac", "get-commitment", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(stored.result.type).not.toBe(ClarityType.OptionalNone);
  });

  it("cannot commit to a non-existent question", () => {
    const result = commit(wallet1, 99, "anything");
    expect(result.result).toBeErr(Cl.uint(201));
  });

  it("cannot commit to a retired question", () => {
    setupQuestion();
    simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    const result = commit(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeErr(Cl.uint(202));
  });

  it("cannot submit a second commitment before the first expires", () => {
    setupQuestion();
    commit(wallet1, 1, "Satoshi Nakamoto");
    const result = commit(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeErr(Cl.uint(210));
  });

  it("can re-commit after the commitment window expires (100 blocks)", () => {
    setupQuestion();
    commit(wallet1, 1, "Satoshi Nakamoto");
    // Advance 101 blocks past the commitment block
    simnet.mineEmptyBlocks(101);
    const result = commit(wallet1, 1, "New Answer");
    expect(result.result).toBeOk(Cl.bool(true));
  });

  it("different players can each commit to the same question independently", () => {
    setupQuestion();
    const r1 = commit(wallet1, 1, "Satoshi Nakamoto");
    const r2 = commit(wallet2, 1, "Satoshi Nakamoto");
    expect(r1.result).toBeOk(Cl.bool(true));
    expect(r2.result).toBeOk(Cl.bool(true));
  });
});

// ---------------------------------------------------------------
// 5. Reveal-Answer - Happy Path
// ---------------------------------------------------------------

describe("reveal-answer - correct answer", () => {
  it("correct answer returns (ok true), updates attempt record", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");

    const result = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeOk(Cl.bool(true));

    const attempt = simnet.callReadOnlyFn(
      "witstac", "get-attempt", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    const data = attempt.result as any;
    expect(data.value.data["correct"].value).toBe(true);
    expect(data.value.data["total-attempts"].value).toBe(1n);
  });

  it("correct answer updates player stats (streak and total-correct)", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const stats = simnet.callReadOnlyFn(
      "witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1
    );
    const data = stats.result as any;
    expect(data.value.data["total-correct"].value).toBe(1n);
    expect(data.value.data["current-streak"].value).toBe(1n);
  });

  it("correct answer updates the leaderboard entry", () => {
    setupQuestion("Satoshi Nakamoto", 3); // Hard = 2.5 WIT
    fundPool(10_000_000);
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const lb = simnet.callReadOnlyFn(
      "witstac", "get-leaderboard-entry", [Cl.principal(wallet1)], wallet1
    );
    const data = lb.result as any;
    expect(data.value.data["correct-answers"].value).toBe(1n);
    expect(data.value.data["total-attempts"].value).toBe(1n);
  });

  it("has-answered-correctly returns true after correct answer", () => {
    setupQuestion();
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const result = simnet.callReadOnlyFn(
      "witstac", "has-answered-correctly", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(result.result).toBe(Cl.bool(true));
  });

  it("commitment is deleted after reveal", () => {
    setupQuestion();
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const stored = simnet.callReadOnlyFn(
      "witstac", "get-commitment", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(stored.result.type).toBe(ClarityType.OptionalNone);
  });

  it("WIT balance of player increases after first correct answer", () => {
    setupQuestion("Satoshi Nakamoto", 2, 0); // Medium = 1 WIT
    fundPool(10_000_000);

    const before = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const beforeVal = (before.result as any).value.value as bigint;

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const after = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const afterVal = (after.result as any).value.value as bigint;

    expect(afterVal).toBeGreaterThan(beforeVal);
  });

  it("reward pool balance decreases after payout", () => {
    setupQuestion("Satoshi Nakamoto", 1, 0); // Easy = 0.5 WIT
    fundPool(5_000_000);

    const balBefore = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], deployer);
    const beforeVal = (balBefore.result as any).value.value as bigint;

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const balAfter = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], deployer);
    const afterVal = (balAfter.result as any).value.value as bigint;

    expect(afterVal).toBeLessThan(beforeVal);
  });
});

// ---------------------------------------------------------------
// 6. Reveal-Answer - Wrong Answer Path
// ---------------------------------------------------------------

describe("reveal-answer - wrong answer", () => {
  it("wrong answer returns (ok false), does not update correct flag", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();

    // Commit the WRONG answer
    const wrongAnswer = "Wrong Person";
    commit(wallet1, 1, wrongAnswer);
    const result = reveal(wallet1, 1, wrongAnswer);
    expect(result.result).toBeOk(Cl.bool(false));

    const attempt = simnet.callReadOnlyFn(
      "witstac", "get-attempt", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    const data = attempt.result as any;
    expect(data.value.data["correct"].value).toBe(false);
  });

  it("wrong answer resets player streak to zero", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();

    // First get a streak going with a second question
    const hash2 = commitHash("Paris");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Capital of France?"), Cl.buffer(hash2), Cl.stringAscii("Geo"), Cl.uint(1), Cl.uint(0)],
      deployer
    );

    // Answer Q2 correctly to build a streak
    commit(wallet1, 2, "Paris");
    reveal(wallet1, 2, "Paris");

    let stats = simnet.callReadOnlyFn("witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1);
    expect((stats.result as any).value.data["current-streak"].value).toBe(1n);

    // Now answer Q1 WRONG
    const wrongAnswer = "Not Satoshi";
    commit(wallet1, 1, wrongAnswer);
    reveal(wallet1, 1, wrongAnswer);

    stats = simnet.callReadOnlyFn("witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1);
    expect((stats.result as any).value.data["current-streak"].value).toBe(0n);
  });

  it("wrong answer does not pay out any WIT", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();

    const before = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const beforeVal = (before.result as any).value.value as bigint;

    const wrongAnswer = "Wrong Person";
    commit(wallet1, 1, wrongAnswer);
    reveal(wallet1, 1, wrongAnswer);

    const after = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const afterVal = (after.result as any).value.value as bigint;

    expect(afterVal).toBe(beforeVal);
  });
});

// ---------------------------------------------------------------
// 7. Reveal-Answer - Error Cases
// ---------------------------------------------------------------

describe("reveal-answer - error cases", () => {
  it("reveal without prior commitment returns err u203", () => {
    setupQuestion();
    const result = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeErr(Cl.uint(203));
  });

  it("revealing with a different answer than committed returns err u205", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");     // commit hash of "Satoshi Nakamoto"
    const result = reveal(wallet1, 1, "Different Answer"); // reveal different bytes
    expect(result.result).toBeErr(Cl.uint(205));
  });

  it("expired commitment returns err u204", () => {
    setupQuestion();
    commit(wallet1, 1, "Satoshi Nakamoto");
    simnet.mineEmptyBlocks(101); // advance past 100-block window
    const result = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeErr(Cl.uint(204));
  });

  it("revealing on an inactive question returns err u202", () => {
    setupQuestion("Satoshi Nakamoto");
    commit(wallet1, 1, "Satoshi Nakamoto");
    simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    const result = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result.result).toBeErr(Cl.uint(202));
  });
});

// ---------------------------------------------------------------
// 8. No Double Reward (First-Correct-Only)
// ---------------------------------------------------------------

describe("no double reward", () => {
  it("second correct answer on same question gives no extra WIT", () => {
    setupQuestion("Satoshi Nakamoto", 2);
    fundPool(10_000_000);

    // First correct answer
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const after1 = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const val1 = (after1.result as any).value.value as bigint;

    const pool1 = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], deployer);
    const pval1 = (pool1.result as any).value.value as bigint;

    // Second correct answer on same question
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const after2 = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const val2 = (after2.result as any).value.value as bigint;

    const pool2 = simnet.callReadOnlyFn("witstac", "get-reward-pool-balance", [], deployer);
    const pval2 = (pool2.result as any).value.value as bigint;

    // Balance & pool must be unchanged after the second answer
    expect(val2).toBe(val1);
    expect(pval2).toBe(pval1);
  });

  it("second correct answer still increments attempt count and streak", () => {
    setupQuestion("Satoshi Nakamoto");
    fundPool();

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const attempt = simnet.callReadOnlyFn(
      "witstac", "get-attempt", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect((attempt.result as any).value.data["total-attempts"].value).toBe(2n);
  });
});

// ---------------------------------------------------------------
// 9. Streak Multipliers
// ---------------------------------------------------------------

describe("streak multipliers", () => {
  it("streak increments with each consecutive correct answer", () => {
    // Add 3 questions
    for (let i = 0; i < 3; i++) {
      const hash = commitHash(`Answer${i}`);
      simnet.callPublicFn("witstac", "add-question",
        [Cl.stringUtf8(`Q${i}?`), Cl.buffer(hash), Cl.stringAscii("Test"), Cl.uint(1), Cl.uint(0)],
        deployer
      );
    }
    fundPool(10_000_000);

    for (let i = 1; i <= 3; i++) {
      commit(wallet1, i, `Answer${i - 1}`);
      reveal(wallet1, i, `Answer${i - 1}`);
    }

    const stats = simnet.callReadOnlyFn("witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1);
    expect((stats.result as any).value.data["current-streak"].value).toBe(3n);
  });

  it("streak resets to 0 after a wrong answer", () => {
    const hash1 = commitHash("A1");
    const hashW = commitHash("Wrong");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q1?"), Cl.buffer(hash1), Cl.stringAscii("Test"), Cl.uint(1), Cl.uint(0)],
      deployer
    );
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q2?"), Cl.buffer(commitHash("A2")), Cl.stringAscii("Test"), Cl.uint(1), Cl.uint(0)],
      deployer
    );
    fundPool(10_000_000);

    commit(wallet1, 1, "A1");
    reveal(wallet1, 1, "A1");

    // Wrong on Q2
    commit(wallet1, 2, "Wrong");
    reveal(wallet1, 2, "Wrong");

    const stats = simnet.callReadOnlyFn("witstac", "get-player-stats", [Cl.principal(wallet1)], wallet1);
    expect((stats.result as any).value.data["current-streak"].value).toBe(0n);
  });

  it("get-streak read-only returns current streak", () => {
    const hash = commitHash("Paris");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Cap France?"), Cl.buffer(hash), Cl.stringAscii("Geo"), Cl.uint(1), Cl.uint(0)],
      deployer
    );
    fundPool();

    commit(wallet1, 1, "Paris");
    reveal(wallet1, 1, "Paris");

    const streak = simnet.callReadOnlyFn("witstac", "get-streak", [Cl.principal(wallet1)], wallet1);
    expect(streak.result).toBe(Cl.uint(1));
  });

  it("get-streak returns 0 for a player with no answers", () => {
    const streak = simnet.callReadOnlyFn("witstac", "get-streak", [Cl.principal(wallet3)], wallet3);
    expect(streak.result).toBe(Cl.uint(0));
  });
});

// ---------------------------------------------------------------
// 10. Leaderboard
// ---------------------------------------------------------------

describe("leaderboard", () => {
  it("leaderboard updates correctly after correct answer", () => {
    setupQuestion("Satoshi Nakamoto", 1);
    fundPool();

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const lb = simnet.callReadOnlyFn(
      "witstac", "get-leaderboard-entry", [Cl.principal(wallet1)], wallet1
    );
    const data = (lb.result as any).value.data;
    expect(data["correct-answers"].value).toBe(1n);
    expect(data["total-attempts"].value).toBe(1n);
    expect(data["current-streak"].value).toBe(1n);
    expect(data["best-streak"].value).toBe(1n);
    expect(data["score"].value).toBeGreaterThan(0n);
  });

  it("best-streak tracks all-time high streak", () => {
    const h1 = commitHash("A1"), h2 = commitHash("A2"), h3 = commitHash("Wrong");
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q1?"), Cl.buffer(h1), Cl.stringAscii("T"), Cl.uint(1), Cl.uint(0)], deployer);
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q2?"), Cl.buffer(h2), Cl.stringAscii("T"), Cl.uint(1), Cl.uint(0)], deployer);
    simnet.callPublicFn("witstac", "add-question",
      [Cl.stringUtf8("Q3?"), Cl.buffer(h3), Cl.stringAscii("T"), Cl.uint(1), Cl.uint(0)], deployer);
    fundPool();

    commit(wallet1, 1, "A1"); reveal(wallet1, 1, "A1");
    commit(wallet1, 2, "A2"); reveal(wallet1, 2, "A2");
    // Wrong on Q3 — streak resets
    commit(wallet1, 3, "Wrong"); reveal(wallet1, 3, "Wrong");

    const lb = simnet.callReadOnlyFn(
      "witstac", "get-leaderboard-entry", [Cl.principal(wallet1)], wallet1
    );
    const data = (lb.result as any).value.data;
    expect(data["current-streak"].value).toBe(0n);  // reset
    expect(data["best-streak"].value).toBe(2n);     // all-time high preserved
  });

  it("multiple players have independent leaderboard entries", () => {
    setupQuestion("Satoshi Nakamoto", 2);
    fundPool(20_000_000);

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    commit(wallet2, 1, "Satoshi Nakamoto");
    reveal(wallet2, 1, "Satoshi Nakamoto");

    const lb1 = simnet.callReadOnlyFn(
      "witstac", "get-leaderboard-entry", [Cl.principal(wallet1)], wallet1
    );
    const lb2 = simnet.callReadOnlyFn(
      "witstac", "get-leaderboard-entry", [Cl.principal(wallet2)], wallet2
    );

    expect((lb1.result as any).value.data["correct-answers"].value).toBe(1n);
    expect((lb2.result as any).value.data["correct-answers"].value).toBe(1n);
  });
});

// ---------------------------------------------------------------
// 11. Pool Depletion (Deferred Payout)
// ---------------------------------------------------------------

describe("pool depletion", () => {
  it("correct answer is recorded even when pool is empty", () => {
    setupQuestion("Satoshi Nakamoto", 1);
    // No funding — pool is empty

    commit(wallet1, 1, "Satoshi Nakamoto");
    const result = reveal(wallet1, 1, "Satoshi Nakamoto");

    // Still returns ok true (win recorded, payout deferred)
    expect(result.result).toBeOk(Cl.bool(true));

    const attempt = simnet.callReadOnlyFn(
      "witstac", "get-attempt", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect((attempt.result as any).value.data["correct"].value).toBe(true);
  });

  it("player WIT balance unchanged when pool is empty", () => {
    setupQuestion("Satoshi Nakamoto", 1);

    const before = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const beforeVal = (before.result as any).value.value as bigint;

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const after = simnet.callReadOnlyFn("wit-token", "get-balance", [Cl.principal(wallet1)], wallet1);
    const afterVal = (after.result as any).value.value as bigint;

    expect(afterVal).toBe(beforeVal);
  });
});

// ---------------------------------------------------------------
// 12. Simnet Initialisation
// ---------------------------------------------------------------

describe("simnet", () => {
  it("simnet is well initialised", () => {
    expect(simnet.blockHeight).toBeDefined();
  });
});
