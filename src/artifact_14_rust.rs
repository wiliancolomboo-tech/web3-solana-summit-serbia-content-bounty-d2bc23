use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::SerbiaEngineError;
use crate::state::{EngineGuardStatus, Market, OrderBook, MAX_ORDERS_PER_SIDE};

#[derive(Accounts)]
pub partial struct MatchOrders<'info> {
    #[account(mut)]
    pub crank_authority: Signer<'info>,

    #[account(
        mut,
        has_one = base_vault,
        has_one = quote_vault,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"orderbook", market.key().as_ref()],
        bump
    )]
    pub orderbook: AccountLoader<'info, OrderBook>,

    #[account(mut)]
    pub maker_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub taker_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MatchOrders>, max_iterations: u8) -> Result<()> {
    require!(max_iterations <= 50, SerbiaEngineError::ExcessiveMatchIterations);

    let market = &mut ctx.accounts.market;
    require!(
        market.guard_status == EngineGuardStatus::Unlocked as u8,
        SerbiaEngineError::ReentrancyGuardActive
    );
    // Set Reentrancy Guard
    market.guard_status = EngineGuardStatus::Locked as u8;

    let market_key = market.key();
    let base_mint = market.base_mint;
    let quote_mint = market.quote_mint;
    let base_bump = market.base_vault_bump;
    let quote_bump = market.quote_vault_bump;
    let fee_bps = market.fee_bps as u64;

    let mut matched_base = 0u64;
    let mut matched_quote_net = 0u64;
    let mut execution_happened = false;

    {
        let mut ob = ctx.accounts.orderbook.load_mut()?;

        // Deterministic linear scan matching best bid (highest) vs best ask (lowest)
        for _ in 0..max_iterations {
            let mut best_bid_idx: Option<usize> = None;
            let mut best_ask_idx: Option<usize> = None;

            for i in 0..MAX_ORDERS_PER_SIDE {
                if ob.bids[i].is_active == 1 && ob.bids[i].remaining_lots() > 0 {
                    match best_bid_idx {
                        None => best_bid_idx = Some(i),
                        Some(prev) => {
                            if ob.bids[i].price_scaled > ob.bids[prev].price_scaled {
                                best_bid_idx = Some(i);
                            }
                        }
                    }
                }
            }

            for j in 0..MAX_ORDERS_PER_SIDE {
                if ob.asks[j].is_active == 1 && ob.asks[j].remaining_lots() > 0 {
                    match best_ask_idx {
                        None => best_ask_idx = Some(j),
                        Some(prev) => {
                            if ob.asks[j].price_scaled < ob.asks[prev].price_scaled {
                                best_ask_idx = Some(j);
                            }
                        }
                    }
                }
            }

            // Cross match check
            if let (Some(b_idx), Some(a_idx)) = (best_bid_idx, best_ask_idx) {
                if ob.bids[b_idx].price_scaled >= ob.asks[a_idx].price_scaled {
                    // Match found: Price is maker's price (passive ask)
                    let exec_price = ob.asks[a_idx].price_scaled;
                    let match_lots = std::cmp::min(
                        ob.bids[b_idx].remaining_lots(),
                        ob.asks[a_idx].remaining_lots(),
                    );

                    ob.bids[b_idx].filled_lots = ob.bids[b_idx]
                        .filled_lots
                        .checked_add(match_lots)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    ob.asks[a_idx].filled_lots = ob.asks[a_idx]
                        .filled_lots
                        .checked_add(match_lots)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    let gross_quote = match_lots
                        .checked_mul(exec_price)
                        .ok_or(SerbiaEngineError::MathOverflow)?
                        .checked_div(1_000_000)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    let protocol_fee = gross_quote
                        .checked_mul(fee_bps)
                        .ok_or(SerbiaEngineError::MathOverflow)?
                        .checked_div(10_000)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    let net_quote = gross_quote
                        .checked_sub(protocol_fee)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    matched_base = matched_base
                        .checked_add(match_lots)
                        .ok_or(SerbiaEngineError::MathOverflow)?;
                    matched_quote_net = matched_quote_net
                        .checked_add(net_quote)
                        .ok_or(SerbiaEngineError::MathOverflow)?;

                    if ob.bids[b_idx].remaining_lots() == 0 {
                        ob.bids[b_idx].is_active = 0;
                        ob.bid_count = ob.bid_count.saturating_sub(1);
                    }
                    if ob.asks[a_idx].remaining_lots() == 0 {
                        ob.asks[a_idx].is_active = 0;
                        ob.ask_count = ob.ask_count.saturating_sub(1);
                    }

                    execution_happened = true;
                    continue;
                }
            }
            break;
        }
    }

    // Execute atomic vault settlements via PDA signers
    if execution_happened {
        let base_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            market_key.as_ref(),
            base_mint.as_ref(),
            &[base_bump],
        ]];
        let quote_seeds: &[&[&[u8]]] = &[&[
            b"vault",
            market_key.as_ref(),
            quote_mint.as_ref(),
            &[quote_bump],
        ]];

        // 1. Disburse Base tokens from Vault to Maker (Bidder)
        let cpi_base = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.base_vault.to_account_info(),
                to: ctx.accounts.maker_token_account.to_account_info(),
                authority: ctx.accounts.base_vault.to_account_info(),
            },
            base_seeds,
        );
        token::transfer(cpi_base, matched_base)?;

        // 2. Disburse Quote tokens from Vault to Taker (Seller/Ask)
        let cpi_quote = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.quote_vault.to_account_info(),
                to: ctx.accounts.taker_token_account.to_account_info(),
                authority: ctx.accounts.quote_vault.to_account_info(),
            },
            quote_seeds,
        );
        token::transfer(cpi_quote, matched_quote_net)?;
    }

    // Reset Reentrancy Guard
    let market_reload = &mut ctx.accounts.market;
    market_reload.guard_status = EngineGuardStatus::Unlocked as u8;

    msg!(
        "Match complete: ExecutedBase={}, ExecutedNetQuote={}",
        matched_base,
        matched_quote_net
    );
    Ok(())
}