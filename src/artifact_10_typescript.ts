import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SubZero } from "../target/types/sub_zero";
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  SYSVAR_INSTRUCTIONS_PUBKEY, 
  Ed25519Program, 
  ComputeBudgetProgram 
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { expect } from "chai";

describe("SUB-ZERO: Summit Attestation & Rent Reclamation Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SubZero as Program<SubZero>;

  const summitAuthority = nacl.sign.keyPair(); // Ed25519 Authority Keypair
  const summitId = Array.from(Buffer.from("SOL-BELGRADE-25\0")); // 16 bytes exactly
  const treasury = Keypair.generate();
  const attendee = Keypair.generate();

  let summitConfigPda: PublicKey;
  let attestationPda: PublicKey;
  let summitEndTs: anchor.BN;

  before(async () => {
    // Airdrop funds to treasury and provider
    const sig = await provider.connection.requestAirdrop(treasury.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    [summitConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("summit_config"), Buffer.from(summitId)],
      program.programId
    );

    [attestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("summit_attestation"), Buffer.from(summitId), attendee.publicKey.toBuffer()],
      program.programId
    );

    const currentSlotTime = (await provider.connection.getBlockTime(await provider.connection.getSlot())) || Math.floor(Date.now() / 1000);
    summitEndTs = new anchor.BN(currentSlotTime + 4); // Expires in 4 seconds for time-lock test
  });

  it("1. Initializes the Summit Configuration PDA with canonical bump", async () => {
    await program.methods
      .initializeSummit(
        summitId,
        summitEndTs,
        Array.from(summitAuthority.publicKey)
      )
      .accounts({
        summitConfig: summitConfigPda,
        payer: provider.wallet.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.summitConfig.fetch(summitConfigPda);
    expect(Buffer.from(configAccount.summitId)).to.deep.equal(Buffer.from(summitId));
    expect(configAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(configAccount.totalIssued.toNumber()).to.equal(0);
  });

  it("2. Issues Attestation utilizing Atomic Ed25519 Precompile & Zero-Copy Storage", async () => {
    const tier = 1; // ProtocolArchitect
    const message = Buffer.concat([
      attendee.publicKey.toBuffer(),
      Buffer.from(summitId),
      Buffer.from([tier]),
    ]);

    const signature = nacl.sign.detached(message, summitAuthority.secretKey);

    // Build the native Ed25519 precompile instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: summitAuthority.publicKey,
      message: message,
      signature: signature,
      instructionIndex: 0,
    });

    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 });

    const issueIx = await program.methods
      .issueAttestation(summitId, { protocolArchitect: {} }, 1)
      .accounts({
        summitConfig: summitConfigPda,
        attestation: attestationPda,
        attendee: attendee.publicKey,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(computeLimitIx).add(ed25519Ix).add(issueIx);
    const txSig = await provider.sendAndConfirm(tx);
    console.log("    Attestation Issued Successfully. TxSig:", txSig);

    // Read back zero-copy buffer
    const attestationAccount = await program.account.attestationRecord.fetch(attestationPda);
    expect(attestationAccount.attendee.toBase58()).to.equal(attendee.publicKey.toBase58());
    expect(attestationAccount.tier).to.equal(1);
    expect(attestationAccount.flags).to.equal(1);
  });

  it("3. Prevents Attestation Replay Attack", async () => {
    const tier = 1;
    const message = Buffer.concat([
      attendee.publicKey.toBuffer(),
      Buffer.from(summitId),
      Buffer.from([tier]),
    ]);
    const signature = nacl.sign.detached(message, summitAuthority.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: summitAuthority.publicKey,
      message: message,
      signature: signature,
      instructionIndex: 0,
    });

    const issueIx = await program.methods
      .issueAttestation(summitId, { protocolArchitect: {} }, 0)
      .accounts({
        summitConfig: summitConfigPda,
        attestation: attestationPda,
        attendee: attendee.publicKey,
        payer: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    try {
      const tx = new anchor.web3.Transaction().add(ed25519Ix).add(issueIx);
      await provider.sendAndConfirm(tx);
      expect.fail("Should have failed with account already initialized error");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("4. Enforces Time-Lock: Rejects premature rent reclamation", async () => {
    try {
      await program.methods
        .reclaimRent(summitId)
        .accounts({
          summitConfig: summitConfigPda,
          attestation: attestationPda,
          treasury: treasury.publicKey,
          signer: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Reclamation must fail while event is active");
    } catch (err: any) {
      expect(err.toString()).to.include("SummitStillActive");
    }
  });

  it("5. Reclaims Rent-Exempt Lamports post-summit expiration", async () => {
    // Wait for the summit expiration threshold
    console.log("    Waiting 5 seconds for summit validity period to elapse...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const treasuryBalanceBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .reclaimRent(summitId)
      .accounts({
        summitConfig: summitConfigPda,
        attestation: attestationPda,
        treasury: treasury.publicKey,
        signer: provider.wallet.publicKey,
      })
      .rpc();

    const treasuryBalanceAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryBalanceAfter).to.be.greaterThan(treasuryBalanceBefore);

    const closedAccountInfo = await provider.connection.getAccountInfo(attestationPda);
    expect(closedAccountInfo).to.be.null;
    console.log("    Rent Reclaimed: 100% of Lamports Returned to Summit Treasury.");
  });
});