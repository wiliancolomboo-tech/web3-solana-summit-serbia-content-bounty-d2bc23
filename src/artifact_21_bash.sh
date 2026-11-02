# Set network to devnet
solana config set --url https://api.devnet.solana.com

# Airdrop deployer balance
solana airdrop 2

# Deploy program
anchor deploy --provider.cluster devnet

# Verify program deployment
solana program show Srb1111111111111111111111111111111111111111