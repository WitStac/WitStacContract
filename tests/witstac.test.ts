import { describe, expect, it } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** SHA-256 of a Uint8Array — mirrors sha256 in Clarity */
function sha256Buf(buf: Uint8Array): Uint8Array {
  return createHash("sha256").update(buf).digest();
}

/** Encode an answer string as a fixed 128-byte buffer (zero-padded) */
function answerBuf(text: string): Uint8Array {
  const buf = Buffer.alloc(128, 0);
  Buffer.from(text, "utf8").copy(buf);
  return buf;
}

/** Compute SHA-256 commitment hash for an answer string */
function commitHash(text: string): Uint8Array {
  return sha256Buf(answerBuf(text));
}

/** Unwrap a Clarity Some value → inner tuple data object */
function someData(result: any) {
  // result = { type: 'some', value: { type: 'tuple', value: { ...fields... } } }
  expect(result.type).toBe("some");
  expect(result.value.type).toBe("tuple");
  return result.value.value;
}

/** Read a uint value from a Clarity tuple field */
function tupleUint(result: any, field: string): bigint {
  const data = someData(result);
  // data[field] = { type: 'uint', value: '1' }
  return BigInt(data[field].value);
}

/** Read a bool value from a Clarity tuple field */
function tupleBool(result: any, field: string): boolean {
  const data = someData(result);
  // data[field] = { type: 'true' } or { type: 'false' }
  return data[field].type === "true";
}

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

function addQuestion(
  text: string,
  answer: string,
  category: string,
  difficulty: number,
  reward = 0
): number {
  const hash = commitHash(answer);
  const { result } = simnet.callPublicFn(
    "witstac",
    "add-question",
    [
      Cl.stringUtf8(text),
      Cl.buffer(hash),
      Cl.stringAscii(category),
      Cl.uint(difficulty),
      Cl.uint(reward),
    ],
    deployer
  );
  expect(result.type).toBe(ClarityType.ResponseOk);
  return Number((result as any).value.value);
}

function fundPool(amount = 10_000_000) {
  const { result } = simnet.callPublicFn(
    "witstac",
    "fund-reward-pool",
    [Cl.uint(amount)],
    deployer
  );
  expect(result.type).toBe(ClarityType.ResponseOk);
}

function commit(player: string, questionId: number, answer: string) {
  return simnet.callPublicFn(
    "witstac",
    "commit-answer",
    [Cl.uint(questionId), Cl.buffer(commitHash(answer))],
    player
  );
}

function reveal(player: string, questionId: number, answer: string) {
  return simnet.callPublicFn(
    "witstac",
    "reveal-answer",
    [Cl.uint(questionId), Cl.buffer(answerBuf(answer))],
    player
  );
}

function getWitBalance(address: string): bigint {
  const { result } = simnet.callReadOnlyFn(
    "wit-token", "get-balance", [Cl.principal(address)], address
  );
  // result = { type: 'uint', value: '1000' }
  return BigInt((result as any).value.value);
}

function getPoolBalance(): bigint {
  const { result } = simnet.callReadOnlyFn(
    "witstac", "get-reward-pool-balance", [], deployer
  );
  return BigInt((result as any).value.value);
}

function getPlayerStats(player: string) {
  const { result } = simnet.callReadOnlyFn(
    "witstac", "get-player-stats", [Cl.principal(player)], player
  );
  return result;
}

function getLeaderboard(player: string) {
  const { result } = simnet.callReadOnlyFn(
    "witstac", "get-leaderboard-entry", [Cl.principal(player)], player
  );
  return result;
}

function getAttempt(player: string, questionId: number) {
  const { result } = simnet.callReadOnlyFn(
    "witstac", "get-attempt",
    [Cl.principal(player), Cl.uint(questionId)],
    player
  );
  return result;
}

// ---------------------------------------------------------------
// 1. Simnet Sanity
// ---------------------------------------------------------------

describe("simnet", () => {
  it("is well initialised", () => {
    expect(simnet.blockHeight).toBeDefined();
  });
});

// ---------------------------------------------------------------
// 2. WIT Token Tests
// ---------------------------------------------------------------

describe("WIT Token - airdrop & transfer", () => {
  it("owner can airdrop WIT to any address", () => {
    const { result } = simnet.callPublicFn(
      "wit-token", "airdrop",
      [Cl.uint(1_000_000), Cl.principal(wallet1)],
      deployer
    );
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(getWitBalance(wallet1)).toBe(1_000_000n);
  });

  it("non-owner cannot airdrop WIT (err u300)", () => {
    const { result } = simnet.callPublicFn(
      "wit-token", "airdrop",
      [Cl.uint(1_000_000), Cl.principal(wallet1)],
      wallet1
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(300)));
  });

  it("holder can transfer WIT to another address", () => {
    simnet.callPublicFn("wit-token", "airdrop", [Cl.uint(2_000_000), Cl.principal(wallet1)], deployer);
    const { result } = simnet.callPublicFn(
      "wit-token", "transfer",
      [Cl.uint(500_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet1
    );
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(getWitBalance(wallet2)).toBe(500_000n);
  });

  it("cannot transfer more than balance", () => {
    const { result } = simnet.callPublicFn(
      "wit-token", "transfer",
      [Cl.uint(999_999_999), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet1
    );
    expect(result.type).toBe(ClarityType.ResponseErr);
  });

  it("cannot transfer on behalf of another address (err u301)", () => {
    simnet.callPublicFn("wit-token", "airdrop", [Cl.uint(1_000_000), Cl.principal(wallet1)], deployer);
    const { result } = simnet.callPublicFn(
      "wit-token", "transfer",
      [Cl.uint(100_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()],
      wallet2 // wallet2 pretending to spend wallet1's tokens
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(301)));
  });
});

// ---------------------------------------------------------------
// 3. Admin - add-question
// ---------------------------------------------------------------

describe("Admin - add-question", () => {
  it("owner can add a question; counter increments", () => {
    const id = addQuestion("Capital of France?", "Paris", "Geography", 1);
    expect(id).toBe(1);

    const { result } = simnet.callReadOnlyFn("witstac", "get-question-count", [], deployer);
    expect(result).toStrictEqual(Cl.ok(Cl.uint(1)));
  });

  it("auto-fills reward from difficulty tier when reward is 0", () => {
    addQuestion("Q?", "answer", "Test", 2, 0); // Medium → 1 WIT
    const { result } = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], deployer);
    const data = (result as any).value.value;
    expect(BigInt(data["reward"].value)).toBe(1_000_000n); // 1 WIT
  });

  it("uses custom reward when non-zero is passed", () => {
    addQuestion("Q?", "answer", "Test", 3, 3_000_000);
    const { result } = simnet.callReadOnlyFn("witstac", "get-question", [Cl.uint(1)], deployer);
    const data = (result as any).value.value;
    expect(BigInt(data["reward"].value)).toBe(3_000_000n);
  });

  it("non-owner cannot add a question (err u200)", () => {
    const { result } = simnet.callPublicFn(
      "witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(commitHash("a")), Cl.stringAscii("T"), Cl.uint(1), Cl.uint(0)],
      wallet1
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(200)));
  });

  it("rejects difficulty 0 (err u207)", () => {
    const { result } = simnet.callPublicFn(
      "witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(commitHash("a")), Cl.stringAscii("T"), Cl.uint(0), Cl.uint(0)],
      deployer
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(207)));
  });

  it("rejects difficulty 5 (err u207)", () => {
    const { result } = simnet.callPublicFn(
      "witstac", "add-question",
      [Cl.stringUtf8("Q?"), Cl.buffer(commitHash("a")), Cl.stringAscii("T"), Cl.uint(5), Cl.uint(0)],
      deployer
    );
    expect(result).toStrictEqual(Cl.error(Cl.uint(207)));
  });
});

// ---------------------------------------------------------------
// 4. Admin - retire-question
// ---------------------------------------------------------------

describe("Admin - retire-question", () => {
  it("owner can retire a question", () => {
    addQuestion("Q?", "A", "T", 1);
    const { result } = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
  });

  it("non-owner cannot retire a question (err u200)", () => {
    addQuestion("Q?", "A", "T", 1);
    const { result } = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], wallet1);
    expect(result).toStrictEqual(Cl.error(Cl.uint(200)));
  });

  it("cannot retire a non-existent question (err u201)", () => {
    const { result } = simnet.callPublicFn("witstac", "retire-question", [Cl.uint(99)], deployer);
    expect(result).toStrictEqual(Cl.error(Cl.uint(201)));
  });
});

// ---------------------------------------------------------------
// 5. Reward Pool
// ---------------------------------------------------------------

describe("Reward Pool", () => {
  it("anyone can fund the pool and balance updates correctly", () => {
    const { result } = simnet.callPublicFn(
      "witstac", "fund-reward-pool", [Cl.uint(5_000_000)], wallet1
    );
    expect(result).toStrictEqual(Cl.ok(Cl.uint(5_000_000)));
    expect(getPoolBalance()).toBe(5_000_000n);
  });

  it("pool balance accumulates across multiple fundings", () => {
    simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(1_000_000)], wallet1);
    simnet.callPublicFn("witstac", "fund-reward-pool", [Cl.uint(2_000_000)], wallet2);
    expect(getPoolBalance()).toBe(3_000_000n);
  });
});

// ---------------------------------------------------------------
// 6. Commit-Answer
// ---------------------------------------------------------------

describe("commit-answer", () => {
  it("player can commit an answer to an active question", () => {
    addQuestion("Who created Bitcoin?", "Satoshi Nakamoto", "Crypto", 3);
    const { result } = commit(wallet1, 1, "Satoshi Nakamoto");
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));

    const { result: stored } = simnet.callReadOnlyFn(
      "witstac", "get-commitment", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(stored.type).toBe(ClarityType.OptionalSome);
  });

  it("cannot commit to a non-existent question (err u201)", () => {
    const { result } = commit(wallet1, 99, "anything");
    expect(result).toStrictEqual(Cl.error(Cl.uint(201)));
  });

  it("cannot commit to a retired question (err u202)", () => {
    addQuestion("Q?", "A", "T", 1);
    simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    const { result } = commit(wallet1, 1, "A");
    expect(result).toStrictEqual(Cl.error(Cl.uint(202)));
  });

  it("cannot commit twice before window expires (err u210)", () => {
    addQuestion("Q?", "A", "T", 1);
    commit(wallet1, 1, "A");
    const { result } = commit(wallet1, 1, "A");
    expect(result).toStrictEqual(Cl.error(Cl.uint(210)));
  });

  it("can re-commit after commitment window expires (100 blocks)", () => {
    addQuestion("Q?", "A", "T", 1);
    commit(wallet1, 1, "A");
    simnet.mineEmptyBlocks(101);
    const { result } = commit(wallet1, 1, "New Answer");
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));
  });

  it("different players can commit independently to the same question", () => {
    addQuestion("Q?", "A", "T", 1);
    const r1 = commit(wallet1, 1, "A");
    const r2 = commit(wallet2, 1, "A");
    expect(r1.result).toStrictEqual(Cl.ok(Cl.bool(true)));
    expect(r2.result).toStrictEqual(Cl.ok(Cl.bool(true)));
  });
});

// ---------------------------------------------------------------
// 7. Reveal-Answer - Correct Answer
// ---------------------------------------------------------------

describe("reveal-answer - correct answer", () => {
  it("correct answer returns (ok true) and sets attempt.correct = true", () => {
    addQuestion("Who created Bitcoin?", "Satoshi Nakamoto", "Crypto", 3);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    const { result } = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));

    expect(tupleBool(getAttempt(wallet1, 1), "correct")).toBe(true);
    expect(tupleUint(getAttempt(wallet1, 1), "total-attempts")).toBe(1n);
  });

  it("correct answer increments player total-correct and current-streak", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 3);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    expect(tupleUint(getPlayerStats(wallet1), "total-correct")).toBe(1n);
    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(1n);
  });

  it("correct answer updates the leaderboard", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 2);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    expect(tupleUint(getLeaderboard(wallet1), "correct-answers")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "total-attempts")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "current-streak")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "score")).toBeGreaterThan(0n);
  });

  it("has-answered-correctly returns true after correct answer", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const { result } = simnet.callReadOnlyFn(
      "witstac", "has-answered-correctly",
      [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    // Returns { type: "true" }
    expect((result as any).type).toBe("true");
  });

  it("commitment is deleted after reveal", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const { result } = simnet.callReadOnlyFn(
      "witstac", "get-commitment", [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(result.type).toBe(ClarityType.OptionalNone);
  });

  it("player WIT balance increases after first correct answer", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1, 0); // Easy = 0.5 WIT
    fundPool(10_000_000);
    const before = getWitBalance(wallet1);
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(getWitBalance(wallet1)).toBeGreaterThan(before);
  });

  it("reward pool balance decreases after payout", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1, 0);
    fundPool(5_000_000);
    const before = getPoolBalance();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(getPoolBalance()).toBeLessThan(before);
  });
});

// ---------------------------------------------------------------
// 8. Reveal-Answer - Wrong Answer
// ---------------------------------------------------------------

describe("reveal-answer - wrong answer", () => {
  it("wrong answer returns (ok false)", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    const wrongAnswer = "Wrong Person";
    commit(wallet1, 1, wrongAnswer);
    const { result } = reveal(wallet1, 1, wrongAnswer);
    expect(result).toStrictEqual(Cl.ok(Cl.bool(false)));
  });

  it("wrong answer does not set attempt.correct", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Wrong Person");
    reveal(wallet1, 1, "Wrong Person");
    expect(tupleBool(getAttempt(wallet1, 1), "correct")).toBe(false);
  });

  it("wrong answer resets player streak to 0", () => {
    // Q1: correct answer (build streak)
    addQuestion("Q1?", "CorrectA", "T", 1);
    // Q2: will answer wrong
    addQuestion("Q2?", "CorrectB", "T", 1);
    fundPool();

    commit(wallet1, 1, "CorrectA");
    reveal(wallet1, 1, "CorrectA");
    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(1n);

    commit(wallet1, 2, "WrongAnswer");
    reveal(wallet1, 2, "WrongAnswer");
    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(0n);
  });

  it("wrong answer does not pay out any WIT", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    const before = getWitBalance(wallet1);
    commit(wallet1, 1, "Wrong Person");
    reveal(wallet1, 1, "Wrong Person");
    expect(getWitBalance(wallet1)).toBe(before);
  });
});

// ---------------------------------------------------------------
// 9. Reveal-Answer - Error Cases
// ---------------------------------------------------------------

describe("reveal-answer - error cases", () => {
  it("reveal without prior commitment returns err u203", () => {
    addQuestion("Q?", "A", "T", 1);
    const { result } = reveal(wallet1, 1, "A");
    expect(result).toStrictEqual(Cl.error(Cl.uint(203)));
  });

  it("revealing with different bytes than committed returns err u205", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    const { result } = reveal(wallet1, 1, "Different Answer");
    expect(result).toStrictEqual(Cl.error(Cl.uint(205)));
  });

  it("expired commitment returns err u204", () => {
    addQuestion("Q?", "A", "T", 1);
    commit(wallet1, 1, "A");
    simnet.mineEmptyBlocks(101);
    const { result } = reveal(wallet1, 1, "A");
    expect(result).toStrictEqual(Cl.error(Cl.uint(204)));
  });

  it("reveal on retired question returns err u202", () => {
    addQuestion("Q?", "A", "T", 1);
    commit(wallet1, 1, "A");
    simnet.callPublicFn("witstac", "retire-question", [Cl.uint(1)], deployer);
    const { result } = reveal(wallet1, 1, "A");
    expect(result).toStrictEqual(Cl.error(Cl.uint(202)));
  });
});

// ---------------------------------------------------------------
// 10. No Double Reward
// ---------------------------------------------------------------

describe("no double reward", () => {
  it("second correct answer on same question gives no extra WIT", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 2);
    fundPool(10_000_000);

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    const balAfter1 = getWitBalance(wallet1);
    const poolAfter1 = getPoolBalance();

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    expect(getWitBalance(wallet1)).toBe(balAfter1);
    expect(getPoolBalance()).toBe(poolAfter1);
  });

  it("second correct answer still increments attempt count", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();

    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    expect(tupleUint(getAttempt(wallet1, 1), "total-attempts")).toBe(2n);
  });

  it("has-answered-correctly stays true after second correct attempt", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    const { result } = simnet.callReadOnlyFn(
      "witstac", "has-answered-correctly",
      [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect((result as any).type).toBe("true");
  });
});

// ---------------------------------------------------------------
// 11. Streak Multipliers
// ---------------------------------------------------------------

describe("streak multipliers", () => {
  it("streak increments with each consecutive correct answer", () => {
    for (let i = 1; i <= 3; i++) {
      addQuestion(`Q${i}?`, `Answer${i}`, "T", 1);
    }
    fundPool(10_000_000);

    for (let i = 1; i <= 3; i++) {
      commit(wallet1, i, `Answer${i}`);
      reveal(wallet1, i, `Answer${i}`);
    }

    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(3n);
  });

  it("streak resets to 0 after a wrong answer", () => {
    addQuestion("Q1?", "A1", "T", 1);
    addQuestion("Q2?", "A2", "T", 1); // will answer wrong
    fundPool(10_000_000);

    commit(wallet1, 1, "A1");
    reveal(wallet1, 1, "A1");
    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(1n);

    commit(wallet1, 2, "WrongGuess");
    reveal(wallet1, 2, "WrongGuess");
    expect(tupleUint(getPlayerStats(wallet1), "current-streak")).toBe(0n);
  });

  it("get-streak returns current streak", () => {
    addQuestion("Cap France?", "Paris", "Geo", 1);
    fundPool();
    commit(wallet1, 1, "Paris");
    reveal(wallet1, 1, "Paris");

    const { result } = simnet.callReadOnlyFn(
      "witstac", "get-streak", [Cl.principal(wallet1)], wallet1
    );
    expect(BigInt((result as any).value)).toBe(1n);
  });

  it("get-streak returns 0 for a new player", () => {
    const { result } = simnet.callReadOnlyFn(
      "witstac", "get-streak", [Cl.principal(wallet3)], wallet3
    );
    expect(BigInt((result as any).value)).toBe(0n);
  });
});

// ---------------------------------------------------------------
// 12. Leaderboard
// ---------------------------------------------------------------

describe("leaderboard", () => {
  it("leaderboard updates after a correct answer", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    fundPool();
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");

    expect(tupleUint(getLeaderboard(wallet1), "correct-answers")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "total-attempts")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "current-streak")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "best-streak")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet1), "score")).toBeGreaterThan(0n);
  });

  it("multiple players have independent leaderboard entries", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 2);
    fundPool(20_000_000);

    commit(wallet1, 1, "Satoshi Nakamoto"); reveal(wallet1, 1, "Satoshi Nakamoto");
    commit(wallet2, 1, "Satoshi Nakamoto"); reveal(wallet2, 1, "Satoshi Nakamoto");

    expect(tupleUint(getLeaderboard(wallet1), "correct-answers")).toBe(1n);
    expect(tupleUint(getLeaderboard(wallet2), "correct-answers")).toBe(1n);
  });
});

// ---------------------------------------------------------------
// 13. Pool Depletion (Deferred Payout)
// ---------------------------------------------------------------

describe("pool depletion", () => {
  it("correct answer is recorded even when pool is empty", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    // No funding — pool = 0

    commit(wallet1, 1, "Satoshi Nakamoto");
    const { result } = reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(result).toStrictEqual(Cl.ok(Cl.bool(true)));

    expect(tupleBool(getAttempt(wallet1, 1), "correct")).toBe(true);
  });

  it("player WIT balance unchanged when pool is empty", () => {
    addQuestion("Q?", "Satoshi Nakamoto", "C", 1);
    const before = getWitBalance(wallet1);
    commit(wallet1, 1, "Satoshi Nakamoto");
    reveal(wallet1, 1, "Satoshi Nakamoto");
    expect(getWitBalance(wallet1)).toBe(before);
  });
});
