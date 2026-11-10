# Service fee key

The optional USD 200 service fee ([docs/API.md](../../docs/API.md#service-fee)) is paid to the P2WPKH address of an AWS KMS key. An administrator creates that key once per account and region with `key.py`. The app stack only reads its public key ([terraform/README.md](../../terraform/README.md#service-fee-key)).

The key:

- is `ECC_SECG_P256K1` with `SIGN_VERIFY`, aliased `alias/qsb/service-fee`;
- keeps its private half in KMS. It can't be exported, so **the fee address's funds exist only as long as the key does**: don't disable or delete it while the address holds anything;
- has a key policy that lets the account manage it through IAM, except signing and scheduling its deletion. Deleting it first takes a key policy change;
- lets only the signer principals named at creation sign (`aws:PrincipalArn`), and only a digest with `ECDSA_SHA_256`. That's what a Bitcoin sighash is, and what the [sweep](../../docs/OPERATIONAL-RUNBOOK.md#service-fee) uses. Signing is granted to the account and limited to those principals, so each signer also needs its own IAM grant (below). The policy doesn't test `aws:MultiFactorAuthPresent`, which sessions from IAM Identity Center don't carry: MFA comes from Identity Center's sign-in, which the administrator keeps "always-on".

## Create it

As the administrator, in the stack's account and region. Name each IAM role that may move the fee funds with `--signer` (roles only: no IAM user's access keys). In this account that's the Identity Center permission set's role; its name has a random suffix, so match it with a trailing `*` on the reserved path, as `qsb-operator`'s trust does ([ops/github-aws](../github-aws/README.md#human-access-without-root)). `qsb-operator` itself is a poor signer: everyone who deploys has it.

```sh
python3 ops/service-fee-key/key.py --profile <admin> --account <id> --region eu-west-2 \
  --signer 'arn:aws:iam::<id>:role/aws-reserved/sso.amazonaws.com/eu-west-2/AWSReservedSSO_<permission set>_*'
```

That prints the key policy and plans only. Review it, then run it again with `--apply`. It refuses if the alias already exists, and prints the key's ARN and `signerGrant`: the statement (`kms:Sign` and `kms:GetPublicKey` on this key) to add to each signer's IAM policy, for Identity Center the permission set's inline policy. Until that's added, the signer can't sign. To change the signers later, edit the key policy as the administrator. If `create-alias` fails after the key is created, delete the stray key (it holds nothing) before running again.

## Checks

`python3 ops/service-fee-key/test_key.py` checks the policy offline: only the named signers sign, and only digests; account management can't sign or delete the key.
