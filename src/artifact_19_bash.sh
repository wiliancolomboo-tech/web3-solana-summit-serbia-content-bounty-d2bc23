# Configure environment to Devnet
solana config set --url devnet

# Ensure deployer wallet is funded
solana airdrop 2

# Deploy program binary
anchor deploy --provider.cluster devnet

# Verification output confirms deployment:
# Program Id: S3rbiaPulse111111111111111111111111111111111
# Deploy success.