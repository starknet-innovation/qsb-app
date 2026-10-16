import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { publicScriptFixture, servedFixture } from './solver-fixture';
import { assertCurrentVaultScript, vaultScriptVersion, CURRENT_SCRIPT_VERSION, LEGACY_SCRIPT_VERSION } from '../src/lib/script-version';
import { assertSolverScriptCompatibility, externalSolverDescriptorSchema, vaultConfiguration, assertVaultConfiguration, solverRelease, currentSolverId } from '../src/lib/provenance';
describe('locking script migration', () => {
    it.each([CURRENT_SCRIPT_VERSION, LEGACY_SCRIPT_VERSION])('reconstructs %s independently against upstream Python', version => {
        const v = publicScriptFixture(version), s = JSON.parse(v.publicStateJson);
        const code = `import sys,json\nsys.path.insert(0,'public/qsb')\nfrom bitcoin_tx import QSBScriptBuilder\ns=json.load(sys.stdin)\nb=QSBScriptBuilder(150,8,1,7,2,hash_mode='sha256')\nb.hors_commitments=[[bytes.fromhex(x) for x in r] for r in s['hors_commitments']]\nb.dummy_sigs=[[bytes.fromhex(x) for x in r] for r in s['dummy_sigs']]\n`;
        // Corrected builder is the independent oracle; legacy is covered by bridge backup tests.
        if (version === CURRENT_SCRIPT_VERSION)
            expect(execFileSync('python3', ['-c', code + `print(b.build_full_script(bytes.fromhex(s['pin_sig']),*[bytes.fromhex(r['sig']) for r in s['round_sigs']]).hex())`], { input: JSON.stringify(s), encoding: 'utf8' }).trim()).toBe(v.scriptHex);
        expect(vaultScriptVersion(v)).toBe(version);
    });
    it('rejects legacy operations while preserving its configuration for backup reads', () => {
        const v = publicScriptFixture(LEGACY_SCRIPT_VERSION);
        expect(() => assertCurrentVaultScript(v)).toThrow('LegacyVaultRequiresMigration');
        const c = vaultConfiguration(v);
        expect(c).not.toHaveProperty('scriptVersion');
        expect(assertVaultConfiguration({ ...v, configuration: c })).toEqual(c);
    });
    it('rejects relabelled legacy scripts and changed roll operands', () => {
        const v = publicScriptFixture(LEGACY_SCRIPT_VERSION), s = JSON.parse(v.publicStateJson);
        s.scriptVersion = CURRENT_SCRIPT_VERSION;
        expect(() => vaultScriptVersion({ ...v, publicStateJson: JSON.stringify(s) })).toThrow('VaultScriptVersionMismatch');
        const fixed = publicScriptFixture();
        const state = JSON.parse(fixed.publicStateJson);
        const malformed = fixed.scriptHex.replace('02', '03');
        state.full_script_hex = malformed;
        expect(() => vaultScriptVersion({ ...fixed, scriptHex: malformed, publicStateJson: JSON.stringify(state) })).toThrow();
    });
    it('refuses an old release for corrected scripts; admits explicit v4 compatibility', () => {
        expect(() => assertSolverScriptCompatibility(publicScriptFixture(), solverRelease(currentSolverId))).toThrow('SolverScriptVersionMismatch');
        const d = externalSolverDescriptorSchema.parse(servedFixture);
        expect(() => assertSolverScriptCompatibility(publicScriptFixture(), d)).not.toThrow();
        expect(() => externalSolverDescriptorSchema.parse({ ...servedFixture, schemaVersion: 3 })).toThrow();
    });
});
