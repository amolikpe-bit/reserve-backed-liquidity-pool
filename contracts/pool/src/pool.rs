//! Quote math, the reserve views, the sync chain and the swap fill.
//!
//! The quote is the origin formula, unchanged: the fee is taken from the input
//! side and stays in the pool, so a swap moves
//! `out = amount_in * (BPS - fee) * reserve_out / (reserve_in * BPS + amount_in * (BPS - fee))`.
//!
//! All intermediates run in `U256`. At a 1_000-token scale the products
//! (`amount_in * reserve_out`, `amount * supply`, `reserve * shares` and the
//! square-root input) sit around 1e42, far above `u128::MAX`; only the final
//! result is narrowed back to `u128`.
//!
//! Reserves are a cache of the pool's real balances minus every credited-but-not-
//! added deposit. The cache only moves through the sync chain, which reads
//! `ft_index` and `ft_balance_of` from both tokens in sequence:
//!
//! ```text
//! ft_index(a) -> ft_balance_of(a) -> ft_index(b) -> ft_balance_of(b)
//! ```
//!
//! Each read lands in a `#[private]` callback that stores its value and starts the
//! next hop, and the last one stores `reserve_b`, emits `ReservesSynced` and — only
//! for a chain the caller tagged `allow_fill` — dispatches the single pending flow.
//! A permissionless `sync_reserves` runs the same chain untagged, so it can refresh
//! the cache but can never settle another account's swap, add or withdrawal.
//!
//! Gas: the external views reserve [`GAS_FOR_TOKEN_VIEW`] each and every chain
//! callback inherits the rest of the report's gas (weight 1, no static gas), so the
//! whole chain is one gas pool that ends in a self-call reserved at
//! [`GAS_FOR_FILL`] or [`GAS_FOR_SETTLE`]. A receipt that cannot fund that last
//! call refunds the flow instead of leaving a slot no later call would drain.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, Promise, PromiseError, PromiseOrValue};
use primitive_types::U256;

use crate::events::PoolEvent;
use crate::{
    resolve_index, shares, Contract, ContractExt, GAS_DISPATCH_HEADROOM, GAS_FOR_FILL,
    GAS_FOR_ON_BALANCE_A, GAS_FOR_ON_BALANCE_B, GAS_FOR_ON_INDEX_A, GAS_FOR_ON_INDEX_B,
    GAS_FOR_SETTLE, GAS_FOR_SYNC_CALLBACK, GAS_FOR_TOKEN_VIEW, BPS,
};

/// Narrow a `U256` to `u128`, panicking with a named error instead of truncating.
///
/// # Panics
/// `MathOverflow` if the value does not fit in `u128`.
pub(crate) fn narrow(value: U256) -> u128 {
    if value > U256::from(u128::MAX) {
        env::panic_str("MathOverflow");
    }
    value.as_u128()
}

/// Quote an exact-input swap against `r_in` / `r_out` with a `fee_bps` input fee.
///
/// Total, not partial: an empty reserve side and a zero input have no price and
/// quote zero, which is what lets `fill_swap` turn "no price yet" into a refund
/// instead of a panic. `quote_from` layers the view's documented `NoReserves`
/// panic on top.
pub(crate) fn quote_from_with_fee(
    r_in: u128,
    r_out: u128,
    amount_in: u128,
    fee_bps: u32,
) -> u128 {
    if r_in == 0 || r_out == 0 || amount_in == 0 {
        return 0;
    }

    let after_fee = U256::from(amount_in) * U256::from(BPS - fee_bps as u128);
    let numerator = after_fee * U256::from(r_out);
    let denominator = U256::from(r_in) * U256::from(BPS) + after_fee;

    narrow(numerator / denominator)
}

impl Contract {
    /// Quote an exact-input swap against the supplied reserves.
    ///
    /// The reserve check comes first: a pool with an empty side has no price, even
    /// for a zero input. After that, a zero input quotes zero.
    ///
    /// # Panics
    /// - `NoReserves` if either reserve is zero.
    /// - `MathOverflow` if the result does not fit in `u128`.
    pub(crate) fn quote_from(&self, r_in: u128, r_out: u128, amount_in: u128) -> u128 {
        if r_in == 0 || r_out == 0 {
            env::panic_str("NoReserves");
        }
        quote_from_with_fee(r_in, r_out, amount_in, self.swap_fee_bps)
    }
}

#[near]
impl Contract {
    /// Cached tradeable reserves, as `(reserve_a, reserve_b)`.
    ///
    /// The cache is refreshed by `sync_reserves` and by every swap before it
    /// quotes, so a rebase is not priced until one of those runs. Call
    /// `sync_reserves` first when the value must be current.
    pub fn get_reserves(&self) -> (U128, U128) {
        (U128(self.reserve_a), U128(self.reserve_b))
    }

    /// Quote the output of an exact-input swap of `amount_in` of `token_in`.
    ///
    /// # Panics
    /// - `UnknownToken` if `token_in` is not one of the two pair tokens.
    /// - `NoReserves` if either cached reserve is zero.
    pub fn get_quote(&self, token_in: AccountId, amount_in: U128) -> U128 {
        let (r_in, r_out) = if token_in == self.token_a {
            (self.reserve_a, self.reserve_b)
        } else if token_in == self.token_b {
            (self.reserve_b, self.reserve_a)
        } else {
            env::panic_str("UnknownToken")
        };

        U128(self.quote_from(r_in, r_out, amount_in.0))
    }
}

#[near]
impl Contract {
    /// Refresh the cached tradeable reserves from both tokens' live balances.
    ///
    /// Permissionless: anyone may pay for the sync, and nobody's slot is settled by
    /// it — the chain is tagged `allow_fill = false`.
    pub fn sync_reserves(&mut self) -> Promise {
        self.index_hop_a(false)
    }

    /// Store `token_a`'s index and read its balance.
    ///
    /// A token whose view fails or reports zero is treated as unscaled (`ONE`) and
    /// the reason is only logged: a callback must not panic on a failed read,
    /// because the panic would abandon the slot this chain is settling.
    #[private]
    pub fn on_index_a(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        allow_fill: bool,
    ) -> Promise {
        self.index_a = resolve_index(r, "token_a index");
        self.balance_hop_a(allow_fill)
    }

    /// Store `token_b`'s index and read its balance.
    #[private]
    pub fn on_index_b(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        allow_fill: bool,
    ) -> Promise {
        self.index_b = resolve_index(r, "token_b index");
        self.balance_hop_b(allow_fill)
    }

    /// Store `token_a`'s tradeable reserve and start the `token_b` half.
    ///
    /// `Ok` stores `balance - credits` (saturating, because a balance below the
    /// outstanding credits means the credits were withdrawn while this chain ran,
    /// and the next sync is the truth). `Err` leaves the cache alone and, for a
    /// tagged chain, refunds the flow that was waiting on it.
    #[private]
    pub fn on_balance_a(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        allow_fill: bool,
    ) -> PromiseOrValue<U128> {
        match r {
            Ok(balance) => {
                self.reserve_a = balance.0.saturating_sub(shares::credit_nominal(
                    self.total_credit_shares_a,
                    self.index_a,
                ));
                PromiseOrValue::Promise(self.index_hop_b(allow_fill))
            }
            Err(err) => {
                env::log_str(&format!("token_a balance unavailable: {err:?}"));
                if allow_fill {
                    self.abort_pending();
                }
                PromiseOrValue::Value(U128(0))
            }
        }
    }

    /// Store `token_b`'s tradeable reserve, report the sync, and settle one flow.
    ///
    /// The flow is dispatched only for a tagged chain and only when no swap payout
    /// is already outstanding, so a second sync cannot pay the same swap twice.
    /// Both outcomes return `U128(0)`: the receiver chain of `ft_on_transfer` must
    /// never resolve to a value the FT would read as an unused amount.
    #[private]
    pub fn on_balance_b(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        allow_fill: bool,
    ) -> U128 {
        match r {
            Ok(balance) => {
                self.reserve_b = balance.0.saturating_sub(shares::credit_nominal(
                    self.total_credit_shares_b,
                    self.index_b,
                ));
                PoolEvent::ReservesSynced {
                    reserve_a: U128(self.reserve_a),
                    reserve_b: U128(self.reserve_b),
                    index_a: U128(self.index_a),
                    index_b: U128(self.index_b),
                }
                .emit();

                if allow_fill && !self.fill_in_flight {
                    self.dispatch_pending();
                }
            }
            Err(err) => {
                env::log_str(&format!("token_b balance unavailable: {err:?}"));
                if allow_fill {
                    self.abort_pending();
                }
            }
        }

        U128(0)
    }
}

#[near]
impl Contract {
    /// Fill the swap that a tagged sync was started for.
    ///
    /// Quotes from the freshly synced reserves minus the input that has already
    /// landed, pays the output, and clears the slot before anything else can run
    /// (`take` at the top). Every path — filled or refunded — returns `U128(0)`,
    /// because the FT's resolver refunds the whole `amount` for a result it cannot
    /// read as a `U128`: a non-zero value here would refund a swap twice.
    #[private]
    pub fn fill_swap(&mut self) -> U128 {
        let Some(pending) = self.pending_swap.take() else {
            return U128(0);
        };
        self.fill_in_flight = true;

        let token_out = self.other_token(&pending.token_in);
        let reserve_in = self.reserve_of(&pending.token_in);
        let reserve_out = self.reserve_of(&token_out);

        let Some(reserve_in_before) = reserve_in.checked_sub(pending.amount) else {
            // The measured reserve does not even cover the landed input, so there
            // is no pre-swap reserve to price against: refund as it stands.
            self.reject_swap(&pending, false);
            return U128(0);
        };

        let out = quote_from_with_fee(
            reserve_in_before,
            reserve_out,
            pending.amount,
            self.swap_fee_bps,
        );
        if out == 0 || out < pending.min_out || out > reserve_out {
            // No price, worse than the caller's floor, or more than the pool holds:
            // a zero payout would also panic the reference FT.
            self.reject_swap(&pending, true);
            return U128(0);
        }

        self.set_reserve(&token_out, reserve_out - out);
        crate::token_transfer(&token_out, &pending.sender_id, out)
            .then(
                Contract::ext_self()
                    .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                    .output_callback(
                        pending.sender_id.clone(),
                        pending.token_in.clone(),
                        U128(pending.amount),
                        U128(out),
                    ),
            )
            .detach();

        U128(0)
    }

    /// Close a swap: report the fill, or restore the pool and return the input.
    ///
    /// Only the `fill_in_flight` flag this call owns is cleared, so a late or
    /// duplicated callback cannot unlock a second fill. The input refund is funded
    /// from this callback's own budget only when `refund` can cover the whole
    /// transfer promise; with the callback's fixed budget it otherwise becomes a
    /// payout debt, because reverting here would leave the flag set for good.
    #[private]
    pub fn output_callback(
        &mut self,
        #[callback_result] r: Result<(), PromiseError>,
        sender: AccountId,
        token_in: AccountId,
        amount_in: U128,
        amount_out: U128,
    ) {
        self.fill_in_flight = false;
        match r {
            Ok(()) => PoolEvent::Swap {
                sender,
                token_in,
                amount_in,
                amount_out_gross: amount_out,
            }
            .emit(),
            Err(err) => {
                env::log_str(&format!("swap payout failed: {err:?}"));
                // The output never left the pool, so it is tradeable again. The
                // input is refunded when this receipt can still budget the
                // transfer, and otherwise becomes a payout debt: this callback's
                // budget is too small to reserve a transfer and its callback
                // safely, and reverting here would leave `fill_in_flight` set.
                // The refund chained from `refund` is `owed_restore_callback`, so
                // a token that refuses the refund too records the input in `owed`
                // and restores its reserve there: neither leg is lost, no panic.
                let token_out = self.other_token(&token_in);
                self.add_reserve(&token_out, amount_out.0);
                if self.refund(&token_in, &sender, amount_in.0) {
                    self.sub_reserve(&token_in, amount_in.0);
                }
            }
        }
    }
}

impl Contract {
    /// `ft_index` hop of the sync chain for `token_a`.
    ///
    /// The view reserves static gas; the callback gets its own fixed budget, large
    /// enough to reserve the next view plus the next callback.
    pub(crate) fn index_hop_a(&self, allow_fill: bool) -> Promise {
        crate::ext_ft::ext(self.token_a.clone())
            .with_static_gas(GAS_FOR_TOKEN_VIEW)
            .ft_index()
            .then(
                Contract::ext_self()
                    .with_static_gas(GAS_FOR_ON_INDEX_A)
                    .on_index_a(allow_fill),
            )
    }

    /// `ft_index` hop of the sync chain for `token_b`.
    fn index_hop_b(&self, allow_fill: bool) -> Promise {
        crate::ext_ft::ext(self.token_b.clone())
            .with_static_gas(GAS_FOR_TOKEN_VIEW)
            .ft_index()
            .then(
                Contract::ext_self()
                    .with_static_gas(GAS_FOR_ON_INDEX_B)
                    .on_index_b(allow_fill),
            )
    }

    /// `ft_balance_of` hop of the sync chain for `token_a`.
    fn balance_hop_a(&self, allow_fill: bool) -> Promise {
        crate::ext_ft::ext(self.token_a.clone())
            .with_static_gas(GAS_FOR_TOKEN_VIEW)
            .ft_balance_of(env::current_account_id())
            .then(
                Contract::ext_self()
                    .with_static_gas(GAS_FOR_ON_BALANCE_A)
                    .on_balance_a(allow_fill),
            )
    }

    /// `ft_balance_of` hop of the sync chain for `token_b`.
    fn balance_hop_b(&self, allow_fill: bool) -> Promise {
        crate::ext_ft::ext(self.token_b.clone())
            .with_static_gas(GAS_FOR_TOKEN_VIEW)
            .ft_balance_of(env::current_account_id())
            .then(
                Contract::ext_self()
                    .with_static_gas(GAS_FOR_ON_BALANCE_B)
                    .on_balance_b(allow_fill),
            )
    }

    /// Schedule the single pending flow after a tagged sync, at most one.
    ///
    /// Priority is swap, then add, then withdrawal: a swap has already taken the
    /// sender's tokens, so it is the only slot whose delay moves value. The
    /// dispatch is a self-call with its own static gas; when this receipt cannot
    /// fund it (a third-party token may forward less gas than the chain reserves),
    /// the flow is refunded rather than left in a slot no later call would drain.
    fn dispatch_pending(&mut self) {
        let needed = if self.pending_swap.is_some() || self.pending_add_liquidity.is_some() {
            GAS_FOR_FILL
        } else if self.pending_withdraw.is_some() {
            GAS_FOR_SETTLE
        } else {
            return;
        };

        if !can_fund(needed) {
            env::log_str("pending flow refunded: this report cannot fund its settlement");
            self.abort_pending();
            return;
        }

        if self.pending_swap.is_some() {
            Contract::ext_self()
                .with_static_gas(GAS_FOR_FILL)
                .fill_swap()
                .detach();
        } else if self.pending_add_liquidity.is_some() {
            Contract::ext_self()
                .with_static_gas(GAS_FOR_FILL)
                .mint_shares()
                .detach();
        } else if self.pending_withdraw.is_some() {
            Contract::ext_self()
                .with_static_gas(GAS_FOR_SETTLE)
                .settle_withdraw()
                .detach();
        }
    }

    /// Refund whatever a tagged chain accepted but can no longer settle, and clear
    /// every slot.
    ///
    /// The swap's landed input is treated as counted by the cache: the chain may
    /// have measured that side, and dropping it can only understate the reserve —
    /// the direction that cannot overpay. Every fill re-syncs before it quotes, so
    /// the next sync restores the true value.
    ///
    /// A pending add and a pending withdrawal hold no funds yet — credits were never
    /// debited and shares were never burned — so those slots are dropped, and the add
    /// is reported so its caller sees why nothing was minted.
    fn abort_pending(&mut self) {
        if let Some(pending) = self.pending_swap.take() {
            self.refund_swap_input(&pending, true);
        }
        if let Some(add) = self.pending_add_liquidity.take() {
            PoolEvent::AddLiquidityFailed {
                account_id: add.owner_id,
                reason: "SyncFailed".to_string(),
            }
            .emit();
        }
        self.pending_withdraw = None;
    }

    /// Send a taken swap's input back to its sender.
    ///
    /// `input_counted` says whether the cached reserve of the input token may
    /// already contain the landed input; when the refund actually leaves the pool,
    /// the cache drops it again so it does not overstate tradeable liquidity. A
    /// refund that becomes a payout debt keeps the tokens, and `claim_owed` deducts
    /// them then.
    fn refund_swap_input(&mut self, pending: &crate::PendingSwap, input_counted: bool) {
        if self.refund(&pending.token_in, &pending.sender_id, pending.amount) && input_counted {
            self.sub_reserve(&pending.token_in, pending.amount);
        }
    }

    /// Refund a taken swap and clear the in-flight flag.
    ///
    /// Both rejection paths in `fill_swap` come through here, so a swap that
    /// never pays out cannot leave `fill_in_flight` set. The input only leaves the
    /// cached reserve when the refund transfer was actually created.
    fn reject_swap(&mut self, pending: &crate::PendingSwap, input_counted: bool) {
        self.refund_swap_input(pending, input_counted);
        self.fill_in_flight = false;
    }
}

/// Whether this receipt can fund a `needed`-gas self-call and still create it.
///
/// The dispatch only happens when the settlement's static budget fits inside what
/// this receipt has left, plus [`GAS_DISPATCH_HEADROOM`] for the state write and the
/// promise batch it still owes.
fn can_fund(needed: Gas) -> bool {
    crate::remaining_gas() > needed.as_gas().saturating_add(GAS_DISPATCH_HEADROOM.as_gas())
}
