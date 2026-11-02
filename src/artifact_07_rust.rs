use anchor_lang::prelude::*;

#[error_code]
pub enum SummitPulseError {
    #[msg("Session string identifier exceeds maximum size of 32 bytes.")]
    SummitIdTooLong,
    #[msg("Session title exceeds maximum size of 64 bytes.")]
    TitleTooLong,
    #[msg("Session is currently paused or inactive.")]
    SessionInactive,
    #[msg("The initial question stake must be equal to or greater than the 0.01 SOL floor.")]
    InsufficientInitialStake,
    #[msg("Arithmetic overflow occurred during stake aggregation.")]
    MathOverflow,
    #[msg("Question is not in a valid state to receive upvotes.")]
    QuestionClosed,
    #[msg("Question has already been settled or answered.")]
    QuestionAlreadyResolved,
    #[msg("Unauthorized: Signer does not have administrative rights for settlement.")]
    UnauthorizedSettlement,
    #[msg("Invalid vault PDA derivation or lamport balance mismatch.")]
    InvalidVaultState,
}