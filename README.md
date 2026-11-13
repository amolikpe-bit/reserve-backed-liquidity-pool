# krater

**A NEAR pool whose reserves are the real NEP-141 balances it holds.** A rebase, a
dividend or a taxed transfer changes what the pool is worth, and the share holders
own that change without an accounting step. No owner, no pause, no upgrade path.

- Contract: [`contracts/pool`](contracts/pool) (Rust, near-sdk 5.30.1)
- Manifest: [`manifest.json`](manifest.json)
- Licence: Apache-2.0

## What it is

The pool holds both tokens of a pair on its own account. The balance is the
reserve. There is no wrapper, no claim token and no cached price to reconcile:

- A **rebasing** token that gains supply raises the pool's balance directly, so
  the next settlement quotes a larger reserve and every LP share is worth more.
- A **fee-on-transfer** token is priced from what actually arrived, because
  settlement reads the amount the token reports, not the amount the sender typed.
- A **dividend or airdrop** to the pool account is the same event as a rebase:
  it lands in the reserve and belongs to the shares.

The pool is a constant-product curve with the fee taken from the input side and
left in the reserve. Reserves are cached for views and refreshed by a
permissionless sync chain; settlement always syncs first, so a trade is never
decided from stale numbers.

## The primitive: NEP-141

LP shares are NEP-141 on the pool account itself, not a bespoke ledger. The
`FungibleToken` derive supplies `ft_transfer`, `ft_transfer_call`,
`ft_total_supply`, `ft_balance_of`, `ft_metadata`, `ft_resolve_transfer` and the
NEP-145 storage methods. Settlement enters through the same standard: a holder
calls `ft_transfer_call` on a pair token, the token calls `ft_on_transfer` on the
pool, and the pool quotes from the amount that call reports. `ft_transfer_call`
with an empty message credits a deposit balance; `add_liquidity` spends those
credits. Everything the pool emits is NEP-297 JSON, standard `krater`.

## Quickstart

Requirements: Rust 1.95 or newer (edition 2024), cargo-near 0.23.0,
near-cli-rs 0.31.1, wasm-opt (binaryen), Node 22.22.2 or newer, pnpm 10.4.1 or newer.

```bash
git clone https://github.com/nirholas/near-krater && cd near-krater && cargo near build non-reproducible-wasm && node scripts/demo.js
```

`scripts/demo.js` starts a near-sandbox chain, deploys both contracts, creates
zero-balance accounts, and runs deposit -> add liquidity -> quote -> swap ->
rebase -> sync -> withdraw. It needs no keys and no funds.

Registration is explicit: a NEP-141 transfer never registers its receiver, so the
script calls `storage_deposit` on both tokens and on the pool before it moves a
balance.

`non-reproducible-wasm` is the local build: it compiles without Docker. The
default reproducible variant runs Docker against committed source (and needs it
pushed to deploy), and is used only for a pinned-image release, which the
quickstart does not cover.

`scripts/deploy.sh` builds both crates, then runs
`scripts/optimize-wasm.sh` on the exact artifact it deploys. The script applies
`wasm-opt -Oz --converge` with cargo-near's wasm feature set after its built-in
`-O` pass; the measured pool wasm drops from 305,436 to 300,324 bytes (−1.67%).

To run against a live network, set `RPC_URL` (and the account/key variables listed
in the script header) instead; `scripts/deploy.sh` creates the accounts, deploys,
initialises and registers them, and then locks the pool account.

## Executable spec

Every claim below is a command that starts a zero-funds sandbox, deploys both
contracts, and asserts the observable:

| Behaviour | Command |
|---|---|
| deposit credits -> add liquidity -> quote -> swap -> rebase + sync -> withdraw | `node scripts/demo.js` |
| gas for each settlement path and the +10% rebase quote delta | `node scripts/measure.js` |
| refund/owed path, `claim_owed`, `withdraw_deposit`, taxed legs, seeded fuzz | `node --test --test-concurrency=1 tests/pool.test.js` |
| compile, unit tests, wasm build | `cargo check --workspace --target wasm32-unknown-unknown && cargo test -p krater-pool` |

`scripts/demo.js` prints the reserves before/after the swap and the rebase, the
shares minted/burned, the quote delta in bps, and the `Swap` event count; it exits
non-zero if any of those did not move. `tests/pool.test.js` runs the refund and
claim legs against a receiver that is not registered for the payout token.

## Reproduce the numbers

```bash
node scripts/measure.js
```

**Headline (sandbox, one run): a +10% rebase on one reserve raises the same
`get_quote` by 9.99%** — 9.920546077802156251e18 → 1.0912600685582371876e19
base units. `scripts/measure.js` writes `bench.json` and prints that delta plus
the measured gas for each settlement path:

| Path | Measured |
|---|---|
| `add_liquidity` | 21.518 Tgas |
| `sync_reserves` | 17.395 Tgas |
| `withdraw` | 28.819 Tgas |
| `swap` | 28.257 Tgas |
| `withdraw_deposit` | 10.422 Tgas |
| `claim_owed` | 6.521 Tgas |

Gas is the transaction's own `gas_burnt` plus the `gas_burnt` of every receipt it
produced. The sandbox path needs no keys and no funds; a live run needs the
fixture accounts and two funded keys, as documented at the top of the script.
Re-running the command reproduces the table (the delta is deterministic; gas can
vary by a few percent with the node's schedule).

## Gas and limits

Gas is static, so a caller can budget it exactly. The pool attaches 90, 80, 70 and
60 Tgas to the four sync callbacks, 25 Tgas to the fill and 45 Tgas to the
settlement, 8 Tgas to each terminal callback and 5 Tgas to each token view; every
`ft_transfer` it makes carries 10 Tgas plus the one yoctoNEAR NEP-141 requires.
The client funds that chain from the outside:

- 200 Tgas per `ft_transfer_call` (credit a deposit, or swap)
- 300 Tgas for `add_liquidity` and for `withdraw`
- 100 Tgas for `sync_reserves`
- 60–100 Tgas for `claim_owed` and `withdraw_deposit`

A function call may attach up to 1000 Tgas and a transaction up to 1 PGas, so the
`300 Tgas` that `scripts/deploy.sh` passes to `new` is a near-cli-rs value inside
that envelope, not a protocol ceiling. `scripts/demo.js` and `scripts/measure.js`
attach the budgets above, and `measure.js` refuses to report a path that reverted
or that burnt more gas than it attached.

## Where it does not help

Holding real tokens costs more per settlement than an accounting-only design, and
that is the trade: it is the right one for exactly the tokens the cheaper design
cannot serve.

- Exact-output swaps are refused by construction rather than approximated. A token
  that taxes its own transfers cannot deliver an exact amount, so promising one
  would be a promise the pool could not keep.
- A direct transfer to the pool is a donation to every share. That is harmless,
  but it is a way to move share value without a deposit.
- A token that can freeze or seize balances can do so here, exactly as it can
  anywhere else it is held.
- Only the pool's own two tokens are absorbed. An airdrop of a third token sits on
  the account with no way to reach anybody.
- `get_quote` reads the reserve cache. It is a view of the last sync, not a live
  read; settlement syncs first.

### NEAR deltas

- **Cached-reserve sync window.** A rebase that lands between two syncs is priced
  at the next settlement or at the next permissionless `sync_reserves`, not
  instantly. Every swap, liquidity add and withdrawal runs its own sync chain
  first, so the window is the receipt-to-fill gap of one transaction, and a sync
  started before a swap can never fill it.
- **Taxed input is not a caller problem.** There is no router that has to over-send:
  `ft_transfer_call` reports the net amount the pool received, and the pool quotes
  from that.
- **Gross, not net, swap events.** `PoolEvent::Swap.amount_out_gross` is what the
  pool sent. If the output token taxes the payout, the trader receives less, and
  the event does not pretend otherwise.
- **Credited deposits are not reserves.** Balances credited by a deposit but not
  yet spent by `add_liquidity` are subtracted from the tradeable reserves, so a
  swapper cannot spend another account's credit. They stay withdrawable through
  `withdraw_deposit`.

## The pool account is locked

`scripts/deploy.sh` deletes every access key on the pool account after
deployment and verifies that none remain. The contract has no method that adds a
key, no owner, no pause and no upgrade path, so after that transaction only the
contract's own logic can move funds. Record the key-deletion transaction when a
deployment is made; it is the evidence for the claim.

## Test-only fixtures

`contracts/mock-ft` is a fixture, not a token to deploy for value. One binary
provides both behaviours the pool is built for: an index that `rebase(factor_bps)`
moves, and a transfer fee that `set_fee(bps)` sets. Both mutators are
unauthenticated and `mint` is free, because a test has to be able to fund an exact
balance and change the index mid-run. It exposes balances, supply, metadata, the
index and the mutators, so a test can read the same numbers the pool reads.

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

krater is a NEAR port of [`nirholas/rebase-absorb`](https://github.com/nirholas/rebase-absorb)
(Apache-2.0, HEAD `c1665553`), rewritten from Solidity into Rust and NEP-141. The
origin's LICENSE and NOTICE are retained verbatim; see
[`ATTRIBUTION.md`](ATTRIBUTION.md) for the change summary and the dependency
licence table. The pool keeps the origin's commitments: no owner, no pause, no
upgrade, and behaviour that treats the tokens' own mechanics as the source of
truth.
