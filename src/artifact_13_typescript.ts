import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SummitPulse } from "../target/types/summit_pulse";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("SummitPulse Protocol Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SummitPulse as Program<SummitPulse>;

  const organizer = Keypair.generate();
  const speaker = Keypair.generate();
  const attendeeAuthor = Keypair.generate();
  const attendeeVoter = Keypair.generate();

  const summitId = "BELGRADE-2024-MAIN";
  const sessionTitle = "Breakthroughs in SVM Parallel Execution";
  const questionId = new anchor.BN(101);

  let sessionPda: PublicKey;
  let questionPda: PublicKey;
  let escrowVaultPda: PublicKey;

  before(async () => {
    // Fund test actors
    const airdropSigners = [organizer, speaker, attendeeAuthor, attendeeVoter];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(signer.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session"), Buffer.from(summitId)],
      program.programId
    );

    [questionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("question"), sessionPda.toBuffer(), questionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), questionPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes a Summit Track session PDA", async () => {
    const disputeWindowSlots = new anchor.BN(200);

    await program.methods
      .initializeSession(summitId, sessionTitle, speaker.publicKey, disputeWindowSlots)
      .accounts({
        session: sessionPda,
        authority: organizer.publicKey,
        speaker: speaker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer])
      .rpc();

    const sessionAccount = await program.account.sessionRegistry.fetch(sessionPda);
    expect(sessionAccount.summitId).to.equal(summitId);
    expect(sessionAccount.speaker.toBase58()).to.equal(speaker.publicKey.toBase58());
    expect(sessionAccount.isActive).to.be.true;
    expect(sessionAccount.totalQuestions.toNumber()).to.equal(0);
  });

  it("2. Submits question with 0.1 SOL escrow stake", async () => {
    const questionText = "How does Sealevel resolve account lock contention on hotspot accounts?";
    const contentHash = crypto.createHash("sha256").update(questionText).digest();
    const initialBounty = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

    await program.methods
      .submitQuestion(questionId, Array.from(contentHash), initialBounty)
      .accounts({
        session: sessionPda,
        question: questionPda,
        escrowVault: escrowVaultPda,
        author: attendeeAuthor.publicKey,
        authority: organizer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendeeAuthor])
      .rpc();

    const questionAccount = await program.account.questionRecord.fetch(questionPda);
    expect(questionAccount.author.toBase58()).to.equal(attendeeAuthor.publicKey.toBase58());
    expect(questionAccount.totalStakedLamports.toNumber()).to.equal(initialBounty.toNumber());
    expect(questionAccount.upvoteCount).to.equal(1);

    const vaultBalance = await provider.connection.getBalance(escrowVaultPda);
    expect(vaultBalance).to.equal(initialBounty.toNumber());
  });

  it("3. Audience member upvotes question with 0.05 SOL micro-tip", async () => {
    const tipLamports = new anchor.BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .upvoteQuestion(tipLamports)
      .accounts({
        session: sessionPda,
        question: questionPda,
        escrowVault: escrowVaultPda,
        voter: attendeeVoter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attendeeVoter])
      .rpc();

    const questionAccount = await program.account.questionRecord.fetch(questionPda);
    expect(questionAccount.upvoteCount).to.equal(2);
    expect(questionAccount.totalStakedLamports.toNumber()).to.equal(0.15 * LAMPORTS_PER_SOL);

    const vaultBalance = await provider.connection.getBalance(escrowVaultPda);
    expect(vaultBalance).to.equal(0.15 * LAMPORTS_PER_SOL);
  });

  it("4. Rejects question resolution if unauthorized caller attempts trigger", async () => {
    const maliciousActor = Keypair.generate();
    await provider.connection.requestAirdrop(maliciousActor.publicKey, 1 * LAMPORTS_PER_SOL);

    try {
      await program.methods
        .resolveAndDisburse()
        .accounts({
          session: sessionPda,
          question: questionPda,
          escrowVault: escrowVaultPda,
          authority: maliciousActor.publicKey,
          speaker: speaker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Should have thrown unauthorized settlement error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedSettlement");
    }
  });

  it("5. Organizers trigger resolution: disburses 90% to Speaker and 10% to Organizer", async () => {
    const initialSpeakerBal = await provider.connection.getBalance(speaker.publicKey);
    const initialOrganizerBal = await provider.connection.getBalance(organizer.publicKey);
    const vaultBalBefore = await provider.connection.getBalance(escrowVaultPda);

    const txSig = await program.methods
      .resolveAndDisburse()
      .accounts({
        session: sessionPda,
        question: questionPda,
        escrowVault: escrowVaultPda,
        authority: organizer.publicKey,
        speaker: speaker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([organizer])
      .rpc();

    const postSpeakerBal = await provider.connection.getBalance(speaker.publicKey);
    const postOrganizerBal = await provider.connection.getBalance(organizer.publicKey);
    const finalVaultBal = await provider.connection.getBalance(escrowVaultPda);

    const expectedSpeakerDelta = Math.floor(vaultBalBefore * 0.9);
    const expectedOrganizerDelta = Math.floor(vaultBalBefore * 0.1);

    expect(finalVaultBal).to.equal(0);
    expect(postSpeakerBal - initialSpeakerBal).to.equal(expectedSpeakerDelta);
    // Organizer pays tx fee, delta accounts for tip received minus fee
    expect(postOrganizerBal).to.be.greaterThan(initialOrganizerBal);

    const questionAccount = await program.account.questionRecord.fetch(questionPda);
    expect(questionAccount.status).to.deep.equal({ answered: {} });
  });

  it("6. Rejects subsequent upvotes or re-settlements on resolved question", async () => {
    try {
      await program.methods
        .upvoteQuestion(new anchor.BN(1000))
        .accounts({
          session: sessionPda,
          question: questionPda,
          escrowVault: escrowVaultPda,
          voter: attendeeVoter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attendeeVoter])
        .rpc();
      expect.fail("Should have thrown QuestionClosed error");
    } catch (err: any) {
      expect(err.toString()).to.include("QuestionClosed");
    }
  });
});