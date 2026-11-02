import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { StreamhookEngine } from "../target/types/streamhook_engine";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import { expect } from "chai";

describe("StreamHook-2022 Technical Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.StreamhookEngine as Program<StreamhookEngine>;
  const connection = provider.connection;

  const authority = Keypair.generate();
  const alice = Keypair.generate(); // Sender
  const bob = Keypair.generate();   // Recipient
  const keeper = Keypair.generate(); // Crank Bot
  const mintKeypair = Keypair.generate();

  const DECIMALS = 6;
  const RATE_PER_SEC = new anchor.BN(1_000); // 1,000 micro-tokens / sec
  const INITIAL_ESCROW = new anchor.BN(5_000_000); // 5 tokens

  let configPda: PublicKey;
  let extraMetasPda: PublicKey;
  let streamPda: PublicKey;
  let vaultPda: PublicKey;
  let aliceAta: PublicKey;
  let bobAta: PublicKey;
  let keeperAta: PublicKey;

  before(async () => {
    // AirDrop Sol to test accounts
    for (const kp of [authority, alice, bob, keeper]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [extraMetasPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stream"), alice.publicKey.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );

    aliceAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      alice.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    bobAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      bob.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    keeperAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      keeper.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  });

  it("1. Initializes Token-2022 Mint with Transfer Hook Extension Pointer", async () => {
    const extensions = [ExtensionType.TransferHook];
    const mintLen = getMintLen(extensions);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        mintKeypair.publicKey,
        authority.publicKey,
        program.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        DECIMALS,
        authority.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tx, [authority, mintKeypair], {
      commitment: "confirmed",
    });

    const mintInfo = await connection.getAccountInfo(mintKeypair.publicKey);
    expect(mintInfo).to.not.be.null;
    expect(mintInfo!.owner.equals(TOKEN_2022_PROGRAM_ID)).to.be.true;
  });

  it("2. Initializes Protocol Global Configuration & ExtraAccountMetaList", async () => {
    await program.methods
      .initializeConfig(500) // 5.00% protocol yield cut
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        treasury: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    await program.methods
      .initializeExtraAccountMetaList()
      .accounts({
        payer: authority.publicKey,
        extraAccountMetaList: extraMetasPda,
        mint: mintKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.protocolFeeBps).to.equal(500);
  });

  it("3. Creates Token Accounts & Funds Sender Escrow", async () => {
    // Build ATAs
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        alice.publicKey,
        aliceAta,
        alice.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        bob.publicKey,
        bobAta,
        bob.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        keeper.publicKey,
        keeperAta,
        keeper.publicKey,
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        mintKeypair.publicKey,
        aliceAta,
        authority.publicKey,
        100_000_000, // 100 tokens
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tx, [authority, alice, bob, keeper]);
  });

  it("4. Opens Continuous Stream Registry with Escrow Vault", async () => {
    await program.methods
      .createStream(RATE_PER_SEC, INITIAL_ESCROW)
      .accounts({
        sender: alice.publicKey,
        recipient: bob.publicKey,
        mint: mintKeypair.publicKey,
        streamRegistry: streamPda,
        senderTokenAccount: aliceAta,
        vault: vaultPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([alice])
      .rpc();

    const stream = await program.account.streamRegistry.fetch(streamPda);
    expect(stream.escrowBalance.toNumber()).to.equal(INITIAL_ESCROW.toNumber());
    expect(stream.flowRatePerSec.toNumber()).to.equal(RATE_PER_SEC.toNumber());
  });

  it("5. Executes Transfer Checked: Automatically Triggers Transfer Hook Interception", async () => {
    // Wait 2 seconds to accrue streaming debt
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const transferAmount = BigInt(1_000_000); // 1 Token

    const transferIx = await createTransferCheckedWithTransferHookInstruction(
      connection,
      aliceAta,
      mintKeypair.publicKey,
      bobAta,
      alice.publicKey,
      transferAmount,
      DECIMALS,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(transferIx);
    const txSig = await sendAndConfirmTransaction(connection, tx, [alice]);
    expect(txSig).to.be.a("string");

    const streamAfter = await program.account.streamRegistry.fetch(streamPda);
    // Escrow balance should have decreased due to elapsed seconds * flow_rate
    expect(streamAfter.escrowBalance.toNumber()).to.be.lessThan(INITIAL_ESCROW.toNumber());
  });

  it("6. Autonomous Keeper Crank Settles Residual Accruals", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const keeperBalanceBefore = await connection.getTokenAccountBalance(keeperAta);

    await program.methods
      .settleExpiredStream()
      .accounts({
        keeper: keeper.publicKey,
        streamRegistry: streamPda,
        mint: mintKeypair.publicKey,
        vault: vaultPda,
        recipientTokenAccount: bobAta,
        keeperTokenAccount: keeperAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    const keeperBalanceAfter = await connection.getTokenAccountBalance(keeperAta);
    expect(Number(keeperBalanceAfter.value.amount)).to.be.greaterThan(
      Number(keeperBalanceBefore.value.amount)
    );
  });
});