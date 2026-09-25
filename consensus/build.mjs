#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? "native");
mkdirSync(out, { recursive: true });
// Official release checksum is an upstream artifact identity, never a self hash.
const hash = "154c9b9e6e17136edc8f20fda5d252fb339e727e4a85ef49e7d8facb9085f2d3";
const work = mkdtempSync(path.join(tmpdir(), "qsb-core-build-"));
try {
  copyFileSync(path.join(root, "verify.cpp"), path.join(work, "verify.cpp"));
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform=linux/arm64",
      "-e",
      `QSB_BUILD_OWNER=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-v",
      `${work}:/work`,
      "-w",
      "/work",
      "public.ecr.aws/amazonlinux/amazonlinux:2023",
      "bash",
      "-euc",
      `
 # Bind-mounted files must remain removable by the invoking Linux user,
 # including when compilation or download fails. This mount is our fresh temp dir.
 trap 'chown -R -- "$QSB_BUILD_OWNER" /work' EXIT
 dnf install -y gcc-c++ libstdc++-static tar gzip curl-minimal
 curl --fail --location --retry 2 https://bitcoincore.org/bin/bitcoin-core-27.2/bitcoin-27.2-aarch64-linux-gnu.tar.gz -o core.tar.gz
 echo '${hash}  core.tar.gz' | sha256sum -c -
 tar -xzf core.tar.gz
 g++ -O2 -std=c++17 -static-libstdc++ -static-libgcc -I bitcoin-27.2/include verify.cpp -L bitcoin-27.2/lib -lbitcoinconsensus -Wl,-rpath,'$ORIGIN' -o qsb-consensus
 cp -L bitcoin-27.2/lib/libbitcoinconsensus.so.0 .
 ldd ./qsb-consensus
 `,
    ],
    { stdio: "inherit" },
  );
  for (const name of ["qsb-consensus", "libbitcoinconsensus.so.0"])
    copyFileSync(path.join(work, name), path.join(out, name));
} finally {
  rmSync(work, { recursive: true, force: true });
}
