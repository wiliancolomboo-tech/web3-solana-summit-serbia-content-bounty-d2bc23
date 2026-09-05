import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { BelgradumEngine } from "../target/types/belgradum_engine";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import * as nacl from "tweetnacl";

describe("Belgradum Engine: Production DePIN Telemetry Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.BelgradumEngine as Program<BelgradumEngine>;
  const admin = web3.Keypair.generate();
  const nodeOperator = web3.Keypair.generate();
  const keeper = web3.Keypair.generate();

  let rewardMint: web3.PublicKey;
  let engineConfigPda: web3.PublicKey;
  let escrowVaultPda: web3.PublicKey;
  let nodeRegistryPda: web3.PublicKey;
  let nodeAta: web3.PublicKey;

  const WINDOW_SLOTS = new BN(120);
  const REWARD_PER_SAMPLE = new BN(500_000); // 0.5 tokens (decimals = 6)
  const hardwareId = Array.from(Buffer.from("BG-BELGRADE-0001", "utf-8"));

  before(async () => {
    // Fund test actors
    for (const actor of [admin, nodeOperator, keeper]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        50 * web3.LAMPORTS_PER_SOL
      );
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    // Deploy test SPL mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    [engineConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("engine_config"), admin.publicKey.toBuffer()],
      program.programId
    );

    [escrowVaultPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), engineConfigPda.toBuffer()],
      program.programId
    );

    [nodeRegistryPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("node"),
        engineConfigPda.toBuffer(),
        nodeOperator.publicKey.toBuffer(),
      ],
      program.programId
    );

    nodeAta = await createAccount(
      provider.connection,
      nodeOperator,
      rewardMint,
      nodeOperator.publicKey
    );
  });

  it("Initializes Engine with Config and Escrow Vault", async () => {
    const tx = await program.methods
      .initializeEngine(WINDOW_SLOTS, REWARD_PER_SAMPLE)
      .accounts({
        config: engineConfigPda,
        rewardMint: rewardMint,
        escrowVault: escrowVaultPda,
        admin: admin.publicKey,
        systemProgram: web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Fund reward escrow vault
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      escrowVaultPda,
      admin,
      100_000_000_000
    );

    const configAccount = await program.account.engineConfig.fetch(engineConfigPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.settlementWindowSlots.toNumber()).to.equal(120);
    expect(configAccount.rewardPerSample.toNumber()).to.equal(500_000);
  });

  it("Registers Edge Hardware Node under deterministic PDA", async () => {
    await program.methods
      .registerNode(hardwareId, 1)
      .accounts({
        config: engineConfigPda,
        nodeRegistry: nodeRegistryPda,
        nodeAuthority: nodeOperator.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([nodeOperator])
      .rpc();

    const nodeAccount = await program.account.nodeRegistry.fetch(nodeRegistryPda);
    expect(nodeAccount.nodeAuthority.toBase58()).to.equal(
      nodeOperator.publicKey.toBase58()
    );
    expect(nodeAccount.totalSamplesSubmitted.toNumber()).to.equal(0);
  });

  it("Executes zero-copy telemetry batch ingest with Ed25519 precompile guard", async () => {
    const currentSlot = await provider.connection.getSlot();
    const epochIndex = new BN(Math.floor(currentSlot / WINDOW_SLOTS.toNumber()));

    const [bufferPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("buffer"),
        nodeRegistryPda.toBuffer(),
        epochIndex.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Mock telemetry samples
    const mockTelemetryBatch = Array.from({ length: 8 }).map((_, i) => ({
      timestamp: new BN(Math.floor(Date.now() / 1000) + i),
      metricValue: new BN(220_000 + i * 50), // 220V fluctuation
      varianceIndex: i,
      errorFlags: 0,
      reserved: [0, 0, 0, 0, 0, 0, 0, 0],
    }));

    // Generate signed payload for Ed25519 precompile
    const message = Buffer.from("BELGRADUM_NODE_TELEMETRY_PAYLOAD_V1");
    const edKeyPair = nacl.sign.keyPair();
    const signature = nacl.sign.detached(message, edKeyPair.secretKey);

    const ed25519Ix = web3.Ed25519Program.createInstructionWithPublicKey({
      publicKey: edKeyPair.publicKey,
      message: message,
      signature: signature,
    });

    const ingestIx = await program.methods
      .ingestTelemetryBatch(epochIndex, mockTelemetryBatch)
      .accounts({
        config: engineConfigPda,
        nodeRegistry: nodeRegistryPda,
        telemetryBuffer: bufferPda,
        nodeAuthority: nodeOperator.publicKey,
        instructionSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();

    const tx = new web3.Transaction().add(ed25519Ix).add(ingestIx);

    const txSignature = await web3.sendAndConfirmTransaction(
      provider.connection,
      tx,
      [nodeOperator]
    );

    // Verify Compute Units and Zero-Copy buffer mapping
    const txDetails = await provider.connection.getTransaction(txSignature, {
      commitment: "confirmed",
    });
    console.log(`\tBatch Ingestion CU Consumed: ${txDetails?.meta?.computeUnitsConsumed} CU`);

    const bufferAccount = await program.account.telemetryBuffer.fetch(bufferPda);
    expect(bufferAccount.sampleCount).to.equal(8);
    expect(bufferAccount.samples[0].metricValue.toNumber()).to.equal(220_000);
  });

  it("Rejects telemetry batch missing Ed25519 precompile verification", async () => {
    const currentSlot = await provider.connection.getSlot();
    const epochIndex = new BN(Math.floor(currentSlot / WINDOW_SLOTS.toNumber()));

    const [bufferPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("buffer"),
        nodeRegistryPda.toBuffer(),
        epochIndex.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const mockTelemetryBatch = Array.from({ length: 8 }).map(() => ({
      timestamp: new BN(Math.floor(Date.now() / 1000)),
      metricValue: new BN(220_100),
      varianceIndex: 1,
      errorFlags: 0,
      reserved: [0, 0, 0, 0, 0, 0, 0, 0],
    }));

    // Ingest WITHOUT Ed25519 instruction in bundle
    try {
      await program.methods
        .ingestTelemetryBatch(epochIndex, mockTelemetryBatch)
        .accounts({
          config: engineConfigPda,
          nodeRegistry: nodeRegistryPda,
          telemetryBuffer: bufferPda,
          nodeAuthority: nodeOperator.publicKey,
          instructionSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([nodeOperator])
        .rpc();
      assert.fail("Should have thrown MissingSignatureVerification error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MissingSignatureVerification");
    }
  });

  it("Settles epoch and reclaims storage rent back to keeper", async () => {
    // Advance slots beyond settlement window
    const targetEpoch = new BN(0);
    const [bufferPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("buffer"),
        nodeRegistryPda.toBuffer(),
        targetEpoch.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Sleep/poll until slot window progresses in local validator
    let currentEpoch = 0;
    while (currentEpoch <= targetEpoch.toNumber()) {
      const slot = await provider.connection.getSlot();
      currentEpoch = Math.floor(slot / WINDOW_SLOTS.toNumber());
      await new Promise((res) => setTimeout(res, 400));
    }

    const keeperBalanceBefore = await provider.connection.getBalance(
      keeper.publicKey
    );

    await program.methods
      .settleEpochAndReclaim(targetEpoch)
      .accounts({
        config: engineConfigPda,
        nodeRegistry: nodeRegistryPda,
        telemetryBuffer: bufferPda,
        escrowVault: escrowVaultPda,
        nodeTokenAccount: nodeAta,
        reclaimRecipient: keeper.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    // Check reward distribution (8 samples * 500,000 = 4,000,000 units)
    const tokenBalance = await getAccount(provider.connection, nodeAta);
    expect(Number(tokenBalance.amount)).to.equal(4_000_000);

    // Verify buffer account is closed and lamports reclaimed
    const closedBufferInfo = await provider.connection.getAccountInfo(bufferPda);
    expect(closedBufferInfo).to.be.null;

    const keeperBalanceAfter = await provider.connection.getBalance(
      keeper.publicKey
    );
    expect(keeperBalanceAfter).to.be.greaterThan(keeperBalanceBefore);
  });
});