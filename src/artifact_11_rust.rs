use anchor_lang::prelude::*;
use crate::state::{SessionRegistry, QuestionRecord, QuestionStatus};
use crate::errors::SummitPulseError;

#[derive(Accounts)]
pub struct ResolveAndDisburse<'info> {
    #[account(
        seeds = [b"session", session.summit_id.as_bytes()],
        bump = session.bump,
        has_one = authority @ SummitPulseError::UnauthorizedSettlement,
        has_one = speaker
    )]
    pub session: Account<'info, SessionRegistry>,

    #[account(
        mut,
        seeds = [b"question", session.key().as_ref(), &question.question_id.to_le_bytes()],
        bump = question.bump,
        has_one = session
    )]
    pub question: Account<'info, QuestionRecord>,

    /// CHECK: Deterministic escrow vault signed with PDA seeds
    #[account(
        mut,
        seeds = [b"vault", question.key().as_ref()],
        bump = question.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Validated via session.has_one = speaker
    #[account(mut)]
    pub speaker: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ResolveAndDisburse>) -> Result<()> {
    let question = &mut ctx.accounts.question;
    require!(question.status == QuestionStatus::Pending, SummitPulseError::QuestionAlreadyResolved);

    let total_lamports = ctx.accounts.escrow_vault.lamports();
    require!(total_lamports > 0, SummitPulseError::InvalidVaultState);

    // Compute fee breakdown: 90% to Keynote Speaker, 10% Protocol Reserve
    let protocol_fee = total_lamports
        .checked_mul(10)
        .ok_or(SummitPulseError::MathOverflow)?
        .checked_div(100)
        .ok_or(SummitPulseError::MathOverflow)?;

    let speaker_reward = total_lamports
        .checked_sub(protocol_fee)
        .ok_or(SummitPulseError::MathOverflow)?;

    // Direct PDA-to-Account transfer by manipulating lamports directly
    // Escrow vault is owned by the SummitPulse program
    **ctx.accounts.escrow_vault.try_borrow_mut_lamports()? = 0;
    
    **ctx.accounts.speaker.try_borrow_mut_lamports()? = ctx
        .accounts
        .speaker
        .lamports()
        .checked_add(speaker_reward)
        .ok_or(SummitPulseError::MathOverflow)?;

    **ctx.accounts.authority.try_borrow_mut_lamports()? = ctx
        .accounts
        .authority
        .lamports()
        .checked_add(protocol_fee)
        .ok_or(SummitPulseError::MathOverflow)?;

    question.status = QuestionStatus::Answered;

    Ok(())
}