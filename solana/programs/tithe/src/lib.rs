//! AGORA on Solana — the Tithe protocol's independent twin.
//!
//! Not a bridge. Shares no state, no supply and no floor with the EVM
//! deployment on Robinhood Chain. Same design, re-instantiated.
//!
//! ## How this maps to the Solidity original
//!
//! | EVM | Solana |
//! |---|---|
//! | Pons creator fees (ETH) | pump.fun creator fees (SOL) |
//! | `FeeSink` contract | keeper wallet + `deposit_fees` |
//! | `Treasury` corpus (ETH) | treasury PDA (lamports) |
//! | `StakedAgora` (ERC-4626 + pull `claim()`) | stake positions + reward accumulator |
//! | `Redeemer` request/execute | `request_redeem` / `execute_redeem` |
//!
//! Because pump.fun pays creator fees in SOL, income and corpus are the same
//! asset — exactly as on EVM, where Pons pays ETH. That restores two properties
//! a Token-2022 transfer-fee design would have lost: the floor ratchets up with
//! volume, and stakers are paid in the reserve asset rather than in the token.
//!
//! ## Two divergences from the Solidity, both forced by the chain
//!
//! 1. **Rent.** `nav` counts only lamports above the treasury's rent-exempt
//!    minimum. Counting the reserve would let the last redemption drop the PDA
//!    below rent exemption and have it reaped — a failure mode Ethereum has no
//!    equivalent for.
//!
//! 2. **Stake positions are not transferable.** EVM `stAGORA` is an ERC-4626
//!    token you can send. Paying SOL rewards against a freely transferable SPL
//!    token would require hooking every transfer to settle the accumulator,
//!    which plain SPL cannot do. Positions live in PDAs instead.
//!
//! ## The trust boundary, stated plainly
//!
//! On EVM the creator-fee recipient is a *contract*, so fees move escrow →
//! FeeSink → Treasury without passing through anyone's wallet. pump.fun pays
//! creator fees to a **wallet**, so on this chain a keeper claims and then calls
//! `deposit_fees`. That hop is trusted. The program cannot enforce that claimed
//! fees actually arrive — only that, once deposited, they are split and spent by
//! these rules.
//!
//! Deployed with the upgrade authority burned: every invariant below is
//! permanent.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("5Gw46h4cZsZgSTX1LLkN7YfdFSCT9YVZSjoTaT5fLGv6");

/// Fixed-point scale for the redemption floor (lamports per token).
pub const FLOOR_SCALE: u128 = 1_000_000_000_000;

/// Fixed-point scale for the reward accumulator.
pub const ACC_SCALE: u128 = 1_000_000_000_000;

/// Hard ceiling on the share of incoming fees that may be routed to stakers
/// instead of corpus, in the spirit of the Solidity cap that stops governance
/// redirecting the whole income stream away from the floor.
///
/// Set to 50%, which is also the intended operating point: creator fees split
/// evenly between staker income and corpus. Because the ceiling equals the
/// target, governance can only ever move the split *toward* the floor, never
/// away from it — corpus is guaranteed at least half of every fee deposit.
pub const MAX_INCOME_SHARE_BPS: u16 = 5_000;

/// The intended split: half to stakers, half to corpus.
pub const DEFAULT_INCOME_SHARE_BPS: u16 = 5_000;

pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod tithe {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        operator: Pubkey,
        redeem_delay: i64,
        income_share_bps: u16,
    ) -> Result<()> {
        require!(redeem_delay >= 0, TitheError::InvalidDelay);
        require!(
            income_share_bps <= MAX_INCOME_SHARE_BPS,
            TitheError::IncomeShareTooHigh
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.operator = operator;
        config.mint = ctx.accounts.mint.key();
        config.stake_vault = ctx.accounts.stake_vault.key();
        config.redeem_escrow = ctx.accounts.redeem_escrow.key();
        config.redeem_delay = redeem_delay;
        config.income_share_bps = income_share_bps;
        config.pending_income = 0;
        config.reward_reserve = 0;
        config.total_shares = 0;
        config.acc_reward_per_share = 0;
        config.total_escrowed = 0;
        config.bump = ctx.bumps.config;
        config.treasury_bump = ctx.bumps.treasury;

        ctx.accounts.treasury.bump = ctx.bumps.treasury;

        emit!(Initialized {
            authority: config.authority,
            operator,
            mint: config.mint,
            redeem_delay,
            income_share_bps,
        });
        Ok(())
    }

    /// Route claimed pump.fun creator fees into the protocol.
    ///
    /// Permissionless: anyone may push SOL in, and only the split is enforced.
    /// `income_share_bps` goes to `pending_income` (owed to stakers, excluded
    /// from `nav`), the remainder becomes corpus and raises the floor.
    pub fn deposit_fees(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);

        system_transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            amount,
        )?;

        let config = &mut ctx.accounts.config;
        let to_income = (u128::from(amount) * u128::from(config.income_share_bps)
            / u128::from(BPS_DENOMINATOR)) as u64;
        let to_corpus = amount.saturating_sub(to_income);

        config.pending_income = config
            .pending_income
            .checked_add(to_income)
            .ok_or(TitheError::MathOverflow)?;

        emit!(FeesDeposited {
            from: ctx.accounts.payer.key(),
            amount,
            to_corpus,
            to_income,
        });
        Ok(())
    }

    /// Seed corpus directly, with no income split. Permissionless.
    pub fn deposit_corpus(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);

        system_transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SystemTransfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(CorpusDeposited {
            from: ctx.accounts.payer.key(),
            amount,
        });
        Ok(())
    }

    /// Move `pending_income` into the staker reward accumulator.
    ///
    /// Permissionless, and reverts when there are no stakers — income stays
    /// earmarked rather than being silently reclassified as corpus, matching the
    /// Solidity `distributeIncome()`.
    pub fn distribute_income(ctx: Context<DistributeIncome>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let amount = config.pending_income;
        require!(amount > 0, TitheError::NothingToDistribute);
        require!(config.total_shares > 0, TitheError::NoStakers);

        let per_share = u128::from(amount)
            .checked_mul(ACC_SCALE)
            .ok_or(TitheError::MathOverflow)?
            .checked_div(u128::from(config.total_shares))
            .ok_or(TitheError::MathOverflow)?;

        config.acc_reward_per_share = config
            .acc_reward_per_share
            .checked_add(per_share)
            .ok_or(TitheError::MathOverflow)?;
        config.pending_income = 0;
        config.reward_reserve = config
            .reward_reserve
            .checked_add(amount)
            .ok_or(TitheError::MathOverflow)?;

        emit!(IncomeDistributed {
            amount,
            total_shares: config.total_shares,
            acc_reward_per_share: config.acc_reward_per_share,
        });
        Ok(())
    }

    /// Stake AGORA. Shares are 1:1 with tokens — there is no share price,
    /// because rewards are paid in SOL rather than compounded into the vault.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);

        settle(&ctx.accounts.config, &mut ctx.accounts.position)?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staker_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        // Safe under `init_if_needed`: the PDA is seeded by the staker's own key,
        // so nobody can steer this at another staker's position, and an existing
        // account is loaded rather than reset.
        position.owner = ctx.accounts.staker.key();
        position.bump = ctx.bumps.position;
        position.shares = position
            .shares
            .checked_add(amount)
            .ok_or(TitheError::MathOverflow)?;

        let config = &mut ctx.accounts.config;
        config.total_shares = config
            .total_shares
            .checked_add(amount)
            .ok_or(TitheError::MathOverflow)?;

        position.reward_debt = debt_for(position.shares, config.acc_reward_per_share)?;

        emit!(Staked {
            staker: position.owner,
            amount,
            shares: position.shares,
        });
        Ok(())
    }

    /// Withdraw staked AGORA. Accrued SOL stays claimable.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);
        require!(
            amount <= ctx.accounts.position.shares,
            TitheError::InsufficientShares
        );

        settle(&ctx.accounts.config, &mut ctx.accounts.position)?;

        let seeds: &[&[&[u8]]] = &[&[b"config", &[ctx.accounts.config.bump]]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.staker_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        position.shares = position
            .shares
            .checked_sub(amount)
            .ok_or(TitheError::MathOverflow)?;

        let config = &mut ctx.accounts.config;
        config.total_shares = config
            .total_shares
            .checked_sub(amount)
            .ok_or(TitheError::MathOverflow)?;

        position.reward_debt = debt_for(position.shares, config.acc_reward_per_share)?;

        emit!(Unstaked {
            staker: position.owner,
            amount,
            shares: position.shares,
        });
        Ok(())
    }

    /// Pull accrued SOL rewards.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        settle(&ctx.accounts.config, &mut ctx.accounts.position)?;

        let owed = ctx.accounts.position.unclaimed;
        require!(owed > 0, TitheError::NothingToClaim);
        require!(
            owed <= ctx.accounts.config.reward_reserve,
            TitheError::RewardReserveUnderflow
        );

        **ctx
            .accounts
            .treasury
            .to_account_info()
            .try_borrow_mut_lamports()? -= owed;
        **ctx.accounts.staker.to_account_info().try_borrow_mut_lamports()? += owed;

        ctx.accounts.position.unclaimed = 0;
        let config = &mut ctx.accounts.config;
        config.reward_reserve = config.reward_reserve.saturating_sub(owed);

        emit!(Claimed {
            staker: ctx.accounts.position.owner,
            amount: owed,
        });
        Ok(())
    }

    /// Move corpus SOL to the operator to be deployed off-program.
    ///
    /// Takes an amount and **no destination** — corpus can only reach
    /// `config.operator`. Capped at `nav`, which excludes `pending_income` and
    /// `reward_reserve`, so money owed to stakers is structurally out of reach.
    /// This is why the floor is *reported*, not guaranteed.
    pub fn withdraw_corpus(ctx: Context<WithdrawCorpus>, amount: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);

        let nav = nav_of(
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.config,
        )?;
        require!(amount <= nav, TitheError::InsufficientCorpus);

        **ctx
            .accounts
            .treasury
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.operator.try_borrow_mut_lamports()? += amount;

        emit!(CorpusWithdrawn {
            to: ctx.accounts.operator.key(),
            amount,
            nav_after: nav_of(
                &ctx.accounts.treasury.to_account_info(),
                &ctx.accounts.config
            )?,
        });
        Ok(())
    }

    /// Phase one of redemption: escrow tokens and snapshot the floor.
    ///
    /// The snapshot is taken with the redeemer's own tokens still in supply, so
    /// escrowing cannot inflate the rate they are quoted.
    pub fn request_redeem(ctx: Context<RequestRedeem>, amount: u64, nonce: u64) -> Result<()> {
        require!(amount > 0, TitheError::ZeroAmount);

        let nav = nav_of(
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.config,
        )?;
        let snapshot_floor = floor_of(nav, ctx.accounts.mint.supply)?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.redeemer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.redeem_escrow.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let clock = Clock::get()?;
        let request = &mut ctx.accounts.request;
        request.owner = ctx.accounts.redeemer.key();
        request.amount = amount;
        request.snapshot_floor = snapshot_floor;
        request.unlock_ts = clock
            .unix_timestamp
            .checked_add(ctx.accounts.config.redeem_delay)
            .ok_or(TitheError::MathOverflow)?;
        request.nonce = nonce;
        request.bump = ctx.bumps.request;

        let config = &mut ctx.accounts.config;
        config.total_escrowed = config
            .total_escrowed
            .checked_add(amount)
            .ok_or(TitheError::MathOverflow)?;

        emit!(RedeemRequested {
            owner: request.owner,
            amount,
            snapshot_floor,
            unlock_ts: request.unlock_ts,
        });
        Ok(())
    }

    /// Phase two: burn the escrow and pay `min(snapshot, current)`.
    ///
    /// Two orderings are load-bearing and must not be rearranged:
    ///
    /// * `current` is computed **before** the burn. Burning shrinks supply, which
    ///   raises the floor — computing after would pay the redeemer at a rate
    ///   their own exit created.
    /// * `min(snapshot, current)` means an operator withdrawal between the two
    ///   phases *reduces* the payout rather than letting anyone claim value that
    ///   is no longer there. Since the payout is a share of nav, the treasury is
    ///   solvent for it by construction and a matured request cannot revert for
    ///   lack of funds.
    pub fn execute_redeem(ctx: Context<ExecuteRedeem>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= ctx.accounts.request.unlock_ts,
            TitheError::NotMatured
        );

        let amount = ctx.accounts.request.amount;
        let nav = nav_of(
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.config,
        )?;
        let supply = ctx.accounts.mint.supply;

        // Fall back to the snapshot when supply has gone to zero, mirroring the
        // Solidity `_payFloor`.
        let current_floor = if supply == 0 {
            ctx.accounts.request.snapshot_floor
        } else {
            floor_of(nav, supply)?
        };
        let pay_rate = core::cmp::min(ctx.accounts.request.snapshot_floor, current_floor);

        let payout = u128::from(amount)
            .checked_mul(pay_rate)
            .ok_or(TitheError::MathOverflow)?
            .checked_div(FLOOR_SCALE)
            .ok_or(TitheError::MathOverflow)?;
        let payout = u64::try_from(payout).map_err(|_| TitheError::MathOverflow)?;
        require!(payout <= nav, TitheError::InsufficientCorpus);

        let seeds: &[&[&[u8]]] = &[&[b"config", &[ctx.accounts.config.bump]]];
        anchor_spl::token_interface::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.redeem_escrow.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                seeds,
            ),
            amount,
        )?;

        if payout > 0 {
            **ctx
                .accounts
                .treasury
                .to_account_info()
                .try_borrow_mut_lamports()? -= payout;
            **ctx
                .accounts
                .redeemer
                .to_account_info()
                .try_borrow_mut_lamports()? += payout;
        }

        let config = &mut ctx.accounts.config;
        config.total_escrowed = config.total_escrowed.saturating_sub(amount);

        emit!(Redeemed {
            owner: ctx.accounts.redeemer.key(),
            burned: amount,
            payout,
            pay_rate,
        });
        Ok(())
    }

    /// Withdraw an un-matured redemption request.
    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        let amount = ctx.accounts.request.amount;

        let seeds: &[&[&[u8]]] = &[&[b"config", &[ctx.accounts.config.bump]]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.redeem_escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.redeemer_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let config = &mut ctx.accounts.config;
        config.total_escrowed = config.total_escrowed.saturating_sub(amount);

        emit!(RedeemCancelled {
            owner: ctx.accounts.redeemer.key(),
            amount,
        });
        Ok(())
    }

    pub fn set_operator(ctx: Context<AdminOnly>, operator: Pubkey) -> Result<()> {
        let previous = ctx.accounts.config.operator;
        ctx.accounts.config.operator = operator;
        emit!(OperatorChanged { previous, operator });
        Ok(())
    }

    pub fn set_income_share_bps(ctx: Context<AdminOnly>, bps: u16) -> Result<()> {
        require!(bps <= MAX_INCOME_SHARE_BPS, TitheError::IncomeShareTooHigh);
        let previous = ctx.accounts.config.income_share_bps;
        ctx.accounts.config.income_share_bps = bps;
        emit!(IncomeShareChanged { previous, bps });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/// Lamports backing the floor.
///
/// Excludes the rent-exempt reserve (a Solana-only concern) and everything owed
/// to stakers — both undistributed `pending_income` and distributed-but-unclaimed
/// `reward_reserve`. That exclusion is what makes staker income untouchable by
/// `withdraw_corpus`, mirroring the Solidity `liquidEth()`.
pub fn nav_of(treasury: &AccountInfo, config: &Config) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(treasury.data_len());
    Ok(treasury
        .lamports()
        .saturating_sub(rent)
        .saturating_sub(config.pending_income)
        .saturating_sub(config.reward_reserve))
}

/// Lamports per token, scaled by `FLOOR_SCALE`.
pub fn floor_of(nav: u64, supply: u64) -> Result<u128> {
    if supply == 0 {
        return Ok(0);
    }
    u128::from(nav)
        .checked_mul(FLOOR_SCALE)
        .ok_or(TitheError::MathOverflow)?
        .checked_div(u128::from(supply))
        .ok_or(TitheError::MathOverflow.into())
}

fn debt_for(shares: u64, acc: u128) -> Result<u128> {
    u128::from(shares)
        .checked_mul(acc)
        .ok_or(TitheError::MathOverflow)?
        .checked_div(ACC_SCALE)
        .ok_or(TitheError::MathOverflow.into())
}

/// Fold newly accrued rewards into `unclaimed` before shares change.
fn settle(config: &Config, position: &mut Account<StakePosition>) -> Result<()> {
    if position.shares > 0 {
        let accrued = debt_for(position.shares, config.acc_reward_per_share)?
            .saturating_sub(position.reward_debt);
        let accrued = u64::try_from(accrued).map_err(|_| TitheError::MathOverflow)?;
        position.unclaimed = position
            .unclaimed
            .checked_add(accrued)
            .ok_or(TitheError::MathOverflow)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// Sole permitted destination of `withdraw_corpus`.
    pub operator: Pubkey,
    pub mint: Pubkey,
    pub stake_vault: Pubkey,
    pub redeem_escrow: Pubkey,
    pub redeem_delay: i64,
    /// Share of incoming fees routed to stakers instead of corpus.
    pub income_share_bps: u16,
    /// Owed to stakers, not yet distributed. Excluded from `nav`.
    pub pending_income: u64,
    /// Distributed to stakers, not yet claimed. Excluded from `nav`.
    pub reward_reserve: u64,
    pub total_shares: u64,
    pub acc_reward_per_share: u128,
    pub total_escrowed: u64,
    pub bump: u8,
    pub treasury_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub owner: Pubkey,
    pub shares: u64,
    pub reward_debt: u128,
    pub unclaimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RedeemRequest {
    pub owner: Pubkey,
    pub amount: u64,
    pub snapshot_floor: u128,
    pub unlock_ts: i64,
    pub nonce: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,

    #[account(init, payer = authority, space = 8 + Treasury::INIT_SPACE, seeds = [b"treasury"], bump)]
    pub treasury: Account<'info, Treasury>,

    /// The pump.fun mint.
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init, payer = authority, seeds = [b"stake_vault"], bump,
        token::mint = mint, token::authority = config, token::token_program = token_program
    )]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = authority, seeds = [b"redeem_escrow"], bump,
        token::mint = mint, token::authority = config, token::token_program = token_program
    )]
    pub redeem_escrow: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositFees<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeIncome<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = staker)]
    pub staker_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed, payer = staker, space = 8 + StakePosition::INIT_SPACE,
        seeds = [b"position", staker.key().as_ref()], bump
    )]
    pub position: Account<'info, StakePosition>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.stake_vault)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = staker)]
    pub staker_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", staker.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == staker.key() @ TitheError::NotPositionOwner
    )]
    pub position: Account<'info, StakePosition>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    #[account(mut, seeds = [b"position", staker.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, StakePosition>,
}

#[derive(Accounts)]
pub struct WithdrawCorpus<'info> {
    #[account(address = config.authority)]
    pub authority: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    /// CHECK: constrained to `config.operator`; this instruction takes no
    /// destination argument, so corpus can only ever land here.
    #[account(mut, address = config.operator)]
    pub operator: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, nonce: u64)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub redeemer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.redeem_escrow)]
    pub redeem_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = redeemer)]
    pub redeemer_token: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = redeemer, space = 8 + RedeemRequest::INIT_SPACE,
        seeds = [b"redeem", redeemer.key().as_ref(), &nonce.to_le_bytes()], bump
    )]
    pub request: Account<'info, RedeemRequest>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteRedeem<'info> {
    #[account(mut, address = request.owner)]
    pub redeemer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    #[account(mut, address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.redeem_escrow)]
    pub redeem_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, close = redeemer,
        seeds = [b"redeem", request.owner.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump)]
    pub request: Account<'info, RedeemRequest>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut, address = request.owner)]
    pub redeemer: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = config.redeem_escrow)]
    pub redeem_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = redeemer)]
    pub redeemer_token: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, close = redeemer,
        seeds = [b"redeem", request.owner.as_ref(), &request.nonce.to_le_bytes()],
        bump = request.bump)]
    pub request: Account<'info, RedeemRequest>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.authority)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct Initialized {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub mint: Pubkey,
    pub redeem_delay: i64,
    pub income_share_bps: u16,
}

#[event]
pub struct FeesDeposited {
    pub from: Pubkey,
    pub amount: u64,
    pub to_corpus: u64,
    pub to_income: u64,
}

#[event]
pub struct CorpusDeposited {
    pub from: Pubkey,
    pub amount: u64,
}

#[event]
pub struct IncomeDistributed {
    pub amount: u64,
    pub total_shares: u64,
    pub acc_reward_per_share: u128,
}

#[event]
pub struct Staked {
    pub staker: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Unstaked {
    pub staker: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Claimed {
    pub staker: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CorpusWithdrawn {
    pub to: Pubkey,
    pub amount: u64,
    pub nav_after: u64,
}

#[event]
pub struct RedeemRequested {
    pub owner: Pubkey,
    pub amount: u64,
    pub snapshot_floor: u128,
    pub unlock_ts: i64,
}

#[event]
pub struct Redeemed {
    pub owner: Pubkey,
    pub burned: u64,
    pub payout: u64,
    pub pay_rate: u128,
}

#[event]
pub struct RedeemCancelled {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OperatorChanged {
    pub previous: Pubkey,
    pub operator: Pubkey,
}

#[event]
pub struct IncomeShareChanged {
    pub previous: u16,
    pub bps: u16,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum TitheError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Redemption has not matured yet")]
    NotMatured,
    #[msg("Treasury has insufficient liquid corpus")]
    InsufficientCorpus,
    #[msg("Position does not hold that many shares")]
    InsufficientShares,
    #[msg("Redeem delay must not be negative")]
    InvalidDelay,
    #[msg("Income share exceeds the hard cap")]
    IncomeShareTooHigh,
    #[msg("No income is pending distribution")]
    NothingToDistribute,
    #[msg("No stakers to distribute to")]
    NoStakers,
    #[msg("Nothing accrued to claim")]
    NothingToClaim,
    #[msg("Reward reserve underflow")]
    RewardReserveUnderflow,
    #[msg("Signer does not own this position")]
    NotPositionOwner,
}

// ---------------------------------------------------------------------------
// Unit tests — pure math, no validator required
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_is_nav_over_supply() {
        // 10 SOL backing 1000 whole tokens at 6 decimals.
        let nav = 10_000_000_000u64; // lamports
        let supply = 1_000_000_000u64; // base units = 1000 tokens

        // The floor is lamports per *base unit*, scaled by FLOOR_SCALE.
        let floor = floor_of(nav, supply).unwrap();
        assert_eq!(floor, 10 * FLOOR_SCALE);

        // Which is 0.01 SOL for one whole token.
        let per_whole_token = (u128::from(1_000_000u64) * floor / FLOOR_SCALE) as u64;
        assert_eq!(per_whole_token, 10_000_000); // 0.01 SOL in lamports
    }

    #[test]
    fn floor_of_zero_supply_is_zero() {
        assert_eq!(floor_of(1_000, 0).unwrap(), 0);
    }

    #[test]
    fn floor_rises_when_fees_arrive() {
        let supply = 1_000_000_000u64;
        let before = floor_of(10_000_000_000, supply).unwrap();
        let after = floor_of(11_000_000_000, supply).unwrap();
        assert!(after > before, "creator fees did not ratchet the floor");
    }

    #[test]
    fn floor_rises_when_supply_burns() {
        let nav = 10_000_000_000u64;
        let before = floor_of(nav, 1_000_000_000).unwrap();
        let after = floor_of(nav, 900_000_000).unwrap();
        assert!(after > before, "redemption did not ratchet the floor");
    }

    #[test]
    fn payout_never_exceeds_nav() {
        let nav = 10_000_000_000u64;
        let supply = 1_000_000_000u64;
        let rate = floor_of(nav, supply).unwrap();
        // Redeeming the entire supply cannot claim more than nav.
        let payout = (u128::from(supply) * rate / FLOOR_SCALE) as u64;
        assert!(payout <= nav, "payout {payout} exceeded nav {nav}");
    }

    #[test]
    fn accumulator_splits_pro_rata() {
        // 3 SOL over 300 shares; a 100-share staker is owed 1 SOL.
        let income = 3_000_000_000u128;
        let total_shares = 300u128;
        let acc = income * ACC_SCALE / total_shares;
        let owed = debt_for(100, acc).unwrap();
        assert_eq!(owed, 1_000_000_000);
    }

    #[test]
    fn accumulator_rounds_down_so_reserve_never_underflows() {
        // 10 lamports over 3 shares: each of three equal stakers gets 3, not 4.
        let acc = 10u128 * ACC_SCALE / 3;
        let each = debt_for(1, acc).unwrap();
        assert_eq!(each, 3);
        assert!(each * 3 <= 10, "distributed more than was reserved");
    }

    #[test]
    fn fees_split_evenly_between_stakers_and_corpus() {
        assert_eq!(DEFAULT_INCOME_SHARE_BPS, 5_000);
        let amount = 1_000_000u64;
        let to_income =
            (u128::from(amount) * u128::from(DEFAULT_INCOME_SHARE_BPS) / u128::from(BPS_DENOMINATOR))
                as u64;
        assert_eq!(to_income, 500_000);
        assert_eq!(amount - to_income, 500_000);
    }

    /// The ceiling equals the operating point, so corpus can never be given less
    /// than half — governance may only shift the split toward the floor.
    #[test]
    fn corpus_always_keeps_at_least_half() {
        assert_eq!(MAX_INCOME_SHARE_BPS, 5_000);
        for bps in [0u16, 1_000, 2_500, 5_000] {
            let amount = 1_000_000u64;
            let to_income =
                (u128::from(amount) * u128::from(bps) / u128::from(BPS_DENOMINATOR)) as u64;
            assert!(
                amount - to_income >= amount / 2,
                "corpus got less than half at {bps} bps"
            );
        }
    }
}
