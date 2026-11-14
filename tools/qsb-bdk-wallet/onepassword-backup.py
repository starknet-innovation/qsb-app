#!/usr/bin/env python3
"""Generate/save a recovery password in 1Password; pipe it directly to Rust.

Never prints or writes the password. Wallet seed/backup stays on this machine.
The generated password is fetched back from 1Password before backup validation.
"""
import json
import os
from pathlib import Path
import subprocess
import sys


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1]} failed; no automatic retry")
    return result.stdout


def main():
    if len(sys.argv) != 4:
        raise RuntimeError("Usage: onepassword-backup.py <binary> <wallet-directory> <vault-ID>")
    binary, directory, vault = sys.argv[1:]
    directory = Path(directory)
    if not Path(binary).is_absolute() or not directory.is_absolute():
        raise RuntimeError("Use absolute local paths")
    if (directory / "recovery.age").exists():
        raise RuntimeError("Portable recovery backup already exists; refusing replacement")
    info = json.loads(run([binary, "info", str(directory)]))
    title = f"QSB PQB wallet recovery {info['address']}"
    # Reconcile an interrupted create by exact title; never generate a replacement.
    items = json.loads(run(["op", "item", "list", "--vault", vault, "--format", "json"]))
    matches = [item for item in items if item["title"] == title]
    if len(matches) > 1:
        raise RuntimeError("Ambiguous recovery items; reconcile manually")
    item = matches[0] if matches else json.loads(run([
        "op", "item", "create", "--vault", vault, "--category", "password",
        "--title", title, "--generate-password=letters,digits,symbols,48", "--format", "json",
    ]))
    metadata = {"vaultId": vault, "itemId": item["id"], "title": title}
    receipt = directory / "recovery-1password.json"
    if not receipt.exists():
        with os.fdopen(os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
            json.dump(metadata, file); file.flush(); os.fsync(file.fileno())
    elif json.loads(receipt.read_text()) != metadata:
        raise RuntimeError("Recovery item identity mismatch")
    # stdout from op is confined to this process and the child's stdin pipe.
    password = run(["op", "read", f"op://{vault}/{item['id']}/password", "--no-newline"])
    if len(password) != 48:
        raise RuntimeError("Unexpected generated password length")
    message = run([binary, "backup-stdin", str(directory)], input=password)
    del password
    print(message.decode().strip())
    print(json.dumps(metadata))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not render subprocess output, JSON contents or secret input.
        print(f"Backup failed ({type(error).__name__}); no password displayed.", file=sys.stderr)
        sys.exit(1)
