import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SummitEngine } from "../target/types/summit_engine";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";

describe("SummitEngine Protocol Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SummitEngine as Program<SummitEngine>;

  const conferenceAuthority = Keypair.generate();
  const attendee = Keypair.generate();
  const summitId = Array.from(crypto.randomBytes(16));
  const teamId = Array.from(crypto.randomBytes(16));
  const mockMetadata = Array.from(Buffer.alloc(64, 7));

  let conferencePda: PublicKey;
  let badgeMintPda: PublicKey;
  let attendeeProfilePda: PublicKey;
  let attendeeAta: PublicKey;
  let projectPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdrop1 = await provider.connection.requestAirdrop(
      conferenceAuthority.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    const airdrop2 = await provider.connection.requestAirdrop(
      attendee.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    [conferencePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("conference"), Buffer.from(summitId)],
      program.programId
    );

    [badgeMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("badge_mint"), conferencePda.toBuffer()],
      program.programId
    );

    [attendeeProfilePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("attendee"),
        conferencePda.toBuffer(),
        attendee.publicKey.toBuffer(),
      ],
      program.programId
    );

    attendeeAta = getAssociatedTokenAddressSync(
      badgeMintPda,
      attendee.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    [projectPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("project"), conferencePda.toBuffer(), Buffer.from(teamId)],
      program.programId
    );
  });

  it("Initializes Conference State with Token-2022 Badge Mint", async () => {
    const maxAttendees = 1000;
    const totalTracks = 8;

    await program.methods
      .initializeConference(summitId, maxAttendees, totalTracks)
      .accountsStrict({
        conference: conferencePda,
        badgeMint: badgeMintPda,
        authority: conferenceAuthority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([conferenceAuthority])
      .rpc();

    const confAccount = await program.account.conferenceState.fetch(conferencePda);
    expect(confAccount.attendeeCount).to.equal(0);
    expect(confAccount.totalTracks).to.equal(8);
    expect(confAccount.authority.toBase58()).to.equal(conferenceAuthority.publicKey.toBase58());
  });

  it("Registers Attendee with Atomic Ed25519 Introspection & Mints Soulbound Badge", async () => {
    // Generate check-in signature from summit organizer
    const checkinMessage = Buffer.from("SOLANA_SUMMIT_SERBIA_CHECKIN_VERIFIED");
    const ed25519Instruction = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: conferenceAuthority.secretKey,
      message: checkinMessage,
    });

    const registerIx = await program.methods
      .registerAttendee(summitId)
      .accountsStrict({
        conference: conferencePda,
        attendeeProfile: attendeeProfilePda,
        badgeMint: badgeMintPda,
        attendeeTokenAccount: attendeeAta,
        attendee: attendee.publicKey,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Instruction).add(registerIx);

    await sendAndConfirmTransaction(provider.connection, tx, [attendee]);

    const attendeeState = await program.account.attendeeProfile.fetch(attendeeProfilePda);
    expect(attendeeState.isCheckedIn).to.be.true;
    expect(attendeeState.trackBitmask.toNumber()).to.equal(0);

    const tokenBalance = await provider.connection.getTokenAccountBalance(attendeeAta);
    expect(tokenBalance.value.uiAmount).to.equal(1);
  });

  it("Attests Workshop Completion via Bitwise Flagging", async () => {
    const trackIndex = 3; // Workshop Track #3 (e.g. Anchor & Solana Security)

    await program.methods
      .attestWorkshopCompletion(trackIndex)
      .accountsStrict({
        conference: conferencePda,
        attendeeProfile: attendeeProfilePda,
        authority: conferenceAuthority.publicKey,
      })
      .signers([conferenceAuthority])
      .rpc();

    const attendeeState = await program.account.attendeeProfile.fetch(attendeeProfilePda);
    const expectedBitmask = 1 << trackIndex; // 1 << 3 = 8
    expect(attendeeState.trackBitmask.toNumber()).to.equal(expectedBitmask);
  });

  it("Rejects Duplicate Attestation for the Same Track", async () => {
    try {
      await program.methods
        .attestWorkshopCompletion(3)
        .accountsStrict({
          conference: conferencePda,
          attendeeProfile: attendeeProfilePda,
          authority: conferenceAuthority.publicKey,
        })
        .signers([conferenceAuthority])
        .rpc();
      expect.fail("Should have failed on duplicate track completion");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TrackAlreadyCompleted");
    }
  });

  it("Submits a Hackathon Project with Anchor PDA Validation", async () => {
    await program.methods
      .submitHackathonProject(teamId, mockMetadata)
      .accountsStrict({
        conference: conferencePda,
        attendeeProfile: attendeeProfilePda,
        project: projectPda,
        teamLead: attendee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendee])
      .rpc();

    const projectState = await program.account.hackathonProject.fetch(projectPda);
    expect(projectState.teamLead.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(projectState.aggregateScore.toNumber()).to.equal(0);
  });

  it("Settles Hackathon Evaluation Scores from Summit Judges", async () => {
    const judgeScore = new anchor.BN(95);

    await program.methods
      .settleEvaluation(judgeScore)
      .accountsStrict({
        conference: conferencePda,
        project: projectPda,
        authority: conferenceAuthority.publicKey,
      })
      .signers([conferenceAuthority])
      .rpc();

    const projectState = await program.account.hackathonProject.fetch(projectPda);
    expect(projectState.aggregateScore.toNumber()).to.equal(95);
    expect(projectState.evaluationCount).to.equal(1);
  });
});