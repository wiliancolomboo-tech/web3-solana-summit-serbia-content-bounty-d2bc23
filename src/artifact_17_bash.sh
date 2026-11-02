# Run local Solana test validator with pre-configured bpf settings
solana-test-validator --reset --quiet &
PID=$!

# Configure CLI to point to localnet
solana config set --url localhost