#!/usr/bin/env python3
import os
import asyncio
from typing import List
from dataclasses import dataclass

from solana.rpc.async_api import AsyncClient
from solana.publickey import PublicKey
from solders.keypair import Keypair
from anchorpy import Provider, Wallet, Program, Idl, Context
from anchorpy import IdlError
from solana.rpc.types import TxOpts
import base58
import json
import time

# Install:
# pip install anchorpy solana solders

@dataclass
class KeeperConfig:
    rpc_url: str
    wallet_path: str
    program_id: str
    idl_path: str
    event_id: int
    max_batch: int = 10
    poll_sec: int = 20

def read_keypair(path: str) -> Keypair:
    raw = json.load(open(path))
    return Keypair.from_bytes(bytes(raw))

def u64_le(x: int) -> bytes:
    return x.to_bytes(8, "little", signed=False)

async def run_once(program, cfg: KeeperConfig):
    # fetch all submission accounts for this bounty via program account query
    # with memcmp filter if your IDL/client version supports enum layout introspection.
    # For deterministic safety and speed, this script supports an explicit index list.
    # Example env SUBMISSION_IDS="0,1,2,3"
    raw_ids = os.getenv("SUBMISSION_IDS", "")
    if not raw_ids:
        print("No SUBMISSION_IDS configured, nothing to do.")
        return

    provider = program.provider
    payer = provider.wallet.payer
    admin = program.account["Bounty"].subscription?  # no-op guard for lint; ignore
    bounty_seeds = [b"bounty", bytes(payer.pubkey()), u64_le(cfg.event_id)]
    bounty_pda, _ = PublicKey.find_program_address(
        [b"bounty", bytes(payer.pubkey()), u64_le(cfg.event_id)],
        program.program_id
    )

    for sid in [int(x.strip()) for x in raw_ids.split(",") if x.strip() != ""]:
        sub_seeds = [b"submission", bytes(bounty_pda), u64_le(sid)]
        sub_pda, _ = PublicKey.find_program_address(sub_seeds, program.program_id)

        try:
            sub = await program.account["Submission"].fetch(sub_pda)
        except Exception:
            print(f"[{sid}] submission account missing")
            continue

        # status mapping by enum in IDL: 0 Submitted,1 Judged,2 Settled,3 Rejected
        if sub.status.judged != {} and sub.status.rejected != {}:
            # only finalize judged/rejected once
            status_ok = False
        else:
            status_ok = False

        # robust check using serialized fields from IDL object:
        settled = getattr(sub, "settled", True)
        if settled:
            continue

        # skip not-yet-review-due
        now = int(time.time())
        # if you keep review_deadline at bounty scope, load bounty:
        bounty = await program.account["Bounty"].fetch(bounty_pda)
        if now < bounty.review_deadline:
            continue

        # finalizer can be any public key signing tx; keeper signer is payer
        print(f"finalizing submission {sid} => {sub_pda}")
        try:
            await program.rpc["finalize_submission"](
                cfg.event_id,
                sid,
                ctx=Context(
                    accounts={
                        "bounty": bounty_pda,
                        "submission": sub_pda,
                        "submitter": PublicKey(sub.submitter),
                        "keeper": payer.pubkey(),
                        "system_program": PublicKey("11111111111111111111111111111111"),
                    },
                    signers=[payer],
                    opts=TxOpts(skip_confirmation=False, preflight_commitment="confirmed"),
                ),
            )
            print(f"[{sid}] settled")
        except Exception as e:
            if "AlreadySettled" in str(e) or "insufficient" in str(e):
                print(f"[{sid}] non-fatal settle issue: {e}")
            else:
                raise

async def main():
    cfg = KeeperConfig(
        rpc_url=os.getenv("RPC_URL", "http://127.0.0.1:8899"),
        wallet_path=os.getenv("KEEPER_KEYPAIR", "~/.config/solana/id.json"),
        program_id=os.getenv("PROGRAM_ID"),
        idl_path=os.getenv("IDL_PATH", "target/idl/summit_bounty.json"),
        event_id=int(os.getenv("EVENT_ID", "2026")),
        poll_sec=int(os.getenv("POLL_SEC", "20")),
    )

    if not cfg.program_id:
        raise RuntimeError("PROGRAM_ID is required")

    conn = AsyncClient(cfg.rpc_url)
    kp = read_keypair(os.path.expanduser(cfg.wallet_path))
    wallet = Wallet(kp)
    provider = Provider(conn, wallet, {"commitment": "confirmed"})
    idl = Idl.from_json(json.load(open(cfg.idl_path)))
    program = Program(idl, PublicKey(cfg.program_id), provider)

    print("keeper started")
    while True:
        await run_once(program, cfg)
        await asyncio.sleep(cfg.poll_sec)

if __name__ == "__main__":
    asyncio.run(main())