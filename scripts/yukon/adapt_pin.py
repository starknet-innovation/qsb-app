"""Isolated predicate/overflow repair for one pinned pinning candidate. No deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from validate import LOCK, check_source_lock, function

FLAGS = {name: 0 for name in (
    'QSB_C31', 'QSB_SHORT_CARRY', 'QSB_CARRY62', 'QSB_FIELD_SC',
    'QSB_SAS_Z9SUB_ALL', 'QSB_MUL_FOLD8_CUT', 'QSB_SQR_FOLD8_CUT', 'QSB_X3_TAIL')}


def replace(text, old, new, count=1):
    if text.count(old) != count:
        raise ValueError('Source context changed: ' + old[:70])
    return text.replace(old, new)


def body(text, name, replacement):
    # validate.function checks the expected scalar signature and braces.
    function(text, name)
    start = text.index('{', text.index(name + '('))
    end, depth = start + 1, 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}'); end += 1
    return text[:start] + '{\n' + replacement + '\n}' + text[end:]


def adapt(text):
    text = body(text, 'gpu_bench_valid', '    return qsb_der32(h);')
    text = body(text, 'gpu_bench_valid_words', '''    uint8_t digest[32];
    for (int i = 0; i < 8; ++i) {
        digest[4*i] = (uint8_t)(hs[i] >> 24);
        digest[4*i+1] = (uint8_t)(hs[i] >> 16);
        digest[4*i+2] = (uint8_t)(hs[i] >> 8);
        digest[4*i+3] = (uint8_t)hs[i];
    }
    return qsb_der32(digest);''')
    text = replace(text, 'ok = qsb_host_zeros(hh) >= QSB_ZEROS_N;', 'ok = qsb_der32(hh);')
    text = replace(text, 'if (count > 64) count = 64;', 'if (!qsb_require_hit_capacity(count)) return 2;')
    text = replace(text, 'int nh = (h_hit > 64) ? 64 : (int)h_hit;', 'if (!qsb_require_hit_capacity(h_hit)) return 2;\n            int nh = (int)h_hit;')
    text = replace(text, 'int nh = (h_hit > 64) ? 64 : h_hit;', 'if (!qsb_require_hit_capacity(h_hit)) return 2;\n                int nh = (int)h_hit;', 2)
    # Compile-time lock: command-line flags cannot silently re-enable shortcuts.
    prefix = '#include "qsb_pin_contract.h"\n'
    for name, value in FLAGS.items():
        prefix += f'#if defined({name}) && {name} != {value}\n#error "Unsafe override: {name}"\n#endif\n#ifndef {name}\n#define {name} {value}\n#endif\n'
    return prefix + text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    if args.out.exists(): raise ValueError('Use a new output; preserve prior builds')
    lock = json.loads(LOCK.read_text())
    data = {}
    for n in lock['sourceFiles']:
        p = args.source / n
        if p.is_symlink(): raise ValueError('Source symlink')
        data[n] = p.read_bytes()
    check_source_lock(data, lock)
    args.out.mkdir(parents=True)
    for n, raw in data.items():
        if not n.startswith('pinning/'): continue
        p=args.out/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
    source=args.out/'pinning/pinning.cu'
    source.write_text(adapt(source.read_text()))
    shutil.copyfile(Path(__file__).with_name('pin_contract.h'),args.out/'pinning/qsb_pin_contract.h')
    hashes={str(p.relative_to(args.out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.out.rglob('*')) if p.is_file()}
    receipt={'status':'HOLD','upstreamCommit':lock['commit'],'scope':'isolated-pinning-predicate-overflow-arithmetic-flags-v1','flags':FLAGS,'files':hashes,'completeArithmeticCertified':False,'boundedSchedulerCertified':False,'deploymentAllowed':False}
    (args.out/'adaptation.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'status':'HOLD','files':len(hashes),'disabledShortcuts':len(FLAGS)}))

if __name__=='__main__': main()
