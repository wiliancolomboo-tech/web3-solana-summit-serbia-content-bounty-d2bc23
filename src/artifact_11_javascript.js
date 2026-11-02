const id = "belgrade-2025";
const [summitPda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("summit"), Buffer.from(id)],
  pg.program.programId
);
console.log("Summit PDA Derived:", summitPda.toBase58());