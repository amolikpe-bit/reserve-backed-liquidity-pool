# Attribution

## Origin

- Repository: <https://github.com/nirholas/rebase-absorb>
- Licence: Apache-2.0
- Baseline: `main` at `c1665553` (last commit 2026-10-10)
- Retained verbatim: `LICENSE` and `NOTICE` from that baseline

krater is a port of the origin's single-pool design from Solidity to Rust and NEP-141. The mechanism is the same. The pool holds the pair tokens itself. The balance is the reserve. Settlement measures what arrived. There is no owner, pause or upgrade path. The implementation is not a translation of the origin's files; it is a rewrite against NEAR's call model.

## Changes made

- **Language and runtime.** Solidity contracts and their build system replaced by a Cargo workspace with `krater-pool` (near-sdk 5.30.1) and a test-only `krater-mock-ft` fixture.
- **LP shares.** An ERC-20 inheritance replaced by NEP-141 on the pool account, produced by `FungibleToken` from near-sdk-contract-tools 4.0.0 (used under Apache-2.0), including NEP-145 registration and NEP-148 metadata at 18 decimals.
- **Reserves.** A live balance read replaced by a cached tradeable reserve plus a permissionless sync chain, because NEAR reads are asynchronous. Settlement syncs before it quotes; `get_quote` reads the cache.
- **Settlement.** An approval-and-pull path replaced by `ft_transfer_call` and `ft_on_transfer`, with the received amount supplied by the token. Swaps, liquidity adds and withdrawals run a sync chain and a private settlement callback.
- **Deposits.** Atomic two-leg pulls replaced by per-token deposit credits (the Ref Finance pattern), an explicit `add_liquidity`, and `withdraw_deposit` for unused credits. Credits are index-scaled shares excluded from tradeable reserves.
- **Claims and sweeping.** The origin's claim-token model and its sweep are deleted; NEAR has no shared pool singleton, so the pool account is the only holder.
- **Errors.** Solidity selectors replaced by named panic strings with the same names where the condition survives (`InvalidFee`, `NoReserves`, `AmountTooSmall`, `InsufficientInitialLiquidity`), plus NEAR-specific ones (`InvalidPair`, `UnknownToken`, `Busy`, `InvalidIndex`, `MathOverflow`).
- **Events.** Solidity events replaced by NEP-297 JSON events under the `krater` standard, with `CreditAdded`, `CreditSpent`, `CreditWithdrawn` and `ReservesSynced` added for state that is not otherwise enumerable.
- **Math.** Fixed-point library usage replaced by `primitive-types` 0.14.0 `U256` intermediates and `U256::integer_sqrt()`, narrowed back to `u128` once.
- **Tooling, tests and client.** The origin's contract build scripts, submodule dependencies, static site, integration documents and chain tables are removed. Deployment is `cargo-near` plus `near-cli-rs`; the demo and the measurements are Node scripts on a near-sandbox chain or a live RPC; integration tests use near-kit's sandbox handle.
- **Manifest.** The origin's machine-readable catalogue entry is rewritten for NEAR: the contract name, chain list, source path, repository, and a limitation section that describes this port's boundaries. The EVM-only blocks (ABI, permissions, error selectors, configuration) are removed.

The origin's `NOTICE` is kept unchanged as provenance. It records the third-party components of the origin's own build. Those components are not part of this repository. Nothing here is relicensed by that notice.

## Dependency licences

| Component | Version | Licence |
| --- | --- | --- |
| near-sdk | 5.30.1 | Apache-2.0 |
| near-sdk-contract-tools | 4.0.0 | GPL-3.0 OR Apache-2.0 — used under Apache-2.0 |
| near-contract-standards | 5.30.1 | Apache-2.0 |
| primitive-types | 0.14.0 | MIT OR Apache-2.0 |
| near-api-js | 7.5.3 | MIT OR Apache-2.0 |
| near-kit | 0.20.2 | see upstream |
| near-sandbox | 0.3.5 | see upstream |
| Node.js | 22.22.2 | see upstream |
| pnpm | 10.4.1 | see upstream |

The Rust dependencies are pinned in the workspace `Cargo.toml`; the JavaScript dependencies are pinned in `package.json`.
