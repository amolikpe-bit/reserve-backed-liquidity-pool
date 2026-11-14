# krater
**A NEAR pool whose reserves are the real NEP-141 balances it holds.** Rebase, dividend, or taxed-transfer changes belong to holders. No owner, pause, or upgrade path exists.

- Contract: [`contracts/pool`](contracts/pool) (Rust, near-sdk 5.30.2) | Manifest: [`manifest.json`](manifest.json) | Licence: Apache-2.0

## What it is
The pool holds both pair tokens on its own account. The balance is the reserve. No wrapper, claim token, or cached price reconciliation is needed:
- A **rebasing** token supply gain raises the pool balance. The next settlement quotes a larger reserve, raising every LP share value.
- A **fee-on-transfer** token is priced from what arrived. Settlement reads the token-reported amount rather than the sent amount.
- A **dividend or airdrop** lands directly in the reserve. It belongs to the shares like a rebase.

The pool uses a constant-product curve with input-side fees. Reserves are cached for views and refreshed by a permissionless sync chain. Settlement always syncs before trading.

## The primitive: NEP-141
LP shares are NEP-141 on the pool account itself. The `FungibleToken` derive provides `ft_transfer`, `ft_transfer_call`, `ft_total_supply`, `ft_balance_of`, `ft_metadata`, `ft_resolve_transfer`, and NEP-145 storage methods.

Settlement enters through the same NEP-141 standard:
- A holder calls `ft_transfer_call` on a pair token.
- The token calls `ft_on_transfer` on the pool.
- The pool quotes from the reported net amount.

An empty `ft_transfer_call` message credits a deposit balance, which `add_liquidity` spends. Every event is NEP-297 JSON under `krater`.

## Quickstart
Requirements: Rust 1.100.0+, edition 2024, cargo-near 0.23.0, near-cli-rs 0.31.1, wasm-opt (binaryen), Node 26.13.1+, pnpm 12.18.0+.
```bash
git clone https://github.com/nirholas/near-krater && cd near-krater && cargo near build non-reproducible-wasm && node scripts/demo.js
```
`scripts/demo.js` starts a near-sandbox chain, deploys both contracts, creates zero-balance accounts, and runs the full flow. It needs no keys or funds. Call `storage_deposit` on both tokens and the pool before transferring balances, because NEP-141 never registers receivers automatically.

`non-reproducible-wasm` builds locally without Docker; reproducible Docker releases need pushed source. `scripts/deploy.sh` builds both crates and runs `scripts/optimize-wasm.sh` (`wasm-opt -Oz --converge` with cargo-near features, sign-extension, element reordering, instruction optimization, and RSE after `-O`). The release profile cuts pool wasm from 275,053 to 269,972 bytes (−1.85%). Set `RPC_URL` and header variables for live networks; `scripts/deploy.sh` creates, deploys, initializes, registers, and locks the pool account.

## Executable spec
Every command starts a zero-funds sandbox, deploys both contracts, and verifies the observable:
| Behaviour | Command |
|---|---|
| deposit credits -> add liquidity -> quote -> swap -> rebase + sync -> withdraw | `node scripts/demo.js` |
| gas for each settlement path and the +10% rebase quote delta | `node scripts/measure.js` |
| refund/owed path, `claim_owed`, `withdraw_deposit`, taxed legs, seeded fuzz | `node --test --test-concurrency=1 tests/pool.test.js` |
| compile, unit tests, wasm build | `cargo check --workspace --target wasm32-unknown-unknown && cargo test -p krater-pool` |

`scripts/demo.js` prints reserves, minted/burned shares, quote delta in bps, and `Swap` count, exiting non-zero on failure. `tests/pool.test.js` also tests refund and claim paths for unregistered payout receivers.

## Reproduce the numbers
```bash
node scripts/measure.js
```
**Headline (sandbox, one run): a +10% rebase raises `get_quote` by 9.99%** — 9.920546077802156251e18 → 1.0912600685582371876e19 base units. `scripts/measure.js` writes `bench.json` and prints each settlement path's gas:
| Path | Measured |
|---|---|
| `add_liquidity` | 21.397 Tgas |
| `sync_reserves` | 17.250 Tgas |
| `withdraw` | 28.635 Tgas |
| `swap` | 28.110 Tgas |
| `withdraw_deposit` | 10.356 Tgas |
| `claim_owed` | 6.478 Tgas |

Gas sums transaction `gas_burnt` and all receipt `gas_burnt`. Sandbox runs need no keys or funds; live runs require fixture accounts and two funded keys. The quote delta is deterministic; gas varies slightly across node schedules.

## Gas and limits
Static gas makes client budgeting exact. The pool attaches:
- 90, 80, 70, and 60 Tgas to the four sync callbacks; 25 Tgas to fill; 45 Tgas to settle.
- 8 Tgas to terminal callbacks; 5 Tgas to token views; 10 Tgas plus one yoctoNEAR per `ft_transfer`.

The client attaches: 200 Tgas (`ft_transfer_call`), 300 Tgas (`add_liquidity`, `withdraw`), 100 Tgas (`sync_reserves`), and 60–100 Tgas (`claim_owed`, `withdraw_deposit`). Calls allow up to 1000 Tgas and transactions up to 1 PGas. `300 Tgas` in `scripts/deploy.sh` for `new` sits inside that envelope. `scripts/demo.js` and `scripts/measure.js` attach these budgets, and `measure.js` rejects reverted or over-budget paths.

## Where it does not help
Holding real tokens costs more per settlement than accounting-only designs, serving tokens that cheaper designs cannot handle:
- Exact-output swaps are refused rather than approximated, because taxed tokens cannot guarantee exact delivery.
- Direct transfers donate to all shares, changing share value without a deposit.
- Tokens that freeze or seize balances can do so here.
- Third-token airdrops cannot be recovered from the pool account.
- `get_quote` reads the last sync cache; settlement syncs first.

### NEAR deltas
- **Cached-reserve sync window.** Intermediate rebases price at the next settlement or permissionless `sync_reserves`. Every swap, add, and withdrawal syncs first within its transaction; prior syncs cannot fill later swaps.
- **Taxed input is not a caller problem.** `ft_transfer_call` reports the net received amount, so no over-sending router is needed.
- **Gross, not net, swap events.** `PoolEvent::Swap.amount_out_gross` records what the pool sent before any output token tax.
- **Credited deposits are not reserves.** Credits unspent by `add_liquidity` stay withdrawable via `withdraw_deposit` and are excluded from tradeable reserves.

## The pool account is locked
`scripts/deploy.sh` deletes all pool access keys and verifies none remain. No method adds keys, and no owner, pause, or upgrade exists. Record the key-deletion transaction as deployment evidence.

## Test-only fixtures
`contracts/mock-ft` is an unauthenticated test fixture combining `rebase(factor_bps)`, `set_fee(bps)`, and free `mint`. It exposes balances, supply, metadata, index, and mutators for deterministic tests.

## Layout
| Path | Contents |
| --- | --- |
| `contracts/pool/src/lib.rs` | contract state, `new`, metadata and credit views |
| `contracts/pool/src/pool.rs` | quote math, `get_reserves`, `get_quote` |
| `contracts/pool/src/shares.rs` | share and credit arithmetic, `MINIMUM_SHARES` |
| `contracts/pool/src/ft_receiver.rs` | `ft_transfer_call` message types |
| `contracts/pool/src/events.rs` | NEP-297 event enum |
| `contracts/mock-ft/src/lib.rs` | rebasing / fee-on-transfer fixture |
| `scripts/deploy.sh` | account setup, deploy, init, registration, key deletion |
| `scripts/demo.js` | sandbox or live end-to-end run |
| `scripts/measure.js` | gas and rebase-delta measurement, writes `bench.json` |
| `scripts/lib/harness.js` | shared sandbox/RPC client used by demo, measure and tests |
| `tests/pool.test.js` | sandbox tests for the deployed surface |
| `manifest.json` | machine-readable pool description |

## Origin and licence
krater ports [`nirholas/rebase-absorb`](https://github.com/nirholas/rebase-absorb) (Apache-2.0, HEAD `c1665553`) from Solidity to Rust and NEP-141, keeping LICENSE and NOTICE verbatim. See [`ATTRIBUTION.md`](ATTRIBUTION.md) for the change summary and dependency licences. The pool keeps no owner, no pause, and no upgrade.

## Hackathon
Track: `memecoins`. Development ends 2026-11-14T23:59:00Z (UTC).
