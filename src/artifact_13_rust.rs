use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::SerbiaEngineError;
use crate::state::{EngineGuardStatus, Market, OrderBook};

#[derive(Accounts)]
pub partial struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

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
    pub user_refund_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelOrder>, order_id: u128, side: u8) -> Result<()> {
    require!(
        ctx.accounts.market.guard_status == EngineGuardStatus::Unlocked as u8,
        SerbiaEngineError::ReentrancyGuardActive
    );
    require!(side == 0 || side == 1, SerbiaEngineError::InvalidOrderSide);

    let mut ob = ctx.accounts.orderbook.load_mut()?;
    let book_side = if side == 0 {
        &mut ob.bids[..]
    } else {
        &mut ob.asks[..]
    };

    let mut order_found = false;
    let mut refund_amount = 0u64;
    let mut is_base_token = false;

    for slot in book_side.iter_mut() {
        if slot.is_active == 1 && slot.order_id == order_id {
            require!(
                slot.owner == ctx.accounts.owner.key(),
                SerbiaEngineError::UnauthorizedOrderCancellation
            );

            let remaining = slot.remaining_lots();
            if side == 0 {
                // Return remaining Quote tokens
                refund_amount = remaining
                    .checked_mul(slot.price_scaled)
                    .ok_or(SerbiaEngineError::MathOverflow)?
                    .checked_div(1_000_000)
                    .ok_or(SerbiaEngineError::MathOverflow)?;
                is_base_token = false;
            } else {
                // Return remaining Base tokens
                refund_amount = remaining;
                is_base_token = true;
            }

            // Invalidate slot in-place (Zero-Copy)
            *slot = crate::state::OrderNode::empty();
            order_found = true;
            break;
        }
    }

    require!(order_found, SerbiaEngineError::OrderNotFound);

    if side == 0 {
        ob.bid_count = ob.bid_count.saturating_sub(1);
    } else {
        ob.ask_count = ob.ask_count.saturating_sub(1);
    }

    drop(ob); // Drop write lock on orderbook before CPI

    let market_key = ctx.accounts.market.key();
    let authority_seeds: &[&[&[u8]]] = if is_base_token {
        &[&[
            b"vault",
            market_key.as_ref(),
            ctx.accounts.market.base_mint.as_ref(),
            &[ctx.accounts.market.base_vault_bump],
        ]]
    } else {
        &[&[
            b"vault",
            market_key.as_ref(),
            ctx.accounts.market.quote_mint.as_ref(),
            &[ctx.accounts.market.quote_vault_bump],
        ]]
    };

    if refund_amount > 0 {
        let (vault_info, target_info) = if is_base_token {
            (
                ctx.accounts.base_vault.to_account_info(),
                ctx.accounts.user_refund_account.to_account_info(),
            )
        } else {
            (
                ctx.accounts.quote_vault.to_account_info(),
                ctx.accounts.user_refund_account.to_account_info(),
            )
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: vault_info,
                to: target_info,
                authority: if is_base_token {
                    ctx.accounts.base_vault.to_account_info()
                } else {
                    ctx.accounts.quote_vault.to_account_info()
                },
            },
            authority_seeds,
        );
        token::transfer(cpi_ctx, refund_amount)?;
    }

    msg!("Order cancelled and escrow refunded: ID={}", order_id);
    Ok(())
}