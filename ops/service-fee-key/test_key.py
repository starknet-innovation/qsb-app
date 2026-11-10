"""Offline checks for the service fee key policy."""
import unittest

from key import MANAGEMENT, policy, signer_grant

SIGNER = 'arn:aws:iam::123456789012:role/qsb-service-fee-signer'
SSO = 'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/eu-west-2/AWSReservedSSO_QsbOperator_*'


class ServiceFeeKeyPolicy(unittest.TestCase):
    def statements(self, signers):
        return {s['Sid']: s for s in policy('123456789012', signers)['Statement']}

    def test_only_named_signers_sign_and_only_digests(self):
        statements = self.statements([SSO, SIGNER, SIGNER])
        self.assertEqual(set(statements), {'KeyManagementThroughIam', 'SweepSigning'})
        sign = statements['SweepSigning']
        self.assertEqual(sign['Principal'], {'AWS': 'arn:aws:iam::123456789012:root'})
        self.assertEqual(sign['Action'], 'kms:Sign')
        self.assertEqual(sign['Condition'], {
            'ArnLike': {'aws:PrincipalArn': [SSO, SIGNER]},
            'StringEquals': {'kms:SigningAlgorithm': 'ECDSA_SHA_256', 'kms:MessageType': 'DIGEST'},
        })
        # Sign appears in no other statement.
        self.assertEqual([s for s in statements.values() if 'kms:Sign' in str(s['Action'])], [sign])
        # No condition a session from IAM Identity Center can't satisfy.
        self.assertNotIn('MultiFactorAuthPresent', str(policy('123456789012', [SSO])))

    def test_account_management_never_signs_or_deletes(self):
        manage = self.statements([SIGNER])['KeyManagementThroughIam']
        self.assertEqual(manage['Principal'], {'AWS': 'arn:aws:iam::123456789012:root'})
        self.assertEqual(manage['Action'], MANAGEMENT)
        for action in manage['Action']:
            self.assertNotIn('*', action)
        self.assertNotIn('kms:Sign', MANAGEMENT)
        self.assertNotIn('kms:ScheduleKeyDeletion', MANAGEMENT)

    def test_signer_grant_is_the_key_only(self):
        arn = 'arn:aws:kms:eu-west-2:123456789012:key/k'
        self.assertEqual(signer_grant(arn), {'Sid': 'ServiceFeeSweep', 'Effect': 'Allow',
                                             'Action': ['kms:Sign', 'kms:GetPublicKey'], 'Resource': arn})

    def test_refuses_missing_or_foreign_signers(self):
        for signers in ([], ['arn:aws:iam::210987654321:role/x'], ['*'], ['arn:aws:iam::123456789012:root'],
                        ['arn:aws:iam::123456789012:role/*'], ['arn:aws:iam::123456789012:user/operator']):
            with self.assertRaises(SystemExit, msg=signers):
                policy('123456789012', signers)


if __name__ == '__main__':
    unittest.main()
