//! Quote math and the reserve views.
//!
//! The quote is the origin formula, unchanged: the fee is taken from the input
//! side and stays in the pool, so a swap moves
//! `out = amount_in * (BPS - fee) * reserve_out / (reserve_in * BPS + amount_in * (BPS - fee))`.
//!
//! All intermediates run in `U256`. At a 1_000-token scale the products
//! (`amount_in * reserve_out`, `amount * supply`, `reserve * shares` and the
//! square-root input) sit around 1e42, far above `u128::MAX`; only the final
//! result is narrowed back to `u128`.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId};
use primitive_types::U256;

use crate::{Contract, ContractExt, BPS};

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
        if amount_in == 0 {
            return 0;
        }

        let after_fee = U256::from(amount_in) * U256::from(BPS - self.swap_fee_bps as u128);
        let numerator = after_fee * U256::from(r_out);
        let denominator = U256::from(r_in) * U256::from(BPS) + after_fee;

        narrow(numerator / denominator)
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
