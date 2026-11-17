#!/usr/bin/env python3
"""Create the optional service fee's AWS KMS key: ECC_SECG_P256K1, SIGN_VERIFY, alias alias/qsb/service-fee.

Requires an administrator profile. Plans by default; --apply creates the key and its alias. Never changes an
existing key: it stops if the alias already exists. The key material never leaves KMS and can't be exported, so
the fee address's funds exist only as long as this key does.
"""
import argparse
import json
import re
import subprocess
import tempfile

ALIAS = 'alias/qsb/service-fee'
# Key management the account delegates to IAM. Not Sign, which only the named signers get, and not
# ScheduleKeyDeletion: deleting the key loses what the fee address holds, so it first takes a key policy change.
MANAGEMENT = [
    'kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:GetKeyRotationStatus', 'kms:GetPublicKey', 'kms:ListAliases',
    'kms:ListGrants', 'kms:ListKeyPolicies', 'kms:ListResourceTags', 'kms:PutKeyPolicy', 'kms:TagResource',
    'kms:UntagResource', 'kms:CreateAlias', 'kms:UpdateAlias', 'kms:DeleteAlias', 'kms:UpdateKeyDescription',
    'kms:EnableKey', 'kms:DisableKey', 'kms:CancelKeyDeletion',
]


SIGNING = ['kms:Sign', 'kms:GetPublicKey']


def signer_arns(account, signers):
    """Signer role ARNs in `account`; roles only, so a signer signs in through IAM Identity Center with MFA, not with
    an IAM user's access keys. A role may end in a wildcard, as an IAM Identity Center permission
    set's role does (arn:aws:iam::<id>:role/aws-reserved/sso.amazonaws.com/<region>/AWSReservedSSO_<set>_*)."""
    if not re.fullmatch(r'[0-9]{12}', account):
        raise SystemExit('The account is a 12-digit AWS account ID.')
    pattern = rf'arn:aws:iam::{account}:role/[A-Za-z0-9+=,.@_/-]+\*?'
    if not signers or any(not re.fullmatch(pattern, s) for s in signers):
        raise SystemExit(f'Name at least one signer: an IAM role ARN in account {account}.')
    return sorted(set(signers))


def policy(account, signers):
    """The key policy: the account manages the key through IAM; only `signers` may sign, and only a digest with
    ECDSA_SHA_256 (a Bitcoin sighash). Signing is granted to the account and limited by aws:PrincipalArn, so a
    signer also needs the IAM grant signer_grant() gives. MFA comes from how the signer signs in: IAM Identity
    Center enforces it at sign-in, and its sessions carry no aws:MultiFactorAuthPresent key to test."""
    arns = signer_arns(account, signers)
    root = {'AWS': f'arn:aws:iam::{account}:root'}
    return {
        'Version': '2012-10-17',
        'Statement': [
            {'Sid': 'KeyManagementThroughIam', 'Effect': 'Allow', 'Principal': root, 'Action': MANAGEMENT, 'Resource': '*'},
            # The only statement that allows Sign: an IAM grant can't widen it to another principal or input.
            {'Sid': 'SweepSigning', 'Effect': 'Allow', 'Principal': root, 'Action': 'kms:Sign', 'Resource': '*',
             'Condition': {'ArnLike': {'aws:PrincipalArn': arns},
                           'StringEquals': {'kms:SigningAlgorithm': 'ECDSA_SHA_256', 'kms:MessageType': 'DIGEST'}}},
        ],
    }


def signer_grant(key_arn):
    """The identity-side statement each signer needs, such as an Identity Center permission set's inline policy."""
    return {'Sid': 'ServiceFeeSweep', 'Effect': 'Allow', 'Action': SIGNING, 'Resource': key_arn}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile', required=True)
    p.add_argument('--account', required=True)
    p.add_argument('--region', required=True)
    p.add_argument('--signer', action='append', default=[],
                   help='IAM role ARN allowed to sign sweeps (repeat); it may end in *')
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    document = policy(a.account, a.signer)

    def aws(*args):
        out = subprocess.check_output(['aws', '--profile', a.profile, '--region', a.region, '--output', 'json', *args], text=True)
        return json.loads(out) if out.strip() else {}

    if aws('sts', 'get-caller-identity')['Account'] != a.account:
        raise SystemExit('Account mismatch')
    if any(x['AliasName'] == ALIAS for x in aws('kms', 'list-aliases')['Aliases']):
        raise SystemExit(f'{ALIAS} already exists; inspect it before changing anything')
    print(json.dumps({'alias': ALIAS, 'region': a.region, 'policy': document, 'apply': a.apply}, indent=2), flush=True)
    if not a.apply:
        return
    with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
        json.dump(document, f)
        f.flush()
        key = aws('kms', 'create-key', '--key-spec', 'ECC_SECG_P256K1', '--key-usage', 'SIGN_VERIFY',
                  '--description', 'QSB optional service fee: P2WPKH address key',
                  '--policy', f'file://{f.name}', '--tags', 'TagKey=Project,TagValue=qsb')['KeyMetadata']
    aws('kms', 'create-alias', '--alias-name', ALIAS, '--target-key-id', key['KeyId'])
    print(json.dumps({'keyArn': key['Arn'], 'alias': ALIAS, 'signerGrant': signer_grant(key['Arn'])}, indent=2))
    print('Next: add signerGrant to each signer\'s IAM policy (for Identity Center, its permission set), print the fee '
          'address with `npm run service-fee -- address`, then set service_fee_enabled = true.')


if __name__ == '__main__':
    main()
