#!/usr/bin/env node
// The `qsb` command: `npm run qsb` in this repository, and the package's bin.
// A separate entry so cli.ts stays a module the tests import without running it.
import { runCli } from "./cli";

runCli(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: Boolean(process.stdin.isTTY),
  // npm runs scripts from the package root; paths are relative to where `npm run qsb` was typed.
  cwd: process.env.INIT_CWD ?? process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
