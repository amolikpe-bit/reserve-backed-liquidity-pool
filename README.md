# krater

Track: `defi` · Apache-2.0 · baseline tag `pre-hackathon` at `d6eafae`, upstream [`nirholas/rebase-absorb`](https://github.com/nirholas/rebase-absorb), submission tag `hackathon-submission`; diff `git diff pre-hackathon..hackathon-submission` · Q-015 sibling: **subrosa** (private payroll, tracks `privacy`, `realworld`)

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
cargo near build non-reproducible-wasm   # wasm -1.85%
node scripts/demo.js                     # sandbox: deploy, mint, deposit, add liquidity, rebase, swap, withdraw, claim
node scripts/measure.js                  # +9.99% rebase quote, bench.json
node --test --test-concurrency=1 tests/pool.test.js
cargo test                               # pool, token, harness
```

| Do this | See this | Proves |
| --- | --- | --- |
| `cargo near build non-reproducible-wasm`, `node scripts/demo.js` | wasm −1.85% smaller; near-sandbox deploys both contracts, runs full flow — no keys/funds; `storage_deposit` first | quickstart |
| `node scripts/measure.js` | rebase quote delta +9.99%; writes `bench.json` and prints each path | smoke/measure |
| `node --test --test-concurrency=1 tests/pool.test.js` · `cargo test -p krater-pool` | refund/owed path, `claim_owed`, `withdraw_deposit`, taxed legs, seeded fuzz; wasm builds | tests |
| `cargo test` | pool, token and harness tests pass | mechanics tested |
| sandbox harness run | deploy, mint, deposit, add liquidity, rebase, swap, withdraw, claim | end-to-end flow |
| Limits | no owner, no pause, no upgrade path; "Exact-output swaps are refused rather than approximated" | documented limits |

[ATTRIBUTION.md](ATTRIBUTION.md) · [LICENSE](LICENSE)
