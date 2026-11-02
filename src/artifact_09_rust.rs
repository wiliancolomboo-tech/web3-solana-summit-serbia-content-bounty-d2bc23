use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{SessionRegistry, QuestionRecord, QuestionStatus};
use crate::errors::SummitPulseError;

#[derive(Accounts)]
#[instruction(question_id: u64)]
pub struct SubmitQuestion<'info> {
    #[account(
        mut,
        seeds = [b"session", session.summit_id.as_bytes()],
        bump = session.bump,
        has_one = authority @ SummitPulseError::UnauthorizedSettlement,
    )]
    pub session: Account<'info, SessionRegistry>,

    #[account(
        init,
        payer = author,
        space = QuestionRecord::LEN,
        seeds = [b"question", session.key().as_ref(), &question_id.to_le_bytes()],
        bump
    )]
    pub question: Account<'info, QuestionRecord>,

    /// CHECK: Deterministic escrow vault account managed by protocol
    #[account(
        mut,
        seeds = [b"vault", question.key().as_ref()],
        bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(mut)]
    pub author: Signer<'info>,

    /// CHECK: Checked via session.authority
    pub authority: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitQuestion>,
    question_id: u64,
    content_hash: [u8; 32],
    initial_bounty: u64,
) -> Result<()> {
    let session = &mut ctx.accounts.session;
    require!(session.is_active, SummitPulseError::SessionInactive);
    require!(initial_bounty >= 10_000_000, SummitPulseError::InsufficientInitialStake); // Min 0.01 SOL

    let question = &mut ctx.accounts.question;
    question.author = ctx.accounts.author.key();
    question.session = session.key();
    question.question_id = question_id;
    question.content_hash = content_hash;
    question.total_staked_lamports = initial_bounty;
    question.upvote_count = 1;
    question.status = QuestionStatus::Pending;
    question.creation_slot = Clock::get()?.slot;
    question.bump = ctx.bumps.question;
    question.vault_bump = ctx.bumps.escrow_vault;

    session.total_questions = session.total_questions.checked_add(1)
        .ok_or(SummitPulseError::MathOverflow)?;
    session.cumulative_lamports_routed = session.cumulative_lamports_routed
        .checked_add(initial_bounty)
        .ok_or(SummitPulseError::MathOverflow)?;

    // CPI: Transfer native SOL to deterministic Escrow Vault
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.author.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
            },
        ),
        initial_bounty,
    )?;

    Ok(())
}