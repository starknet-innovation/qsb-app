// A port of pqb/_research/l1sim.py: a tagged mini-interpreter over the EMITTED script bytes.
// The spender uses it to resolve each selection index by executing the script (depths come from
// the script, not from a second model of it). Signature opcodes run permissively (stack effect
// only); a consensus oracle does the real checking.
import { scriptnumBytes } from './l1gen.js';
import { Bytes, equal, hash160, hash256, ripemd160, sha1, sha256 } from './primitives.js';
import { Token } from './tx.js';

export class ScriptError extends Error {}

export class Item {
  constructor(public data: Bytes, public origin = '?', public taint = false) {}
  copy(taint?: boolean) { return new Item(this.data, this.origin, taint ?? this.taint); }
}

export function scriptnumVal(b: Bytes, maxsize = 4): number {
  if (b.length > maxsize) throw new ScriptError('UNKNOWN_ERROR (CScriptNum overflow)');
  if (b.length === 0) return 0;
  let v = 0;
  for (let i = b.length - 1; i >= 0; i--) v = v * 256 + b[i];
  if (b[b.length - 1] & 0x80) v = -(v - 0x80 * 2 ** (8 * (b.length - 1)));
  return v;
}

function castToBool(v: Bytes): boolean {
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== 0) return !(i === v.length - 1 && v[i] === 0x80);
  }
  return false;
}

type MinResolver = (sim: Sim, pc: number, idx: Item, cap: number) => void;
type RollResolver = (sim: Sim, idx: Item) => void;

export class Sim {
  st: Item[];
  i = 0;
  nops = 0;
  peak: number;
  cond: boolean[] = [];
  resolved = new Map<string, number>();
  fetches: { taint: boolean; pos: number }[] = [];

  constructor(public tok: Token[], stack: Item[], public resolver: MinResolver | null = null,
    public rollResolver: RollResolver | null = null) {
    this.st = [...stack];
    this.peak = this.st.length;
  }

  private pop(): Item {
    const v = this.st.pop();
    if (!v) throw new ScriptError('INVALID_STACK_OPERATION');
    return v;
  }

  run() { while (this.i < this.tok.length) this.step(); }

  step() {
    const [pc, op, data] = this.tok[this.i++];
    const st = this.st;
    if (op === 0x63 || op === 0x64 || op === 0x67 || op === 0x68) {
      this.nops++;
      const fExec = this.cond.every(Boolean);
      if (op === 0x63 || op === 0x64) {
        let v = false;
        if (fExec) {
          if (!st.length) throw new ScriptError('UNBALANCED_CONDITIONAL');
          v = castToBool(this.pop().data);
          if (op === 0x64) v = !v;
        }
        this.cond.push(v);
      } else if (op === 0x67) {
        if (!this.cond.length) throw new ScriptError('UNBALANCED_CONDITIONAL');
        this.cond[this.cond.length - 1] = !this.cond[this.cond.length - 1];
      } else {
        if (!this.cond.length) throw new ScriptError('UNBALANCED_CONDITIONAL');
        this.cond.pop();
      }
      this.peak = Math.max(this.peak, st.length);
      return;
    }
    if (this.cond.length && !this.cond.every(Boolean)) {
      if (!(op <= 0x4e && data !== null) && !(op >= 0x51 && op <= 0x60) && op !== 0x4f) this.nops++;
      return;
    }
    if (op <= 0x4e && data !== null) st.push(new Item(data, `script@${pc}`));
    else if (op === 0x4f) st.push(new Item(Uint8Array.of(0x81), `script@${pc}`));
    else if (op >= 0x51 && op <= 0x60) st.push(new Item(scriptnumBytes(op - 0x50), `script@${pc}`));
    else {
      this.nops++;
      this.exec(pc, op);
    }
    this.peak = Math.max(this.peak, st.length);
  }

  private exec(pc: number, op: number) {
    const st = this.st;
    const need = (k: number) => { if (st.length < k) throw new ScriptError('INVALID_STACK_OPERATION'); };
    switch (op) {
      case 0x61: return;
      case 0x69: if (!castToBool(this.pop().data)) throw new ScriptError('VERIFY'); return;
      case 0x75: this.pop(); return;
      case 0x6d: this.pop(); this.pop(); return;
      case 0x6e: need(2); st.push(st[st.length - 2].copy(), st[st.length - 1].copy()); return;
      case 0x76: need(1); st.push(st[st.length - 1].copy()); return;
      case 0x77: need(2); st.splice(st.length - 2, 1); return;
      case 0x78: need(2); st.push(st[st.length - 2].copy()); return;
      case 0x7c: need(2); [st[st.length - 1], st[st.length - 2]] = [st[st.length - 2], st[st.length - 1]]; return;
      case 0x7d: need(2); st.splice(st.length - 2, 0, st[st.length - 1].copy()); return;
      case 0x7b: {
        need(3);
        const n = st.length;
        [st[n - 3], st[n - 2], st[n - 1]] = [st[n - 2], st[n - 1], st[n - 3]];
        return;
      }
      case 0x79: case 0x7a: {
        need(2);
        const idx = this.pop();
        if (this.rollResolver) this.rollResolver(this, idx);
        const n = scriptnumVal(idx.data);
        if (n < 0 || n >= st.length) throw new ScriptError('INVALID_STACK_OPERATION');
        const pos = st.length - 1 - n;
        const v = st[pos];
        this.fetches.push({ taint: idx.taint, pos });
        if (op === 0x7a) { st.splice(pos, 1); st.push(v); } else st.push(v.copy());
        return;
      }
      case 0xa3: case 0xa4: case 0x93: case 0x94: {
        need(2);
        const bIt = st[st.length - 1];
        const aIt = st[st.length - 2];
        if (op === 0xa3 && this.resolver && aIt.origin.startsWith('sigslot:') &&
          !this.resolved.has(aIt.origin.slice(8))) {
          this.resolver(this, pc, aIt, scriptnumVal(bIt.data));
        }
        const b = scriptnumVal(st[st.length - 1].data);
        const a = scriptnumVal(st[st.length - 2].data);
        const taint = st[st.length - 1].taint || st[st.length - 2].taint;
        st.pop(); st.pop();
        const r = op === 0xa3 ? Math.min(a, b) : op === 0xa4 ? Math.max(a, b) : op === 0x93 ? a + b : a - b;
        st.push(new Item(scriptnumBytes(r), `computed@${pc}`, op === 0xa3 ? true : taint));
        return;
      }
      case 0x74: st.push(new Item(scriptnumBytes(st.length), `computed@${pc}`)); return;
      case 0x82: need(1); st.push(new Item(scriptnumBytes(st[st.length - 1].data.length), `computed@${pc}`)); return;
      case 0x87: case 0x88: {
        const a = this.pop(); const b = this.pop();
        const eq = equal(a.data, b.data);
        if (op === 0x88) { if (!eq) throw new ScriptError('EQUALVERIFY'); }
        else st.push(new Item(eq ? Uint8Array.of(1) : new Uint8Array(0), `computed@${pc}`));
        return;
      }
      case 0xa6: case 0xa7: case 0xa8: case 0xa9: case 0xaa: {
        need(1);
        const f = { 0xa6: ripemd160, 0xa7: sha1, 0xa8: sha256, 0xa9: hash160, 0xaa: hash256 }[op]!;
        const top = st[st.length - 1];
        st[st.length - 1] = new Item(f(top.data), `computed@${pc}`, top.taint);
        return;
      }
      case 0xac: case 0xad: {
        this.pop(); this.pop();
        if (op === 0xac) st.push(new Item(Uint8Array.of(1), `computed@${pc}`));
        return;
      }
      case 0xae: case 0xaf: {
        const nk = scriptnumVal(st[st.length - 1].data);
        const ns = scriptnumVal(st[st.length - (2 + nk)].data);
        st.splice(st.length - (3 + nk + ns), 3 + nk + ns);
        this.nops += nk;
        if (op === 0xae) st.push(new Item(Uint8Array.of(1), `computed@${pc}`));
        return;
      }
      default: throw new ScriptError(`unimplemented opcode 0x${op.toString(16)} at ${pc}`);
    }
  }
}

function uniqueTarget(sim: Sim, want: Bytes, slot: string): number {
  const hits: number[] = [];
  sim.st.forEach((it, k) => { if (equal(it.data, want) && it.origin.startsWith('script@')) hits.push(k); });
  if (hits.length !== 1) throw new ScriptError(`resolver: ${slot} -> ${hits.length} candidate targets (want exactly 1)`);
  return hits[0];
}

/** Resolution at an OP_MIN clamp (the gates): probe index -> fetched position on a sandbox. */
export function makeResolver(targets: Map<string, Bytes>): MinResolver {
  return (sim, _pc, idx) => {
    const slot = idx.origin.slice(8);
    const want = targets.get(slot);
    if (!want) return;
    const pos = uniqueTarget(sim, want, slot);
    const probe = (value: number): number | null => {
      const sb = new Sim(sim.tok, []);
      sb.st = sim.st.map((it) => (it === idx ? new Item(scriptnumBytes(value), it.origin, it.taint) : it));
      sb.i = sim.i - 1;
      for (let n = 0; n < 24; n++) {
        if (sb.i >= sb.tok.length) return null;
        try { sb.step(); } catch (e) { if (e instanceof ScriptError) return null; throw e; }
        const f = sb.fetches.find((x) => x.taint);
        if (f) return f.pos;
      }
      return null;
    };
    const p0 = probe(0);
    const p1 = probe(1);
    if (p0 === null || p1 === null) throw new ScriptError('resolver: probe found no tainted fetch');
    if (p1 - p0 !== -1) throw new ScriptError(`resolver: unexpected slope ${p1 - p0}`);
    const v = p0 - pos;
    sim.resolved.set(slot, v);
    idx.data = scriptnumBytes(v);
  };
}

/** Resolution at the OP_ROLL itself (the depth-guarded build has no OP_MIN to hook). */
export function makeRollResolver(targets: Map<string, Bytes>): RollResolver {
  return (sim, idx) => {
    if (!idx.origin.startsWith('sigslot:')) return;
    const slot = idx.origin.slice(8);
    const want = targets.get(slot);
    if (!want) return;
    const known = sim.resolved.get(slot);
    if (known !== undefined) { idx.data = scriptnumBytes(known); return; }
    const v = sim.st.length - 1 - uniqueTarget(sim, want, slot);
    sim.resolved.set(slot, v);
    idx.data = scriptnumBytes(v);
  };
}
