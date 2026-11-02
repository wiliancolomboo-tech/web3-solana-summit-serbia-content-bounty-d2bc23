"""
Keeper loop to periodically finalize expired summits.
Requires:
  pip install anchorpy solana>=0.30
"""

import asyncio
import json
import os
from typing import List

from anchorpy import Provider, Wallet, Program
from solana.public_key import PublicKey
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.system_program import ID as SYS_ID
from solders.pubkey import Pubkey
from pathlib import Path

from anchorpy import Idl

RPC_URL = os.getenv("RPC_URL", "http://127.0.0.1:8899")
PROGRAM_ID = PublicKey(os.getenv("PROGRAM_ID"))
IDl_PATH = Path("target/idl/summit_content_engine.json")
CONFIG_PUBKEY = PublicKey(os.getenv("CONFIG_PUBKEY"))
INTERVAL_SECONDS = int(os.getenv("KEEPER_INTERVAL", "30"))

# Provide keeper keypair in base58/json
KEEPER_KEYPAIR_PATH = os.getenv("KEEPER_KEYPAIR", "~/.config/solana/id.json")

with open(IDl_PATH) as f:
    idl = Idl.from_json(f.read())

async def pick_winner(content_accounts: List):
    # custom off-chain policy; simple argmax score by up-vs-down
    best = None
    best_score = -10**18
    best_idx = None
    for i, acc in enumerate(content_accounts):
        s = acc["upvotes"] - acc["downvotes"]
        if s > best_score:
            best_score = s
            best = acc
            best_idx = i
    return best_idx

async def load_tracking_config():
    # env JSON: {"summits":[{"id":1,"content_accounts":["...","..."]}, ...]}
    return json.loads(os.getenv("SUMMIT_TRACKING_JSON", "{}"))

async def run():
    payer = Wallet.local()
    conn = AsyncClient(RPC_URL)
    provider = Provider(conn, payer, opts=None)
    program = Program(idl, PROGRAM_ID, provider)

    tracking = await load_tracking_config()
    summits = tracking.get("summits", [])

    while True:
        for entry in summits:
            summit_id = entry["id"]
            summit_pda = PublicKey(entry["summit"])  # prederived in config for speed

            summit = await program.account["Summit"].fetch(summit_pda)
            if summit.is_finalized:
                continue

            if summit.voting_end_ts > int(__import__("time").time()):
                continue

            winner_index = await pick_winner(entry["contents"])
            if winner_index is None:
                continue

            winner_content = PublicKey(entry["contents"][winner_index])

            tx = await program.rpc["finalize_summit"](
                summit_id,
                winner_index,
                {
                    "accounts": {
                        "config": CONFIG_PUBKEY,
                        "summit": summit_pda,
                        "winnerContent": winner_content,
                        "winnerProfile": PublicKey(f"FIXME_{winner_content}"),  # derive in prod
                        "keeper": provider.wallet.public_key,
                        "systemProgram": SYS_ID,
                    }
                },
            )
            print("Finalized summit", summit_id, "tx:", tx)

        await asyncio.sleep(INTERVAL_SECONDS)

if __name__ == "__main__":
    asyncio.run(run())