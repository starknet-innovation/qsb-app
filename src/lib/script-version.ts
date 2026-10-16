/** Config-A script identity is derived from exact reconstruction, never from a label.
 * This independent stack model also checks every push and OP_ROLL operand. */
export const LEGACY_SCRIPT_VERSION = 'qsb-config-a-legacy-v1' as const;
export const CURRENT_SCRIPT_VERSION = 'qsb-config-a-cmsverify-v1' as const;
export const CORRECTED_GENERATOR_COMMIT = 'b22f81c093488d09b9cd59c171c79b6c40812cf1';
export const LEGACY_GENERATOR_COMMIT = '2c9172051d5c150ef0a994ca6b988a08a3ef9e85';
export type ScriptVersion = typeof LEGACY_SCRIPT_VERSION | typeof CURRENT_SCRIPT_VERSION;
export function reconstructConfigAScript(value: unknown, version: ScriptVersion): string {
    const s = value as Record<string, any>;
    if (!s || s.config !== 'A' || s.hash_mode !== 'sha256' || s.n !== 150 ||
        s.t1s !== 8 || s.t1b !== 1 || s.t2s !== 7 || s.t2b !== 2 ||
        !Array.isArray(s.hors_commitments) || s.hors_commitments.length !== 2 ||
        !Array.isArray(s.dummy_sigs) || s.dummy_sigs.length !== 2 ||
        !Array.isArray(s.round_sigs) || s.round_sigs.length !== 2)
        throw Error('UnsupportedVaultScript');
    const out: number[] = [], stack: string[] = [];
    const op = (...xs: number[]) => out.push(...xs);
    const push = (h: unknown, length?: number) => {
        if (typeof h !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(h))
            throw Error('InvalidScriptData');
        const b = h.match(/../g)!.map(x => parseInt(x, 16));
        if ((length !== undefined && b.length !== length) || b.length > 75)
            throw Error('InvalidScriptData');
        op(b.length, ...b);
    };
    const num = (n: number) => {
        if (n === 0) {
            op(0);
            return;
        }
        if (n <= 16) {
            op(0x50 + n);
            return;
        }
        const b: number[] = [];
        for (let x = n; x > 0; x >>>= 8)
            b.push(x & 255);
        if (b[b.length - 1] & 128)
            b.push(0);
        op(b.length, ...b);
    };
    const pop = (n = 1) => { if (stack.length < n)
        throw Error('ScriptStackUnderflow'); stack.splice(-n, n); };
    const depth = (t: string) => { const i = stack.lastIndexOf(t); if (i < 0)
        throw Error('ScriptTokenMissing'); return stack.length - 1 - i; };
    const roll = (d: number) => stack.push(stack.splice(stack.length - 1 - d, 1)[0]);
    const token = (k: string, r: number, i?: number) => `${k}:${r}${i === undefined ? '' : ':' + i}`;
    for (const r of [1, 0]) {
        stack.push(token('kp', r), token('kn', r));
        for (let i = 8; i >= 0; i--)
            stack.push(token('pub', r, i));
        for (let i = (r === 0 ? 8 : 7) - 1; i >= 0; i--)
            stack.push(token('pre', r, i));
        for (let i = 8; i >= 0; i--)
            stack.push(token('idx', r, i));
    }
    push(s.pin_sig);
    op(0x78, 0xad, 0xa8, 0x7c, 0xad);
    for (const r of [0, 1]) {
        if (!Array.isArray(s.hors_commitments?.[r]) || s.hors_commitments[r].length !== 150 ||
            !Array.isArray(s.dummy_sigs?.[r]) || s.dummy_sigs[r].length !== 150)
            throw Error('InvalidScriptPool');
        for (let i = 149; i >= 0; i--) {
            push(s.hors_commitments[r][i], 20);
            stack.push(token('C', r, i));
        }
        for (let i = 149; i >= 0; i--) {
            push(s.dummy_sigs[r][i], 9);
            stack.push(token('D', r, i));
        }
        op(0);
        stack.push(token('zero', r));
        push(s.round_sigs?.[r]?.sig);
        stack.push(token('signonce', r));
        const signed = r === 0 ? 8 : 7;
        const san = () => Math.max(...stack.map((t, i) => t.startsWith(`D:${r}:`) ? stack.length - 1 - i : -1));
        for (let i = 0; i < 9; i++) {
            const A = depth(token('idx', r, i));
            roll(A);
            pop();
            stack.push(token('iv', r, i));
            const limit = san();
            if (i < signed) {
                stack.push(token('iv', r, i));
                pop();
                const dc = depth(token('C', r, i));
                roll(dc);
                const D = depth(token('pre', r, i));
                roll(D);
                pop(2);
                pop();
                const dd = depth(token('D', r, i));
                roll(dd);
                num(A);
                op(0x7a);
                num(limit);
                op(0xa3, 0x76);
                num(dc - dd);
                op(0x93, 0x7a);
                num(D);
                op(0x7a, 0xa9, 0x88, 0x7a);
            }
            else {
                pop();
                roll(depth(token('D', r, i)));
                num(A);
                op(0x7a);
                num(limit);
                op(0xa3, 0x7a);
            }
        }
        const pk = depth(token('kn', r));
        roll(pk);
        stack.push(token('kn', r));
        pop();
        stack.push(token('sp', r));
        const pp = depth(token('kp', r));
        roll(pp);
        pop(2);
        num(pk);
        op(0x7a, 0x76, 0xa8);
        num(pp);
        op(0x7a, 0xad);
        num(10);
        stack.push(token('M', r));
        for (const t of [token('kn', r), ...Array.from({ length: 9 }, (_, i) => token('pub', r, i))]) {
            const d = depth(t);
            roll(d);
            num(d);
            op(0x7a);
        }
        num(10);
        stack.push(token('N', r));
        const terminal = r === 1 || version === LEGACY_SCRIPT_VERSION;
        op(terminal ? 0xae : 0xaf);
        pop(23);
        if (terminal)
            stack.push(token('cms', r));
    }
    return out.map(x => x.toString(16).padStart(2, '0')).join('');
}
export function vaultScriptVersion(v: {
    scriptHex: string;
    publicStateJson: string;
}): ScriptVersion {
    const s = JSON.parse(v.publicStateJson);
    for (const version of [CURRENT_SCRIPT_VERSION, LEGACY_SCRIPT_VERSION]) {
        if (reconstructConfigAScript(s, version) === v.scriptHex.toLowerCase() && s.full_script_hex === v.scriptHex.toLowerCase()) {
            if (s.scriptVersion !== undefined && s.scriptVersion !== version)
                throw Error('VaultScriptVersionMismatch');
            return version;
        }
    }
    throw Error('UnsupportedVaultScript');
}
export function assertCurrentVaultScript(v: {
    scriptHex: string;
    publicStateJson: string;
}): void {
    if (vaultScriptVersion(v) !== CURRENT_SCRIPT_VERSION)
        throw Error('LegacyVaultRequiresMigration');
}
