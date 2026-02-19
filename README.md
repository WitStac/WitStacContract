# WitStac 🧠

> An on-chain trivia game on the Stacks blockchain — answer questions, earn STX, climb the leaderboard.

WitStac is an open-source, fully on-chain trivia game built in Clarity on Stacks. Any address can attempt as many questions as they want, earn STX rewards for correct answers, and compete on a permanent on-chain leaderboard. No backend. No database. No trust required — just knowledge and Clarity.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Game Mechanics](#game-mechanics)
- [Contract Reference](#contract-reference)
- [Getting Started](#getting-started)
- [Playing the Game](#playing-the-game)
- [Adding Questions](#adding-questions)
- [Leaderboard](#leaderboard)
- [Reward System](#reward-system)
- [Anti-Cheat Model](#anti-cheat-model)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Most trivia games live on centralized servers — answers can be manipulated, rewards can be withheld, and leaderboards can be faked. WitStac puts everything on-chain. Questions, answers (hashed), attempt history, scores, streaks, and rewards are all stored in the Clarity contract and verifiable by anyone.

**Any address can:**
- Browse available questions
- Attempt any question as many times as they like
- Earn STX for every correct first-time answer
- Build streaks for bonus multipliers
- See their full attempt history on-chain
- Compete on the global leaderboard

---

## Features

- 🧠 **Unlimited attempts per address** — every address can try every question
- 💸 **STX rewards** — earn real STX for correct answers
- 🔥 **Streak multipliers** — consecutive correct answers boost your reward
- 🏆 **On-chain leaderboard** — permanent, tamper-proof rankings
- 🔐 **Hashed answers** — answer hashes stored on-chain, preventing front-running
- 📚 **Multi-category support** — Science, History, Crypto, Pop Culture, and more
- 🎯 **Difficulty tiers** — Easy, Medium, Hard, and Expert questions with scaled rewards
- 📊 **Full attempt history** — every answer attempt logged per address
- 🛡️ **Commitment scheme** — submit answer hash first, reveal later to prevent copying
- 👑 **Admin question management** — owner can add, update, and retire questions
- 🧪 **Full Clarinet test suite**

---

## How It Works

```
Player                         WitStac Contract
  │                                   │
  │── browse-questions ──────────────►│
  │◄─ list of question IDs & metadata─│
  │                                   │
  │── commit-answer (hash) ──────────►│  Step 1: commit
  │◄─ commitment stored ──────────────│
  │                                   │
  │── reveal-answer (plaintext) ──────►│  Step 2: reveal
  │◄─ correct / incorrect + reward ───│
  │                                   │
  │── get-leaderboard ───────────────►│
  │◄─ top players by score ───────────│
```

WitStac uses a **commit-reveal scheme** to keep answers fair:

1. **Commit** — player submits a hash of their answer before revealing it. This prevents other players from copying answers by watching the mempool.
2. **Reveal** — player submits their plaintext answer. The contract hashes it and compares against the stored answer hash.
3. **Reward** — if correct and it's the player's first correct attempt on that question, STX is sent immediately.

---

## Architecture

WitStac is a single Clarity contract with supporting data maps for questions, attempts, commitments, and the leaderboard.

```
┌─────────────────────────────────────────────────────────┐
│                    witstac.clar                         │
│                                                         │
│  ┌─────────────────┐   ┌──────────────────────────────┐│
│  │  Question Map   │   │       Attempt Map            ││
│  │  id → {         │   │  {player, question-id} → {   ││
│  │    text,        │   │    attempts,                 ││
│  │    answer-hash, │   │    correct,                  ││
│  │    category,    │   │    last-attempt-block        ││
│  │    difficulty,  │   │  }                           ││
│  │    reward,      │   └──────────────────────────────┘│
│  │    active       │                                    │
│  │  }              │   ┌──────────────────────────────┐│
│  └─────────────────┘   │     Commitment Map           ││
│                        │  {player, question-id} → {   ││
│  ┌─────────────────┐   │    answer-hash,              ││
│  │ Leaderboard Map │   │    block-height              ││
│  │  player → {     │   │  }                           ││
│  │    score,       │   └──────────────────────────────┘│
│  │    correct,     │                                    │
│  │    streak,      │   ┌──────────────────────────────┐│
│  │    best-streak  │   │      Player Stats Map        ││
│  │  }              │   │  player → {                  ││
│  └─────────────────┘   │    total-attempts,           ││
│                        │    total-correct,            ││
│                        │    total-earned,             ││
│                        │    current-streak            ││
│                        │  }                           ││
│                        └──────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

---

## Game Mechanics

### Difficulty Tiers & Base Rewards

| Tier | Label | Base Reward | Example Categories |
|---|---|---|---|
| 1 | Easy | 0.5 STX | General knowledge, Pop Culture |
| 2 | Medium | 1 STX | Science, Geography, Sports |
| 3 | Hard | 2.5 STX | History, Technology, Crypto |
| 4 | Expert | 5 STX | Bitcoin, Stacks, Clarity dev |

### Streak Multipliers

Consecutive correct answers across any questions boost your reward:

| Streak | Multiplier |
|---|---|
| 1–2 correct | 1x (base reward) |
| 3–4 correct | 1.25x |
| 5–9 correct | 1.5x |
| 10–19 correct | 2x |
| 20+ correct | 3x |

A single wrong answer resets your streak to zero.

### Unlimited Attempts Policy

- Any address can attempt any question **as many times as they want**
- STX rewards are only paid on the **first correct answer** per question per address
- Subsequent correct answers on the same question still count toward your streak and score
- All attempts (correct and incorrect) are permanently logged on-chain
- There is no cooldown between attempts — play at your own pace

### Scoring

Each correct answer awards points based on difficulty and attempt number:

```
Points = base-points × difficulty-multiplier × (1 / attempt-number)
```

Getting a question right on the first try awards full points. Later correct attempts award fewer points but still reward streaks and STX (first time only).

---

## Contract Reference

### Public Functions

#### `commit-answer`
Submit a hashed answer to a question. Must be called before `reveal-answer`.

```clarity
(define-public (commit-answer
  (question-id uint)
  (answer-hash (buff 32)))
```

| Parameter | Description |
|---|---|
| `question-id` | ID of the question being answered |
| `answer-hash` | SHA-256 hash of the plaintext answer |

---

#### `reveal-answer`
Reveal your plaintext answer. Contract hashes it and compares to the stored answer hash.

```clarity
(define-public (reveal-answer
  (question-id uint)
  (answer (string-ascii 128)))
```

| Parameter | Description |
|---|---|
| `question-id` | ID of the question being answered |
| `answer` | Plaintext answer string (case-insensitive) |

Returns `(ok true)` if correct with STX reward, `(ok false)` if incorrect.

---

#### `add-question` *(owner only)*
Add a new question to the game.

```clarity
(define-public (add-question
  (text (string-utf8 512))
  (answer-hash (buff 32))
  (category (string-ascii 32))
  (difficulty uint)
  (reward uint))
```

---

#### `retire-question` *(owner only)*
Mark a question as inactive. Existing attempt history is preserved.

```clarity
(define-public (retire-question (question-id uint))
```

---

#### `fund-reward-pool` *(anyone)*
Add STX to the contract reward pool. Anyone can top up the pool.

```clarity
(define-public (fund-reward-pool (amount uint))
```

---

### Read-Only Functions

```clarity
;; Get question metadata (text, category, difficulty — NOT the answer hash)
(define-read-only (get-question (question-id uint)))

;; Get a player's attempt record for a specific question
(define-read-only (get-attempt (player principal) (question-id uint)))

;; Get a player's full stats (score, streak, total earned)
(define-read-only (get-player-stats (player principal)))

;; Get total number of questions in the game
(define-read-only (get-question-count))

;; Get current reward pool balance
(define-read-only (get-reward-pool-balance))

;; Get leaderboard entry for a player
(define-read-only (get-leaderboard-entry (player principal)))

;; Check if a player has already answered a question correctly
(define-read-only (has-answered-correctly (player principal) (question-id uint)))

;; Get a player's current streak
(define-read-only (get-streak (player principal)))

;; Get commitment for a player/question pair
(define-read-only (get-commitment (player principal) (question-id uint)))
```

---

### Error Codes

| Code | Constant | Description |
|---|---|---|
| `u200` | `err-not-owner` | Caller is not the contract owner |
| `u201` | `err-question-not-found` | Question ID does not exist |
| `u202` | `err-question-inactive` | Question has been retired |
| `u203` | `err-no-commitment` | Must commit before revealing |
| `u204` | `err-commitment-expired` | Commitment too old, must recommit |
| `u205` | `err-hash-mismatch` | Revealed answer does not match commitment |
| `u206` | `err-insufficient-pool` | Reward pool is empty or too low |
| `u207` | `err-invalid-difficulty` | Difficulty must be between 1 and 4 |
| `u208` | `err-duplicate-question` | Question text already exists |
| `u209` | `err-invalid-answer-length` | Answer exceeds maximum length |
| `u210` | `err-already-committed` | Active commitment exists for this question |

---

## Getting Started

### Prerequisites

- [Clarinet](https://github.com/hirosystems/clarinet) — Clarity development toolchain
- [Hiro Wallet](https://wallet.hiro.so/) — for testnet/mainnet play
- Node.js v18+ — for helper scripts
- STX for gas fees

### Installation

```bash
# Clone the repo
git clone https://github.com/your-username/witstac.git
cd witstac

# Install dependencies
npm install

# Verify contracts compile
clarinet check

# Run the test suite
clarinet test
```

---

## Playing the Game

### Step 1 — Browse questions

```clarity
;; Get total number of active questions
(contract-call? .witstac get-question-count)

;; Get metadata for question 1
(contract-call? .witstac get-question u1)
```

Returns question text, category, difficulty, and reward — but never the answer hash.

### Step 2 — Commit your answer

Hash your answer locally using SHA-256, then commit:

```bash
# Hash your answer using the helper script
node scripts/hash-answer.js "Marie Curie"
# → 0x4b2f8c...your-hash
```

```clarity
;; Submit your commitment
(contract-call? .witstac commit-answer u1 0x4b2f8c...)
```

### Step 3 — Reveal your answer

```clarity
;; Reveal your plaintext answer (within 100 blocks of committing)
(contract-call? .witstac reveal-answer u1 "Marie Curie")
```

The contract hashes your answer, compares it, and immediately sends STX if correct.

### Step 4 — Check your stats

```clarity
;; View your stats
(contract-call? .witstac get-player-stats 'SPYourAddress...)

;; Check your streak
(contract-call? .witstac get-streak 'SPYourAddress...)
```

---

## Adding Questions

Questions are added by the contract owner. To add a question:

```bash
# Hash the answer using the helper script
node scripts/hash-answer.js "Satoshi Nakamoto"
# → 0xabc123...
```

```clarity
;; Add a Hard crypto question with 2.5 STX reward
(contract-call? .witstac add-question
  u"Who created Bitcoin?"
  0xabc123...
  "Crypto"
  u3
  u2500000)
```

> 📝 Answer hashing is case-insensitive and trims whitespace — "satoshi nakamoto", "Satoshi Nakamoto", and " SATOSHI NAKAMOTO " all hash to the same value in WitStac.

---

## Leaderboard

The leaderboard is stored entirely on-chain. Every player's score, correct answer count, and best streak are permanently recorded.

```clarity
;; Get leaderboard stats for any address
(contract-call? .witstac get-leaderboard-entry 'SP1234...player)
```

Leaderboard stats per player:

| Field | Description |
|---|---|
| `score` | Total accumulated points |
| `correct-answers` | Total number of correct answers |
| `total-attempts` | Total number of answer attempts |
| `current-streak` | Current consecutive correct streak |
| `best-streak` | All-time best streak |
| `total-earned` | Total STX earned (in microSTX) |

---

## Reward System

### Reward Pool

WitStac maintains a reward pool funded by:
- Initial owner deposit at deployment
- Community top-ups via `fund-reward-pool`
- Optional entry fees (configurable)

Rewards are paid instantly on correct first-time answers. If the pool runs low, the contract still records correct answers and scores but holds the STX payout as a claimable balance until the pool is refilled.

### Reward Calculation

```
final-reward = base-reward × streak-multiplier
```

**Example:**
- Player is on a 7-question correct streak (1.5x multiplier)
- Answers an Expert question correctly for the first time (5 STX base)
- Reward = 5 STX × 1.5 = **7.5 STX** paid instantly

---

## Anti-Cheat Model

WitStac uses several mechanisms to keep the game fair:

**Commit-reveal scheme** — players hash their answer before submitting it. This prevents mempool snooping where a bad actor watches pending transactions and copies the answer before it lands.

**Commitment expiry** — commitments expire after 100 blocks (~16 hours). If you commit and don't reveal in time, you must recommit. This prevents indefinite answer hoarding.

**On-chain answer hashing** — answer hashes are stored on-chain but answers themselves are never stored. Even contract owners cannot derive answers from hashes.

**First-correct-only rewards** — STX is only paid the first time an address gets a question right. Repeated correct answers still score points and maintain streaks but do not drain the pool.

**Attempt logging** — every attempt is permanently logged. Players cannot erase their history or game their attempt count.

**No admin answer access** — the owner can add and retire questions but cannot view plaintext answers of other players or alter attempt history.

---

## Project Structure

```
witstac/
├── contracts/
│   └── witstac.clar                # Main trivia game contract
├── tests/
│   └── witstac_test.ts             # Full Clarinet test suite
├── scripts/
│   ├── hash-answer.js              # Local answer hashing utility
│   ├── add-questions.ts            # Bulk question import script
│   ├── fund-pool.ts                # Reward pool funding script
│   └── leaderboard.ts             # Fetch and display leaderboard
├── data/
│   └── questions.json              # Question bank (answers hashed)
├── deployments/
│   ├── devnet.yaml
│   ├── testnet.yaml
│   └── mainnet.yaml
├── settings/
│   └── Devnet.toml
├── Clarinet.toml
├── package.json
└── README.md
```

---

## Testing

```bash
# Run all tests
clarinet test

# Run with coverage
clarinet test --coverage

# Open interactive Clarinet console
clarinet console
```

### Test coverage includes

- Commit and reveal happy path (correct answer)
- Commit and reveal with wrong answer
- Reveal without prior commitment (rejected)
- Expired commitment rejection
- Hash mismatch on reveal
- First correct answer pays STX reward
- Second correct answer on same question — no double reward
- Streak increments on consecutive correct answers
- Streak resets on wrong answer
- Streak multiplier applied to reward calculation
- Leaderboard updates correctly
- Retire question — no new attempts accepted
- Fund reward pool from any address
- Insufficient pool — correct answer recorded, payout deferred
- Owner-only question management
- All error codes triggered and verified

---

## Roadmap

- [x] Core commit-reveal answer mechanic
- [x] STX rewards on correct answers
- [x] Streak multipliers
- [x] On-chain leaderboard
- [x] Multi-category question support
- [x] Difficulty tiers with scaled rewards
- [ ] Web UI for browsing and answering questions
- [ ] Community question submission (with owner review)
- [ ] Daily challenge — one featured question per day with bonus rewards
- [ ] NFT trophy for milestone achievements (10, 50, 100 correct answers)
- [ ] Token-gated expert questions (hold a WitStac NFT to unlock)
- [ ] Multiplayer head-to-head mode — two players race to answer first
- [ ] Time-limited rounds with prize pools
- [ ] Integration with StacksMint — earn custom WIT tokens instead of STX
- [ ] Mobile-friendly frontend

---

## Contributing

Contributions are welcome — especially new questions! To contribute:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests for your changes
4. Ensure all tests pass (`clarinet test`)
5. Open a pull request with a clear description

To contribute questions, add them to `data/questions.json` following the existing schema. Do **not** include plaintext answers in the repository — only hashed answers.

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for our full guidelines.

---

## License

WitStac is open source under the [MIT License](./LICENSE).

---

Built with ❤️ on [Stacks](https://stacks.co) — Bitcoin's smart contract layer.
