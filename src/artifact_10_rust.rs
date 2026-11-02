use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{SessionRegistry, QuestionRecord, QuestionStatus};
use crate::errors::SummitPulseError;

#[derive(Accounts)]
pub struct UpvoteQuestion<'info> {
    #[account(
        mut,
        seeds = [b"session", session.summit_id.as_bytes()],
        bump = session.bump
    )]
    pub session: Account<'info, SessionRegistry>,

    #[account(
        mut,
        seeds = [b"question", session.key().as_ref(), &question.question_id.to_le_bytes()],
        bump = question.bump,
        has_one = session
    )]
    pub question: Account<'info, QuestionRecord>,

    /// CHECK: Deterministic escrow vault account managed by protocol
    #[account(
        mut,
        seeds = [b"vault", question.key().as_ref()],
        bump = question.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(mut)]
    pub voter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<UpvoteQuestion>, micro_tip_lamports: u64) -> Result<()> {
    let session = &mut ctx.accounts.session;
    let question = &mut ctx.accounts.question;

    require!(session.is_active, SummitPulseError::SessionInactive);
    require!(question.status == QuestionStatus::Pending, SummitPulseError::QuestionClosed);

    if micro_tip_lamports > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.voter.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                },
            ),
            micro_tip_lamports,
        )?;

        question.total_staked_lamports = question
            .total_staked_lamports
            .checked_add(micro_tip_lamports)
            .ok_or(SummitPulseError::MathOverflow)?;

        session.cumulative_lamports_routed = session
            .cumulative_lamports_routed
            .checked_add(micro_tip_lamports)
            .ok_or(SummitPulseError::MathOverflow)?;
    }

    question.upvote_count = question.upvote_count.checked_add(1)
        .ok_or(SummitPulseError::MathOverflow)?;

    Ok(())
}