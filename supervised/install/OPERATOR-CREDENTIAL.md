# Operator-owned encrypted credential provisioning

The operator provisions the real Runpod key privately on the installed Linux host. Do not send the key to an assistant, put it in shell history, or include it in Terraform, SSM command parameters, user data, SQS, or a repository. Installation validation uses a public dummy marker and does not enroll a real provider credential.

Start the stopped validation instance, connect through an approved private operator session, and obtain a root shell. Provision the credential interactively on that host:

```sh
sudo -i
set +x
set -o pipefail
umask 077
install -d -m 0700 /etc/credstore.encrypted
test ! -e /etc/credstore.encrypted/qsb-runpod-api &&
  systemd-ask-password 'Runpod API key (input hidden):' |
  tr -d '\n' |
  systemd-creds encrypt --with-key=host --name=runpod_api - /etc/credstore.encrypted/qsb-runpod-api
```

The prompt reads the value without putting it in command arguments. The pipeline removes the prompt's terminating newline. Do not run this under shell tracing or session tooling that captures secret input. Do not decrypt, print, or return the encrypted file. A failed or interrupted enrollment needs operator reconciliation before retrying; this procedure refuses to replace an existing path.

Report only that provisioning succeeded. The encrypted file is bound to this host's systemd host key; treat the host key, root volume and snapshots as sensitive. Root on the host can use the credential. This is protection for storage and handoff, not protection against a compromised root user.

Do **not** start dispatch merely because provisioning succeeded. The installed host intentionally has execution disabled. Queue/table/registry enrollment, exact release identity, transaction authorization and the protected host configuration must be established first. For a future disposable test endpoint, enroll its actual creation identity and deadline (at most 30 minutes) in the protected watchdog configuration, start its independent watchdog service and verify the nonce/socket response before permitting paid work. Existing completed proof endpoints must remain disabled.
