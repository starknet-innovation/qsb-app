"""Validation subnet checks read metadata only and preserve existing production resources."""
import copy
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from validation_network import capture, validate_binding
from capacity import Capacity


def fixture():
    subnets = [{'SubnetId': name, 'VpcId': 'vpc-public', 'AvailabilityZone': zone, 'AvailabilityZoneId': zone + '-id',
        'CidrBlock': cidr, 'State': 'available', 'MapPublicIpOnLaunch': True, 'AvailableIpAddressCount': 251,
        'Tags': [{'Key': 'Project', 'Value': 'qsb'}, {'Key': 'PqbValidation', 'Value': 'public-serving'}]}
        for name, zone, cidr in [('subnet-base', 'eu-west-2a', '10.0.0.0/24'), ('subnet-test', 'eu-west-2c', '10.0.1.0/24')]]
    routes = [{'RouteTableId': 'rt-public', 'VpcId': 'vpc-public',
        'Routes': [{'DestinationCidrBlock': '0.0.0.0/0', 'GatewayId': 'igw-public', 'State': 'active'}],
        'Associations': [{'SubnetId': s['SubnetId'], 'AssociationState': {'State': 'associated'}} for s in subnets]}]
    acls = [{'NetworkAclId': 'acl-existing', 'VpcId': 'vpc-public',
        'Entries': [{'Egress': False, 'RuleNumber': 100, 'Protocol': '-1', 'RuleAction': 'allow', 'CidrBlock': '0.0.0.0/0'}],
        'Associations': [{'SubnetId': s['SubnetId']} for s in subnets]}]
    offered = [{'InstanceType': 'g5.xlarge', 'Location': 'eu-west-2c'}]
    ec2 = Mock(); ec2.describe_subnets.return_value = {'Subnets': subnets}
    pages = {'describe_route_tables': {'RouteTables': routes}, 'describe_network_acls': {'NetworkAcls': acls},
             'describe_instance_type_offerings': {'InstanceTypeOfferings': offered}}
    ec2.get_paginator.side_effect = lambda name: SimpleNamespace(paginate=lambda **kwargs: [pages[name]])
    return ec2, subnets, routes, acls, offered


def read(ec2, minimum=21):
    return capture(ec2, ['subnet-base'], 'subnet-test', 'eu-west-2', 'g5.xlarge', minimum)


class ValidationNetworkTests(unittest.TestCase):
    def test_existing_public_network_and_new_zone_are_bound_without_writes(self):
        ec2, *_ = fixture(); value = read(ec2)
        self.assertEqual(value['selected'], 'subnet-test')
        self.assertEqual(value['routeTable']['RouteTableId'], 'rt-public')
        self.assertEqual(value['acl']['NetworkAclId'], 'acl-existing')
        validate_binding(value, ['subnet-base'], 'eu-west-2')
        self.assertEqual({call[0] for call in ec2.method_calls}, {'describe_subnets', 'get_paginator'})

    def test_foreign_vpc_private_subnet_missing_tags_and_wrong_zone_fail_closed(self):
        for change in [lambda s: s.update(VpcId='vpc-foreign'), lambda s: s.update(MapPublicIpOnLaunch=False),
            lambda s: s.update(Tags=[]), lambda s: s.update(AvailabilityZone='eu-west-2a'),
            lambda s: s.update(AvailabilityZone='eu-west-1c'), lambda s: s.update(State='pending')]:
            ec2, subnets, *_ = fixture(); change(subnets[1])
            with self.assertRaises(RuntimeError): read(ec2)

    def test_extra_or_missing_subnet_rows_and_low_address_capacity_are_rejected(self):
        for action in [lambda rows: rows.pop(), lambda rows: rows.append(copy.deepcopy(rows[0])),
                       lambda rows: rows[1].update(AvailableIpAddressCount=20)]:
            ec2, subnets, *_ = fixture(); action(subnets)
            with self.assertRaises(RuntimeError): read(ec2)

    def test_only_explicit_shared_routes_acl_and_active_internet_gateway_are_allowed(self):
        for mutate in [lambda r, a: r[0]['Routes'][0].update(State='blackhole'),
            lambda r, a: r[0]['Routes'][0].update(GatewayId='nat-other'),
            lambda r, a: r[0]['Associations'][1].update(AssociationState={'State': 'associating'}),
            lambda r, a: r[0]['Associations'].pop(), lambda r, a: a[0]['Associations'].pop(),
            lambda r, a: r[0].update(VpcId='vpc-foreign'), lambda r, a: a[0].update(VpcId='vpc-foreign')]:
            ec2, _, routes, acls, _ = fixture(); mutate(routes, acls)
            with self.assertRaises(RuntimeError): read(ec2)

    def test_gpu_offering_is_required_but_does_not_claim_stock(self):
        ec2, _, _, _, offered = fixture(); offered.clear()
        with self.assertRaisesRegex(RuntimeError, 'not offered'): read(ec2)

    def test_own_allocations_do_not_change_frozen_network_identity(self):
        ec2, subnets, *_ = fixture(); frozen = read(ec2)
        subnets[1]['AvailableIpAddressCount'] = 5
        self.assertEqual(read(ec2, minimum=0), frozen)
        with self.assertRaisesRegex(RuntimeError, 'address capacity'): read(ec2)

    def test_retained_binding_cannot_select_a_production_or_foreign_subnet(self):
        ec2, *_ = fixture(); frozen = read(ec2)
        for selected in ['subnet-base', 'subnet-unknown']:
            value = copy.deepcopy(frozen); value['selected'] = selected
            with self.assertRaises(RuntimeError): validate_binding(value, ['subnet-base'], 'eu-west-2')

    def test_changed_network_blocks_lifecycle_before_cloud_mutation(self):
        pool = object.__new__(Capacity); pool.c = Mock(); pool.plan = {'validationNetwork': {'selected': 'subnet-test'}}
        pool.read_network = Mock(return_value={'different': True})
        pool.production_unchanged = Mock()
        with self.assertRaisesRegex(RuntimeError, 'changed since planning'): pool.create()
        pool.c.mutate.assert_not_called()


if __name__ == '__main__': unittest.main()
