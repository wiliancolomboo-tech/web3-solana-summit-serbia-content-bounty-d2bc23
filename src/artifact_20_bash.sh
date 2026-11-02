# Switch to Devnet
solana config set --url devnet

# Ensure deployment wallet is funded
solana airdrop 2

# Deploy the program
anchor deploy --provider.cluster devnet

# Verify deployed program ID
solana program show Summ1tEng1neSerb1a1111111111111111111111111