# Locking-script compatibility

The browser/SDK generator and public CPU reference use the immutable upstream revision in `scripts/vendor.py`, with the reviewed adaptations in `scripts/patch_upstream.py`. `npm run vendor` regenerates both copies and the browser integrity manifest. Do not edit a generated Python copy independently.

`qsb-config-a-cmsverify-v1` is the Config A SHA-256 script format. Its first digest round ends in `OP_CHECKMULTISIGVERIFY`; the second ends in `OP_CHECKMULTISIG`. The shared stack model accounts for the absence of a first-round result when calculating second-round witness positions. Export derives both rounds from that same model, rather than concatenating independently built rounds.

`qsb-config-a-legacy-v1` identifies the previous two-plain-`OP_CHECKMULTISIG` layout. The first round's false result could remain buried under the second round's result. Existing funded outputs cannot change their locking script through a software update.

## Recovery and validation

Newly generated states include `scriptVersion`. Python validation reconstructs the complete script from public commitments and signatures, then compares exact bytes; a label cannot override that result. An unlabelled legacy backup can still be validated without changing its script or funding destination. Secret-to-commitment checks remain in the local backup validator. Legacy assembly and CPU search are rejected: migration needs a separately reviewed procedure and explicit transaction authorization.

The public CPU interface requires the corrected request `scriptVersion` and echoes it on export and verification responses. It rejects legacy or unknown scripts before exporting parameters. Script format is distinct from a solver release and from the rank partition version. A compatible release must be qualified and enrolled separately; these changes do not attest an existing GPU image.

## Regression evidence

Run `python3 tests/test_reference.py` after `npm run vendor`. Tests cover:

- Corrected first/second binding opcodes and changed second-round stack positions.
- Exact legacy backup reconstruction, no implicit migration, and rejection of false version labels.
- Exporter scriptCode and sighash agreement with whole-transaction `FindAndDelete` reconstruction for both rounds, multiple subset boundaries, sequence and locktime values.
- Required CPU request versions and response version binding.
- A synthetic replay regression with real ECDSA and HORS checks: honest witnesses pass both layouts; replaying round 1 from a different-payee transaction passes the legacy layout and fails corrected round 1.

The replay interpreter explicitly relaxes the three unsolved hash-to-DER puzzle checks. It is a focused component regression, not Bitcoin Core validation, a fresh full-search withdrawal, or a complete post-quantum security proof. Native GPU, final-image, fresh exact-transaction Core and external-miner validation remain separate gates.

## Admission and immutable releases

The TypeScript boundary independently reconstructs Config A from the public commitments with a shared stack model. This validates all pushes and stack-depth operands, not a raw byte search for an opcode. Python performs its own reconstruction during recovery, CPU export and assembly. The version label is checked against those bytes.

Registration and newly signed/submitted deposits accept only the corrected layout; deposits still do not pin a solver. Read-only legacy backup/configuration access remains available. Browser and SDK withdrawal assembly and server exact submission refuse legacy scripts before signing or miner submission. An existing submitted transaction can still be reconciled by its durable identity.

New withdrawal creation requires an enrolled schema-v4 descriptor containing `scriptVersion: qsb-config-a-cmsverify-v1` and the corrected generator commit. Old descriptors remain byte-identical and cannot authorize new corrected searches. Enrollment is an append-only publication step after qualification in qsb-solver: accepting the new schema does not attest, enroll or deploy a candidate image. Old jobs retain their recorded release and configuration hashes; they must never be silently migrated to a new release. Mainnet switches and exact-transaction authorization are unchanged.

## Migration rollout

Do not deploy this generator/CPU change with an old served descriptor. First qualify the companion corrected solver image, publish its immutable descriptor, and enroll it verbatim. Commit and review app, CPU artifact and solver selection together before activation. Inventory existing public vault/job records first; do not retrieve user recovery material. Legacy backups remain readable, but migration of a funded legacy output requires a separately reviewed exact-transaction procedure.

Coordinators pause incompatible work without changing its release, parameter hashes or completed coverage. Known provider IDs remain available for drain; unknown submission markers remain available for operator reconciliation. Attaching an old provider ID is not authorization to credit its result or start corrected work. Existing recovery intent and budget accounting remain in force.

Companion solver compatibility work: https://github.com/starknet-innovation/qsb-solver/pull/14. Native corrected-input GPU validation and an approved immutable descriptor remain prerequisites to enrollment.
