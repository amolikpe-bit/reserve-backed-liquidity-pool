# krater

Track: `defi` · Apache-2.0 · baseline tag `pre-hackathon` at `d6eafae`, upstream [`nirholas/rebase-absorb`](https://github.com/nirholas/rebase-absorb), tag `hackathon-submission`, `git rev-parse --short hackathon-submission`, diff `git diff pre-hackathon..hackathon-submission`, https://github.com/<owner>/<repo>/compare/pre-hackathon...hackathon-submission · Q-015 sibling: **subrosa** (private payroll, tracks `privacy`, `realworld`)

A NEAR pool whose reserves are the real NEP-141 balances it holds, so rebase, dividend and taxed-transfer gains belong to holders, not an owner. No pause, no upgrade path, no custodian: anyone can add liquidity, swap, withdraw and claim.

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

```bash
# Rust 1.100.0+, edition 2024, cargo-near 0.23.0, near-cli-rs 0.31.1, wasm-opt (binaryen), Node 26.13.1+, pnpm 12.18.0+, near-sdk 5.30.2; scripts/deploy.sh, scripts/optimize-wasm.sh, contracts/pool, manifest.json, FungibleToken NEP-145, NEP-297, NOTICE, SUBMISSION-PREP.md, RPC_URL, storage_deposit, PoolEvent::Swap.amount_out_gross
git clone https://github.com/nirholas/near-krater && cd near-krater && cargo near build non-reproducible-wasm && node scripts/demo.js
node scripts/measure.js; node --test --test-concurrency=1 tests/pool.test.js; cargo test
cargo check --workspace --target wasm32-unknown-unknown && cargo test -p krater-pool; wasm-opt -Oz --converge
# 275,053 -> 269,972 bytes (-1.85%); +10% rebase -> get_quote +9.99%: 9.920546077802156251e18 -> 1.0912600685582371876e19 base units; bench.json; gas_burnt Tgas: add_liquidity 21.397, sync_reserves 17.250, withdraw 28.635, swap 28.110, withdraw_deposit 10.356, claim_owed 6.478
# sync 90/80/70/60, fill 25, settle 45, terminal 8, views 5, ft_transfer 10 Tgas + one yoctoNEAR; client 200/300/100/60–100 Tgas (ft_transfer_call/add_liquidity/withdraw/sync_reserves/claim_owed/withdraw_deposit); 1000 Tgas/call, 1 PGas/tx
```

| Do this | See this | Proves |
| --- | --- | --- |
| `cargo near build non-reproducible-wasm`, `node scripts/demo.js` | wasm −1.85% smaller; near-sandbox deploys both contracts, runs full flow — no keys/funds; `storage_deposit` first | quickstart |
| `node scripts/measure.js` | rebase quote delta +9.99%; writes `bench.json` and prints each path | smoke/measure |
| `node --test --test-concurrency=1 tests/pool.test.js` · `cargo test -p krater-pool` | refund/owed path, `claim_owed`, `withdraw_deposit`, taxed legs, seeded fuzz; wasm builds | tests |
| `cargo test` | pool, token and harness tests pass | mechanics tested |
| sandbox harness run | deploy, mint, deposit, add liquidity, rebase, swap, withdraw, claim | end-to-end flow |
| measured gas numbers from the README | exact client budgeting: 6.478 Tgas measured | cost is known |
| Limits | no owner, no pause, no upgrade path; "Exact-output swaps are refused rather than approximated" | documented limits |

[ATTRIBUTION.md](ATTRIBUTION.md) · [LICENSE](LICENSE)
