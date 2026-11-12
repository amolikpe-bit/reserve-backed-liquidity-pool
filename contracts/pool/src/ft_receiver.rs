//! The `ft_transfer_call` surface: swaps, deposits and credit withdrawal.
//!
//! Settlement enters the pool through NEP-141: a token holder calls
//! `ft_transfer_call` on a pair token, the token calls `ft_on_transfer` here, and
//! the pool answers with the amount it did **not** use. Parsing lives in this
//! module so the receiver and the tests agree on one shape.
//!
//! - `""` or `{"Deposit":{}}` credits the sender's balance for that token. The
//!   amount is scaled by the token's `ft_index`, read in a callback, and floored at
//!   `10^(decimals-3)` base units so an attacker-chosen credit key always pays for
//!   its own storage.
//! - `{"Swap":{"min_out":"<amount>"}}` asks for an exact-input swap: the pool
//!   stores one pending slot and starts the reserve sync tagged `allow_fill`, whose
//!   tail fills the swap.
//!
//! Anything else is rejected by returning the whole amount unused, so a caller
//! cannot make the pool hold funds it does not account for.
//!
//! `withdraw_deposit` walks the same credits back out: it converts a nominal amount
//! to credit shares at the token's current index, debits them, and restores them if
//! the payout transfer fails.

use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, near, serde_json, AccountId, Promise, PromiseError, PromiseOrValue,
};

use crate::events::PoolEvent;
use crate::{
    resolve_index, shares, Contract, ContractExt, GAS_FOR_SYNC_CALLBACK, GAS_FOR_TOKEN_VIEW,
};

/// Decimals assumed for a token whose NEP-148 metadata cannot be read.
pub const DEFAULT_DECIMALS: u8 = 18;

/// The message accepted by `ft_on_transfer`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PoolMsg {
    /// Exact-input swap: `min_out` is the least output the sender will accept.
    Swap { min_out: U128 },
    /// Credit the transferred amount to the sender, to be added later.
    Deposit {},
}

/// Parse an `ft_transfer_call` message. An empty message means `Deposit`.
///
/// Returns `None` for a malformed or unknown message; the receiver refunds the
/// transfer in that case.
pub fn parse_msg(msg: &str) -> Option<PoolMsg> {
    if msg.trim().is_empty() {
        return Some(PoolMsg::Deposit {});
    }
    serde_json::from_str(msg).ok()
}

/// NEP-148 metadata, reduced to the one field the deposit floor needs.
///
/// Unknown fields are ignored: a token may answer with the full standard record,
/// including an icon, and only `decimals` changes what the pool does.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FtMetadata {
    /// Decimal places of the token's base unit.
    pub decimals: u8,
}

/// Smallest deposit the pool credits for a token, in base units:
/// `10^(decimals - 3)`, one thousandth of a whole token and at least one base unit.
///
/// The floor bounds the storage an attacker can pin to `deposits` keys: every
/// credited `(account, token)` pair costs the pool rent, so a credit below the floor
/// is refused and the token refunds it. A token whose decimals are unknown is
/// treated as [`DEFAULT_DECIMALS`]; assuming fewer decimals would only raise the
/// floor, and assuming more would let dust through.
pub fn min_credit_deposit(decimals: Option<u8>) -> u128 {
    let decimals = decimals.unwrap_or(DEFAULT_DECIMALS);
    10u128.saturating_pow(u32::from(decimals.saturating_sub(3)))
}

#[near]
impl Contract {
    /// NEP-141 receiver: a swap or a deposit, from one of the two pair tokens.
    ///
    /// Returns the unused amount. The asynchronous paths return a promise whose
    /// tail resolves to `U128(0)` once the pool has taken the input, and the whole
    /// `amount` is returned only by the synchronous refusals — a token outside the
    /// pair, a busy pool, or a message the pool does not know. Those refusals never
    /// also transfer the tokens back: the FT's resolver does that from the returned
    /// value, and doing both would refund twice.
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_in = env::predecessor_account_id();
        if !self.is_pair_token(&token_in) {
            env::log_str(&format!(
                "refunded {} from a token outside the pair",
                amount.0
            ));
            return PromiseOrValue::Value(amount);
        }

        let Some(message) = parse_msg(&msg) else {
            env::log_str("refunded a transfer with an unknown message");
            return PromiseOrValue::Value(amount);
        };

        match message {
            PoolMsg::Swap { min_out } => {
                if amount.0 == 0 || self.is_busy() {
                    // One flow at a time: queueing would need unbounded state, and
                    // two syncs could settle the same slot twice.
                    return PromiseOrValue::Value(amount);
                }
                self.pending_swap = Some(crate::PendingSwap {
                    sender_id,
                    token_in,
                    amount: amount.0,
                    min_out: min_out.0,
                });
                // Sweep first, then fill: the chain re-reads both balances and only
                // its tail may dispatch the fill, so the quote uses the balances
                // this transfer produced, not the cache the sender saw.
                PromiseOrValue::Promise(self.index_hop_a(true))
            }
            PoolMsg::Deposit {} => {
                // The index read decides how many credit shares the amount buys, so
                // it must happen in a receipt of its own: a rebase can land between
                // the transfer and this call.
                PromiseOrValue::Promise(
                    crate::ext_ft::ext(token_in.clone())
                        .with_static_gas(GAS_FOR_TOKEN_VIEW)
                        .ft_index()
                        .then(
                            Contract::ext_self()
                                .with_unused_gas_weight(1)
                                .on_deposit_index(sender_id, token_in, amount),
                        ),
                )
            }
        }
    }

    /// Credit a deposit at the index the token just reported.
    ///
    /// With the decimals cached from an earlier deposit the credit happens here;
    /// otherwise the metadata view decides the floor first. `U128(0)` means the
    /// amount was credited and `U128(amount)` means it was refused as too small, so
    /// the FT refunds it.
    #[private]
    pub fn on_deposit_index(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        sender_id: AccountId,
        token: AccountId,
        amount: U128,
    ) -> PromiseOrValue<U128> {
        let index = resolve_index(r, "deposit token index");
        match self.decimals_of(&token) {
            Some(decimals) => PromiseOrValue::Value(U128(self.credit_deposit(
                &sender_id, &token, amount.0, index, decimals,
            ))),
            None => PromiseOrValue::Promise(
                crate::ext_ft::ext(token.clone())
                    .with_static_gas(GAS_FOR_TOKEN_VIEW)
                    .ft_metadata()
                    .then(
                        Contract::ext_self()
                            .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                            .on_deposit_metadata(sender_id, token, amount, U128(index)),
                    ),
            ),
        }
    }

    /// Credit a deposit once the token's decimals are known, and cache them.
    ///
    /// The metadata result is deliberately unbounded in size: NEP-148 allows a
    /// data-URI icon, and a token that answers with garbage can only burn this
    /// receipt's gas — the chain fails and the FT refunds the deposit.
    #[private]
    pub fn on_deposit_metadata(
        &mut self,
        #[callback_result] r: Result<FtMetadata, PromiseError>,
        sender_id: AccountId,
        token: AccountId,
        amount: U128,
        index: U128,
    ) -> U128 {
        let decimals = match r {
            Ok(metadata) => {
                self.set_decimals(&token, metadata.decimals);
                metadata.decimals
            }
            Err(err) => {
                env::log_str(&format!("ft_metadata unavailable: {err:?}"));
                // Not cached: the next deposit retries the view.
                DEFAULT_DECIMALS
            }
        };
        U128(self.credit_deposit(&sender_id, &token, amount.0, index.0, decimals))
    }

    /// Return unused credits as tokens.
    ///
    /// Exactly one yoctoNEAR. The index decides how many credit shares `amount`
    /// costs, and the debit happens in the callback receipt, in the same receipt as
    /// the payout: a failed transfer restores exactly what was debited.
    ///
    /// # Panics
    /// - `UnknownToken` if `token` is not one of the pair tokens.
    /// - `AmountTooSmall` if `amount` is zero.
    #[payable]
    pub fn withdraw_deposit(&mut self, token: AccountId, amount: U128) -> Promise {
        assert_one_yocto();
        if !self.is_pair_token(&token) {
            env::panic_str("UnknownToken");
        }
        if amount.0 == 0 {
            env::panic_str("AmountTooSmall");
        }
        let who = env::predecessor_account_id();

        crate::ext_ft::ext(token.clone())
            .with_static_gas(GAS_FOR_TOKEN_VIEW)
            .ft_index()
            .then(
                Contract::ext_self()
                    .with_unused_gas_weight(1)
                    .on_withdraw_index(who, token, amount),
            )
    }

    /// Debit the credit shares `amount` costs and pay the tokens out.
    ///
    /// # Panics
    /// `InsufficientDeposit` if the caller holds fewer credit shares than `amount`
    /// costs at the current index.
    #[private]
    pub fn on_withdraw_index(
        &mut self,
        #[callback_result(max_bytes = 128)] r: Result<U128, PromiseError>,
        who: AccountId,
        token: AccountId,
        amount: U128,
    ) -> Promise {
        let index = resolve_index(r, "withdraw token index");
        let needed = shares::credit_shares_ceil(amount.0, index);
        if needed > self.credit_of(&who, &token) {
            env::panic_str("InsufficientDeposit");
        }
        self.sub_credit(&who, &token, needed);
        PoolEvent::CreditWithdrawn {
            account_id: who.clone(),
            token: token.clone(),
            amount,
        }
        .emit();

        crate::token_transfer(&token, &who, amount.0).then(
            Contract::ext_self()
                .with_static_gas(GAS_FOR_SYNC_CALLBACK)
                .deposit_restore_callback(who, token, U128(needed)),
        )
    }

    /// Restore the credit shares a failed payout had debited.
    #[private]
    pub fn deposit_restore_callback(
        &mut self,
        #[callback_result] r: Result<(), PromiseError>,
        who: AccountId,
        token: AccountId,
        credit_shares: U128,
    ) {
        if let Err(err) = r {
            env::log_str(&format!("credit payout failed: {err:?}"));
            self.add_credit(&who, &token, credit_shares.0);
        }
    }
}

impl Contract {
    /// Credit `amount` to `sender_id` at `index`, or return it unused.
    ///
    /// An amount below the token's floor, or too small to buy a single credit share,
    /// is returned unchanged so the FT refunds it: crediting it would either let the
    /// depositor pin storage for free or record a credit worth nothing.
    fn credit_deposit(
        &mut self,
        sender_id: &AccountId,
        token: &AccountId,
        amount: u128,
        index: u128,
        decimals: u8,
    ) -> u128 {
        let minimum = min_credit_deposit(Some(decimals));
        if amount < minimum {
            env::log_str(&format!(
                "deposit of {amount} is below the {minimum} minimum"
            ));
            return amount;
        }

        let credit = shares::credit_shares(amount, index);
        if credit == 0 {
            env::log_str("deposit is too small to buy a credit share");
            return amount;
        }

        self.add_credit(sender_id, token, credit);
        PoolEvent::CreditAdded {
            account_id: sender_id.clone(),
            token: token.clone(),
            amount: U128(amount),
        }
        .emit();

        0
    }
}
