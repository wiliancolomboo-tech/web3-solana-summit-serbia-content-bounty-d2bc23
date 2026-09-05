# Set endpoint to Solana Devnet
solana config set --url https://api.devnet.solana.com

# Airdrop deployment SOL
solana airdrop 2

# Deploy the zero-copy program
anchor deploy --program-name belgradum_engine --provider.cluster devnet

# Verify program account allocation
solana account $(solana address -k target/deploy/belgradum_engine-keypair.json)