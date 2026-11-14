# Attribution
## Origin
Repository: <https://github.com/nirholas/rebase-absorb> | Licence: Apache-2.0 | Baseline: `main` at `c1665553` (last commit 2026-10-10)
Retained verbatim: `LICENSE`. `NOTICE` keeps the upstream third-party list, and its header now names the origin above.

krater ports the single-pool design from Solidity to Rust and NEP-141. The pool holds both pair tokens as its reserves. Settlement measures the arrived balance. There is no owner, pause, or upgrade path.
## Changes made
- Language and runtime: a Cargo workspace with `krater-pool` (near-sdk 5.30.2) and test-only `krater-mock-ft` replaces Solidity.
- LP shares: `FungibleToken` (near-sdk-contract-tools 4.0.0, Apache-2.0) replaces ERC-20 with NEP-141 shares. It adds NEP-145 registration and NEP-148 18-decimal metadata.
- Reserves: cached tradeable reserves and a permissionless sync chain replace live reads. Settlement syncs before `get_quote`.
- Settlement: `ft_transfer_call` and `ft_on_transfer` replace approval-and-pull. Swaps, adds, and withdrawals run a sync chain and private callback.
- Deposits: per-token credits (Ref Finance pattern) replace atomic pulls. Explicit `add_liquidity` and `withdraw_deposit` use index-scaled shares excluded from reserves.
- Claims and sweeping: the claim-token model and sweep are deleted. Each pool account holds its own reserves.
- Errors: named panics replace Solidity selectors (`InvalidFee`, `NoReserves`, `AmountTooSmall`, `InsufficientInitialLiquidity`). NEAR adds `InvalidPair`, `UnknownToken`, `Busy`, `InvalidIndex`, `MathOverflow`.
- Events: NEP-297 JSON events under `krater` replace Solidity events. Added `CreditAdded`, `CreditSpent`, `CreditWithdrawn`, and `ReservesSynced`.
- Math: `primitive-types` 0.14.0 `U256` and `U256::integer_sqrt()` replace the fixed-point library. Results narrow to `u128` once.
- Tooling, tests and client: build scripts, submodules, docs, and chain tables are deleted. `cargo-near`, `near-cli-rs`, and Node scripts drive near-sandbox or RPC.
- Manifest: the NEAR entry keeps contract name, chains, path, repository, and boundaries. EVM ABI, selectors, and configuration are deleted.

`NOTICE` records only the origin build components. Nothing here is relicensed by that notice.
## Dependency licences
near-sdk 5.30.2 and near-contract-standards 5.30.2 are MIT OR Apache-2.0, used under Apache-2.0. near-sdk-contract-tools 4.0.0 is GPL-3.0 OR Apache-2.0, used under Apache-2.0.
primitive-types 0.14.0 is MIT OR Apache-2.0; near-api-js 7.5.3 is MIT AND Apache-2.0. near-sandbox 0.3.5, Node.js 26.13.1, and pnpm 12.18.0 follow their upstream licences.
The Rust dependencies are pinned in `Cargo.toml`, and the JavaScript dependencies are pinned in `package.json`.
