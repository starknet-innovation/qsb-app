"""Read and freeze an administrator-created subnet for the isolated validation pool only."""
import copy

SUBNET_FIELDS = ('SubnetId', 'VpcId', 'AvailabilityZone', 'AvailabilityZoneId', 'CidrBlock', 'State', 'MapPublicIpOnLaunch')
REQUIRED_TAGS = {'Project': 'qsb', 'PqbValidation': 'public-serving'}


def validate_binding(value, original_subnets, region):
    if set(value) != {'subnets', 'selected', 'routeTable', 'acl'}:
        raise RuntimeError('Invalid validation network binding')
    rows = value['subnets']; selected = value['selected']
    ids = [s['SubnetId'] for s in rows]
    if len(ids) != len(set(ids)) or set(ids) != set(original_subnets) | {selected} or selected in original_subnets:
        raise RuntimeError('Require exactly one additional validation subnet')
    target = next(s for s in rows if s['SubnetId'] == selected)
    if (len({s['VpcId'] for s in rows}) != 1 or any(s['State'] != 'available' for s in rows)
        or not target['MapPublicIpOnLaunch'] or target['AvailabilityZone'][:-1] != region
        or target['AvailabilityZone'] in {s['AvailabilityZone'] for s in rows if s['SubnetId'] != selected}
        or any(target['tags'].get(k) != v for k, v in REQUIRED_TAGS.items())):
        raise RuntimeError('Require a tagged public validation subnet in a new zone of the existing VPC')
    rt = value['routeTable']; acl = value['acl']
    if rt['VpcId'] != target['VpcId'] or acl['VpcId'] != target['VpcId']:
        raise RuntimeError('Validation network crosses VPCs')
    internet = [r for r in rt['Routes'] if r.get('DestinationCidrBlock') == '0.0.0.0/0'
                and r.get('State') == 'active' and r.get('GatewayId', '').startswith('igw-')]
    if len(internet) != 1:
        raise RuntimeError('Require the existing active public internet route')


def capture(ec2, original_subnets, selected, region, instance_type, min_ips):
    if selected in original_subnets:
        raise RuntimeError('Select a new validation subnet; do not change production networking')
    response = ec2.describe_subnets(SubnetIds=[*original_subnets, selected])
    rows = response['Subnets']
    expected = set(original_subnets) | {selected}
    if response.get('NextToken') or len(rows) != len(expected) or {s['SubnetId'] for s in rows} != expected:
        raise RuntimeError('Incomplete validation subnet readback')
    target = next(s for s in rows if s['SubnetId'] == selected)
    if not isinstance(target.get('AvailableIpAddressCount'), int) or target['AvailableIpAddressCount'] < min_ips:
        raise RuntimeError('Insufficient validation subnet address capacity')
    vpc = target['VpcId']
    tables = [t for page in ec2.get_paginator('describe_route_tables').paginate(
        Filters=[{'Name': 'vpc-id', 'Values': [vpc]}]) for t in page['RouteTables']]
    acls = [a for page in ec2.get_paginator('describe_network_acls').paginate(
        Filters=[{'Name': 'vpc-id', 'Values': [vpc]}]) for a in page['NetworkAcls']]
    route_ids = set(); acl_ids = set()
    for subnet in rows:
        # Explicit associations are required; a main-table fallback is not a reviewed association.
        matches = [t for t in tables if any(a.get('SubnetId') == subnet['SubnetId']
            and a.get('AssociationState', {}).get('State') == 'associated' for a in t['Associations'])]
        filters = [a for a in acls if any(x.get('SubnetId') == subnet['SubnetId'] for x in a['Associations'])]
        if len(matches) != 1 or len(filters) != 1:
            raise RuntimeError('Require explicit route and ACL associations for every subnet')
        route_ids.add(matches[0]['RouteTableId']); acl_ids.add(filters[0]['NetworkAclId'])
    if len(route_ids) != 1 or len(acl_ids) != 1:
        raise RuntimeError('Validation subnet must share the production route table and network ACL')
    table = next(t for t in tables if t['RouteTableId'] in route_ids)
    acl = next(a for a in acls if a['NetworkAclId'] in acl_ids)
    offering = [o for page in ec2.get_paginator('describe_instance_type_offerings').paginate(
        LocationType='availability-zone', Filters=[{'Name': 'instance-type', 'Values': [instance_type]},
        {'Name': 'location', 'Values': [target['AvailabilityZone']]}]) for o in page['InstanceTypeOfferings']]
    if not any(o['InstanceType'] == instance_type and o['Location'] == target['AvailabilityZone'] for o in offering):
        raise RuntimeError('The validation GPU instance type is not offered in the selected zone')
    # Omit free-IP counts and response metadata: allocation changes those, not the network identity.
    value = {'selected': selected, 'subnets': sorted([{**{k: s[k] for k in SUBNET_FIELDS},
        'tags': dict(sorted((t['Key'], t['Value']) for t in s.get('Tags', [])))} for s in rows], key=lambda s: s['SubnetId']),
        'routeTable': {k: copy.deepcopy(table[k]) for k in ('RouteTableId', 'VpcId', 'Routes')},
        'acl': {k: copy.deepcopy(acl[k]) for k in ('NetworkAclId', 'VpcId', 'Entries')}}
    value['routeTable']['Routes'].sort(key=lambda r: str(sorted(r.items())))
    value['acl']['Entries'].sort(key=lambda r: (r['Egress'], r['RuleNumber']))
    validate_binding(value, original_subnets, region)
    return value
