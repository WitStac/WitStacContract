;; title: WitStac
;; version: 1.0.0
;; summary: On-chain trivia game on Stacks - answer questions, earn WIT tokens, climb the leaderboard.
;; description:
;;   WitStac is a fully on-chain trivia game built in Clarity.
;;   Players commit a SHA-256 hash of their answer, then reveal the plaintext.
;;   Correct first-time answers earn WIT token rewards (mock STX for dev/testnet).
;;   Streaks unlock multipliers. All history is permanently on-chain.

;; ============================================================
;; Constants - Owner & Game Config
;; ============================================================

(define-constant contract-owner   tx-sender)
(define-constant commitment-window u100) ;; blocks a commitment stays valid (~16 hrs on Stacks)

;; Default difficulty tier rewards (WIT micro-units, 1 WIT = 1_000_000)
;; Easy=0.5 WIT, Medium=1 WIT, Hard=2.5 WIT, Expert=5 WIT
;; These are used by get-difficulty-reward below.
(define-constant reward-easy   u500000)
(define-constant reward-medium u1000000)
(define-constant reward-hard   u2500000)
(define-constant reward-expert u5000000)


;; Error codes
(define-constant err-not-owner            (err u200))
(define-constant err-question-not-found   (err u201))
(define-constant err-question-inactive    (err u202))
(define-constant err-no-commitment        (err u203))
(define-constant err-commitment-expired   (err u204))
(define-constant err-hash-mismatch        (err u205))
(define-constant err-invalid-difficulty   (err u207))
(define-constant err-already-committed    (err u210))

;; ============================================================
;; Data Variables
;; ============================================================

(define-data-var question-count      uint u0)
(define-data-var reward-pool-balance uint u0)

;; ============================================================
;; Data Maps
;; ============================================================

;; Questions map
(define-map questions
  { question-id: uint }
  {
    text:        (string-utf8 512),
    answer-hash: (buff 32),
    category:    (string-ascii 32),
    difficulty:  uint,
    reward:      uint,
    active:      bool
  })

;; Attempts per player per question
(define-map attempts
  { player: principal, question-id: uint }
  {
    total-attempts:     uint,
    correct:            bool,
    last-attempt-block: uint
  })

;; Commitments: stores hashed answer before reveal
(define-map commitments
  { player: principal, question-id: uint }
  {
    answer-hash:  (buff 32),
    block-height: uint
  })

;; Player global stats
(define-map player-stats
  { player: principal }
  {
    total-attempts: uint,
    total-correct:  uint,
    total-earned:   uint,   ;; cumulative WIT earned (micro-units)
    current-streak: uint
  })

;; Leaderboard
(define-map leaderboard
  { player: principal }
  {
    score:           uint,
    correct-answers: uint,
    total-attempts:  uint,
    current-streak:  uint,
    best-streak:     uint,
    total-earned:    uint
  })

;; ============================================================
;; Private Helper Functions
;; ============================================================


;; Map difficulty (1-4) to its default base reward
(define-private (get-difficulty-reward (difficulty uint))
  (if (is-eq difficulty u1) reward-easy
    (if (is-eq difficulty u2) reward-medium
      (if (is-eq difficulty u3) reward-hard
        reward-expert))))

;; Streak multiplier in basis points (10000 = 1.0x, 12500 = 1.25x, etc.)
;;   streak 0-2:  1x    (10000 bp)
;;   streak 3-4:  1.25x (12500 bp)
;;   streak 5-9:  1.5x  (15000 bp)
;;   streak 10-19: 2x   (20000 bp)
;;   streak 20+:  3x    (30000 bp)
(define-private (get-streak-multiplier (streak uint))
  (if (< streak u3)   u10000
    (if (< streak u5)  u12500
      (if (< streak u10) u15000
        (if (< streak u20) u20000
          u30000)))))

;; Apply multiplier: reward * basis-points / 10000
(define-private (apply-multiplier (reward uint) (basis-points uint))
  (/ (* reward basis-points) u10000))

;; Score points for a correct answer: base-reward / attempt-number
;; First attempt = full points; later attempts = fewer points
(define-private (calc-points (base-reward uint) (attempt-num uint))
  (if (is-eq attempt-num u0) base-reward
    (/ base-reward attempt-num)))

;; Ensure a player-stats record exists; initialise with zeros if missing
(define-private (ensure-player-stats (player principal))
  (if (is-none (map-get? player-stats { player: player }))
    (begin
      (map-set player-stats { player: player }
        { total-attempts: u0, total-correct: u0, total-earned: u0, current-streak: u0 })
      true)
    true))

;; Ensure a leaderboard record exists; initialise with zeros if missing
(define-private (ensure-leaderboard (player principal))
  (if (is-none (map-get? leaderboard { player: player }))
    (begin
      (map-set leaderboard { player: player }
        { score: u0, correct-answers: u0, total-attempts: u0,
          current-streak: u0, best-streak: u0, total-earned: u0 })
      true)
    true))

;; Update player-stats after a reveal attempt
(define-private (update-player-stats-after-reveal
    (player     principal)
    (is-correct bool)
    (earned     uint))
  (let ((s (unwrap-panic (map-get? player-stats { player: player }))))
    (map-set player-stats { player: player }
      {
        total-attempts: (+ (get total-attempts s) u1),
        total-correct:  (if is-correct (+ (get total-correct s) u1) (get total-correct s)),
        total-earned:   (+ (get total-earned s) earned),
        current-streak: (if is-correct (+ (get current-streak s) u1) u0)
      })))

;; Update leaderboard after a reveal attempt
(define-private (update-leaderboard-after-reveal
    (player     principal)
    (is-correct bool)
    (points     uint)
    (earned     uint))
  (let ((e (unwrap-panic (map-get? leaderboard { player: player }))))
    (let (
      (new-streak (if is-correct (+ (get current-streak e) u1) u0))
      (new-best   (if (> new-streak (get best-streak e)) new-streak (get best-streak e)))
    )
      (map-set leaderboard { player: player }
        {
          score:           (+ (get score e) points),
          correct-answers: (if is-correct (+ (get correct-answers e) u1) (get correct-answers e)),
          total-attempts:  (+ (get total-attempts e) u1),
          current-streak:  new-streak,
          best-streak:     new-best,
          total-earned:    (+ (get total-earned e) earned)
        }))))

;; (payout logic is inlined directly in reveal-answer so as-contract works correctly)

;; ============================================================
;; Public Functions - Admin
;; ============================================================

;; Add a new trivia question (owner only)
(define-public (add-question
    (text        (string-utf8 512))
    (answer-hash (buff 32))
    (category    (string-ascii 32))
    (difficulty  uint)
    (reward      uint))
  (begin
    (asserts! (is-eq tx-sender contract-owner) err-not-owner)
    (asserts! (and (>= difficulty u1) (<= difficulty u4)) err-invalid-difficulty)
    (let (
      (new-id      (+ (var-get question-count) u1))
      (final-reward (if (is-eq reward u0) (get-difficulty-reward difficulty) reward))
    )
      (var-set question-count new-id)
      (map-set questions { question-id: new-id }
        {
          text:        text,
          answer-hash: answer-hash,
          category:    category,
          difficulty:  difficulty,
          reward:      final-reward,
          active:      true
        })
      (ok new-id))))

;; Retire a question - marks inactive; attempt history is preserved (owner only)
(define-public (retire-question (question-id uint))
  (begin
    (asserts! (is-eq tx-sender contract-owner) err-not-owner)
    (let ((q (unwrap! (map-get? questions { question-id: question-id })
                      err-question-not-found)))
      (map-set questions { question-id: question-id }
        (merge q { active: false }))
      (ok true))))

;; ============================================================
;; Public Functions - Reward Pool
;; ============================================================

;; Fund the reward pool by minting WIT tokens into this contract.
;; Anyone can call this to top up the pool.
;; contract-caller inside wit-token will be .witstac automatically (cross-contract call).
(define-public (fund-reward-pool (amount uint))
  (let ((contract-address (as-contract tx-sender)))
    (try! (contract-call? .wit-token mint amount contract-address))
    (var-set reward-pool-balance (+ (var-get reward-pool-balance) amount))
    (ok (var-get reward-pool-balance))))

;; ============================================================
;; Public Functions - Game: Commit-Reveal
;; ============================================================

;; STEP 1: Commit
;; Player submits SHA-256 hash of their plaintext answer.
;; This prevents mempool snooping (front-running).
(define-public (commit-answer
    (question-id uint)
    (answer-hash (buff 32)))
  (let ((q (unwrap! (map-get? questions { question-id: question-id })
                    err-question-not-found)))
    (asserts! (get active q) err-question-inactive)
    ;; Block if an unexpired commitment already exists for this player+question
    (match (map-get? commitments { player: tx-sender, question-id: question-id })
      existing
        (asserts!
          (> block-height (+ (get block-height existing) commitment-window))
          err-already-committed)
      true)
    (map-set commitments { player: tx-sender, question-id: question-id }
      { answer-hash: answer-hash, block-height: block-height })
    (ok true)))

;; STEP 2: Reveal
;; Player submits plaintext answer. Contract hashes it and compares.
;; Returns (ok true) if correct, (ok false) if incorrect.
;; WIT reward paid only on the first correct answer per question per address.
(define-public (reveal-answer
    (question-id uint)
    (answer      (buff 128)))
  (let (
    (q            (unwrap! (map-get? questions { question-id: question-id })
                           err-question-not-found))
    (commitment   (unwrap! (map-get? commitments { player: tx-sender, question-id: question-id })
                           err-no-commitment))
    (attempt-data (default-to
                    { total-attempts: u0, correct: false, last-attempt-block: u0 }
                    (map-get? attempts { player: tx-sender, question-id: question-id })))
  )
    ;; Question must be active
    (asserts! (get active q) err-question-inactive)
    ;; Commitment must not be expired
    (asserts!
      (<= block-height (+ (get block-height commitment) commitment-window))
      err-commitment-expired)

    ;; Ensure player records are initialised
    (ensure-player-stats tx-sender)
    (ensure-leaderboard tx-sender)

    (let (
      (new-attempt-num      (+ (get total-attempts attempt-data) u1))
      (already-correct      (get correct attempt-data))
      (stats                (unwrap-panic (map-get? player-stats { player: tx-sender })))
      (current-streak       (get current-streak stats))
      ;; SHA-256 hash of the revealed plaintext answer
      (revealed-hash        (sha256 answer))
      ;; Verify commitment hash matches what player just revealed
      (hash-matches-commit  (is-eq (get answer-hash commitment) revealed-hash))
      ;; Verify revealed answer matches the stored question answer
      (is-correct           (and hash-matches-commit (is-eq (get answer-hash q) revealed-hash)))
    )
      ;; Commitment hash must match revealed answer (anti-tampering check)
      (asserts! hash-matches-commit err-hash-mismatch)

      ;; Remove the used commitment regardless of correctness
      (map-delete commitments { player: tx-sender, question-id: question-id })

      ;; Update attempt record
      (map-set attempts { player: tx-sender, question-id: question-id }
        {
          total-attempts:     new-attempt-num,
          correct:            (or already-correct is-correct),
          last-attempt-block: block-height
        })

      (let (
        (base-reward  (get reward q))
        (multiplier   (get-streak-multiplier current-streak))
        ;; Final reward applies streak multiplier (only relevant if correct)
        (final-reward (if is-correct (apply-multiplier base-reward multiplier) u0))
        ;; Points = base-reward / attempt-number (full for first try, less for retries)
        (points       (if is-correct (calc-points base-reward new-attempt-num) u0))
        ;; Payout only on very first correct answer per question
        (earned       (if (and is-correct (not already-correct)) final-reward u0))
      )
        ;; Update stats and leaderboard
        (update-player-stats-after-reveal tx-sender is-correct earned)
        (update-leaderboard-after-reveal  tx-sender is-correct points earned)

        ;; Pay WIT reward (first correct attempt only)
        (if (and is-correct (not already-correct))
          (if (>= (var-get reward-pool-balance) final-reward)
            (let ((recipient tx-sender))
              (begin
                (var-set reward-pool-balance (- (var-get reward-pool-balance) final-reward))
                (try! (as-contract (contract-call? .wit-token transfer final-reward tx-sender recipient none)))
                (ok true)))
            ;; Pool too low - win recorded, payout deferred
            (ok true))
          (ok is-correct))))))

;; ============================================================
;; Read-Only Functions
;; ============================================================

;; Get question metadata - answer-hash is never returned to callers
(define-read-only (get-question (question-id uint))
  (match (map-get? questions { question-id: question-id })
    q (ok {
        text:       (get text q),
        category:   (get category q),
        difficulty: (get difficulty q),
        reward:     (get reward q),
        active:     (get active q)
      })
    (err err-question-not-found)))

;; Get a player's attempt record for a specific question
(define-read-only (get-attempt (player principal) (question-id uint))
  (map-get? attempts { player: player, question-id: question-id }))

;; Get a player's global stats
(define-read-only (get-player-stats (player principal))
  (map-get? player-stats { player: player }))

;; Get total number of questions ever added
(define-read-only (get-question-count)
  (ok (var-get question-count)))

;; Get current WIT reward pool balance (micro-units)
(define-read-only (get-reward-pool-balance)
  (ok (var-get reward-pool-balance)))

;; Get leaderboard entry for a player
(define-read-only (get-leaderboard-entry (player principal))
  (map-get? leaderboard { player: player }))

;; Check if a player has already answered a question correctly
(define-read-only (has-answered-correctly (player principal) (question-id uint))
  (match (map-get? attempts { player: player, question-id: question-id })
    a (get correct a)
    false))

;; Get a player's current answer streak
(define-read-only (get-streak (player principal))
  (match (map-get? player-stats { player: player })
    s (get current-streak s)
    u0))

;; Get the active commitment for a player+question pair (if any)
(define-read-only (get-commitment (player principal) (question-id uint))
  (map-get? commitments { player: player, question-id: question-id }))

;; ============================================================
;; Utility Testing Functions
;; ============================================================

(define-data-var test-counter uint u0)

(define-public (increment)
  (begin
    (var-set test-counter (+ (var-get test-counter) u1))
    (ok (var-get test-counter))
  )
)

(define-public (decrement)
  (begin
    (asserts! (> (var-get test-counter) u0) (err u0))
    (var-set test-counter (- (var-get test-counter) u1))
    (ok (var-get test-counter))
  )
)
