# krater
**A NEAR pool whose reserves are the real NEP-141 balances it holds.** Rebase, dividend, or taxed-transfer gains belong to the holders. No owner, pause, or upgrade path exists. Contract [`contracts/pool`](contracts/pool) (Rust, near-sdk 5.30.2), manifest [`manifest.json`](manifest.json), licence Apache-2.0.


```mermaid
sequenceDiagram
    accTitle: krater runtime flow
    accDescr: Harness drives the sandbox: deploy, mint, deposit, add liquidity, rebase, swap, withdraw, claim.
    autonumber
    box rgba(230,247,235,0.12) Clients
    participant S as Harness
    end
    box rgba(243,232,255,0.12) NEAR contracts
    participant FT as PairFT
    participant P as kraterPool
    end
    Note over S,FT: PHASE 1 — Deploy: bootSandbox(), createAccounts(4), new(token_a, token_b, fee_bps)
    Note over S,FT: PHASE 2 — Mint: FT.mint(alice, 5 * TOKEN_SCALE)
    Note over S,P: PHASE 3 — Credit a deposit
    S->>FT: ft_transfer_call(pool, amount, "")
    FT->>P: ft_on_transfer(sender_id, amount, msg)
    P->>P: credit_deposit() at the reported index
    Note over S,P: PHASE 4 — Add liquidity: add_liquidity(amounts, min_shares), mint_shares(), lock MINIMUM_SHARES
    Note over S,P: PHASE 5 — Sync and rebase
    S->>FT: rebase(factor_bps: 11_000)
    S->>P: sync_reserves()
    P-->>S: ReservesSynced, quote +9.99%
    Note over S,P: PHASE 6 — Swap with refund path
    S->>FT: ft_transfer_call(pool, Swap)
    FT->>P: ft_on_transfer(), index_hop_a(true)
    alt out >= min_out
    P->>FT: ft_transfer(sender_id, out)
    else out is zero or below min_out
    P-->>S: refund of the input
    end
    Note over S,P: PHASE 7 — Withdraw: withdraw(shares); settle_withdraw() burns and pays both legs
    Note over S,P: PHASE 8 — Claim owed and events
    S->>P: claim_owed(token)
    S->>P: withdraw_deposit(token, amount)
    P-->>S: Withdraw, CreditWithdrawn events
```

## Pool and shares
LP shares are NEP-141 on the pool account (`FungibleToken` supplies the NEP-145 storage methods). Settlement rides that standard: a holder calls `ft_transfer_call` on a pair token, the token calls `ft_on_transfer` on the pool, which quotes the reported net amount; an empty message credits a deposit that `add_liquidity` spends. Every event is NEP-297 JSON under `krater`.

## Quickstart
Requirements: Rust 1.100.0+, edition 2024, cargo-near 0.23.0, near-cli-rs 0.31.1, wasm-opt (binaryen), Node 26.13.1+; pnpm 12.18.0+ only for tooling builds.
```bash
git clone https://github.com/nirholas/near-krater && cd near-krater && cargo near build non-reproducible-wasm && node scripts/demo.js
```
`scripts/demo.js` starts a near-sandbox chain, deploys both contracts, creates zero-balance accounts, and runs the full flow — no keys or funds needed. Call `storage_deposit` on both tokens and the pool first, because NEP-141 never registers receivers. The clone target above is the published home of this tree; until it is pushed, run these steps from this local checkout.
`non-reproducible-wasm` builds locally without Docker; `scripts/deploy.sh` builds both crates via `scripts/optimize-wasm.sh`, whose `wasm-opt -Oz --converge` cuts pool wasm from `275,053` to `269,972` bytes (−1.85%). Set `RPC_URL` and header variables for live networks.

## Executable spec
`node scripts/measure.js` measures gas per settlement path and the +10% rebase quote delta. `node --test --test-concurrency=1 tests/pool.test.js` covers the refund and owed path, `claim_owed`, `withdraw_deposit`, taxed legs, seeded fuzz, and unregistered payout receivers. `cargo check --workspace --target wasm32-unknown-unknown && cargo test -p krater-pool` compiles, runs unit tests, and builds wasm.

## Numbers, gas and limits
Run `node scripts/measure.js`. A +10% rebase raises `get_quote` by 9.99% in one sandbox run, from `9.920546077802156251e18` to `1.0912600685582371876e19` base units; the script writes `bench.json` and prints each path. Measured gas: `add_liquidity` 21.397, `sync_reserves` 17.250, `withdraw` 28.635, `swap` 28.110, `withdraw_deposit` 10.356, `claim_owed` 6.478 Tgas (transaction plus every receipt's `gas_burnt`). The quote delta is deterministic; gas varies slightly across node schedules.
Static gas makes client budgeting exact: the pool attaches 90/80/70/60 Tgas to the four sync callbacks, 25 Tgas to fill and 45 Tgas to settle, 8 Tgas to terminal callbacks, 5 Tgas to token views, and 10 Tgas plus one yoctoNEAR to each `ft_transfer`; the client attaches 200 Tgas to `ft_transfer_call`, 300 Tgas to `add_liquidity` and `withdraw`, 100 Tgas to `sync_reserves`, and 60–100 Tgas to `claim_owed` and `withdraw_deposit`, inside the 1000 Tgas per-call and 1 PGas per-transaction limits.

## Limits, layout and origin
- Holding real tokens costs more per settlement than accounting-only designs; tokens that freeze or seize balances can do so here, and a third-token airdrop cannot be recovered. Exact-output swaps are refused rather than approximated, because a taxed token cannot guarantee exact delivery, and a direct transfer donates to all shares.
- `PoolEvent::Swap.amount_out_gross` records what the pool sent before any output token tax; credits unspent by `add_liquidity` stay withdrawable through `withdraw_deposit` and out of tradeable reserves.
krater ports [`nirholas/rebase-absorb`](https://github.com/nirholas/rebase-absorb) (Apache-2.0) from Solidity to Rust and NEP-141, keeping `LICENSE` verbatim and `NOTICE` with the origin line corrected — see [`ATTRIBUTION.md`](ATTRIBUTION.md). Track: `memecoins`. Submission draft: [`SUBMISSION-PREP.md`](SUBMISSION-PREP.md).

Q-015 (second project on this email): **subrosa** (private payroll, tracks `privacy`, `realworld`).

## Baseline and disclosure

Baseline: tag `pre-hackathon` marks the imported tree at `d6eafae`; upstream is `nirholas/rebase-absorb`.
Submission: tag `hackathon-submission` marks the submitted state; `git rev-parse --short hackathon-submission` prints it.
Diff: `git diff pre-hackathon..hackathon-submission`. After publishing, https://github.com/<owner>/<repo>/compare/pre-hackathon...hackathon-submission.
Libraries, templates and AI-generated code are listed in `ATTRIBUTION.md` and `NOTICE`.
