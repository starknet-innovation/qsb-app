"""Isolated predicate/overflow repair for one pinned pinning candidate. No deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from validate import LOCK, check_source_lock, function

FLAGS = {name: 0 for name in (
    'QSB_C31', 'QSB_SHORT_CARRY', 'QSB_CARRY62', 'QSB_FIELD_SC',
    'QSB_SAS_Z9SUB_ALL', 'QSB_MUL_FOLD8_CUT', 'QSB_SQR_FOLD8_CUT', 'QSB_X3_TAIL',
    'QSB_NEG_Y_MAC', 'QSB_PARITY_WINDOW')}


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
    # Replace only the locked host gate's recovery section; shared helper is
    # exercised directly with real OpenSSL and independent curve vectors.
    start = text.index('    BIGNUM *z = BN_bin2bn(d2, 32, NULL);', text.index('static int qsb_host_exact_hit('))
    end = text.index('    return ok;\n}', start) + len('    return ok;')
    text = text[:start] + '''    uint8_t hh[32];
    if (!qsb_recover_hash(d2, recid, grp, ctx, order, nri, Ru2, hh)) return 0;
    int ok = qsb_der32(hh);
    return ok;''' + text[end:]
    text = replace(text, 'if (sl > 119 || so + 3 >= sl || lo + 3 >= sl) return 0;',
        'qsb_require_host(sl >= 4 && sl <= 119 && so <= sl - 4 && lo <= sl - 4, "host suffix bounds");')
    text = replace(text, '    SHA256_Init(&sc);',
        '    qsb_require_host(SHA256_Init(&sc) == 1, "host SHA init");')
    text = replace(text, '    SHA256(d1, 32, d2);',
        '    qsb_require_host(SHA256(d1, 32, d2) != NULL, "host double SHA");')

    text = replace(text, 'if (count > 64) count = 64;', 'if (!qsb_require_hit_capacity(count)) return 2;')
    text = replace(text, 'int nh = (h_hit > 64) ? 64 : (int)h_hit;', 'if (!qsb_require_hit_capacity(h_hit)) return 2;\n            int nh = (int)h_hit;')
    text = replace(text, 'int nh = (h_hit > 64) ? 64 : h_hit;', 'if (!qsb_require_hit_capacity(h_hit)) return 2;\n                int nh = (int)h_hit;', 2)
    text = replace(text, 'mkdir("results", 0755);', 'qsb_make_results();', 2)
    text = replace(text, 'FILE *f = fopen(fname, "a");', 'FILE *f = qsb_open_hits(fname);', 2)
    text = replace(text, '                fclose(f);', '                qsb_close_hits(f);', 2)
    # Replace the benchmark CLI, including all easy/debug/sequence overrides.
    start = text.index('    if (argc < 2) {', text.index('int main('))
    end = text.index('    /* Use the specified GPU */', start)
    text = text[:start] + '''    qsb_pin_range range = {};
    uint64_t selected_gpu = 0;
    if (argc != 7 || !qsb_parse_decimal(argv[2], &selected_gpu) ||
        selected_gpu > 2147483647 ||
        !qsb_parse_decimal(argv[3], &range.sequence_start) ||
        !qsb_parse_decimal(argv[4], &range.sequence_count) ||
        !qsb_parse_decimal(argv[5], &range.locktime_start) ||
        !qsb_parse_decimal(argv[6], &range.locktime_count) ||
        !qsb_valid_range(&range)) {
        fprintf(stderr, "Expected: params gpu sequence_start sequence_count locktime_start locktime_count (decimal, aligned, bounded)\\n");
        return 2;
    }
    int gpu_index = (int)selected_gpu;
    int easy = 0, single_hash = 0;

''' + text[end:]
    start = text.index('    /* Safe ranges */')
    end = text.index('    printf("\\n  === Search:', start)
    text = text[:start] + '''    const uint32_t LT_MIN = (uint32_t)range.locktime_start;
    const uint64_t LT_MAX = range.locktime_start + range.locktime_count;
    const uint32_t SEQ_MIN = (uint32_t)range.sequence_start;
    const uint64_t lt_range = range.locktime_count;
    // One explicitly selected device owns the entire supplied range.
    const int num_gpus = 0, effective_id = 0, effective_total = 1;
''' + text[end:]
    text = replace(text, 'lt=[%u,%u] (%u)', 'lt=[%u,%llu) (%llu)')
    text = replace(text, 'LT_MIN, LT_MAX, lt_range, SEQ_MIN,',
                   'LT_MIN, (unsigned long long)LT_MAX, (unsigned long long)lt_range, SEQ_MIN,')
    text = replace(text, 'for (uint32_t seq = SEQ_MIN + effective_id; ; seq += effective_total) {',
        'for (uint64_t seq_offset = 0; seq_offset < range.sequence_count; ++seq_offset) {\n'
        '        const uint32_t seq = (uint32_t)(range.sequence_start + seq_offset);', 2)
    text = replace(text, 'for (uint32_t lt_off = 0; lt_off < lt_range; lt_off += BATCH) {',
        'for (uint64_t lt_off = 0; lt_off < lt_range; lt_off += BATCH) {', 2)
    text = replace(text, 'int batch_sz = (lt_off + BATCH <= lt_range) ? BATCH : (lt_range - lt_off);',
        'int batch_sz = (int)qsb_batch_size(lt_range - lt_off, (uint32_t)BATCH);', 2)
    text = replace(text, '#else\n    qsb_tail_pre cur_tp; qsb_make_tail_pre(&cur_tp, pp.midstate, tail_w2);',
        '    // Drain every queued batch even when sequence overlap is enabled.\n'
        '    for (int s = 0; s < QSB_SLOTS; ++s) if (drain_slot(s)) return 2;\n'
        '#else\n    qsb_tail_pre cur_tp; qsb_make_tail_pre(&cur_tp, pp.midstate, tail_w2);')
    # No range-complete credit marker: remaining CUDA/host error checks are a
    # separate release blocker. This is deliberately only a scheduling receipt.
    text = replace(text, '    printf("\\n  Done: %luM',
        '    if (total_searched != range.sequence_count * range.locktime_count) return 2;\n'
        '    printf("QSB_RANGE_DRAINED candidates=%llu\\n", (unsigned long long)total_searched);\n'
        '    printf("\\n  Done: %luM')
    # Compile-time lock: command-line flags cannot silently re-enable shortcuts.
    prefix = '#include "qsb_pin_contract.h"\n#include "qsb_pin_recovery.h"\n'
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
    shutil.copyfile(Path(__file__).with_name('pin_recovery.h'),args.out/'pinning/qsb_pin_recovery.h')
    hashes={str(p.relative_to(args.out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.out.rglob('*')) if p.is_file()}
    receipt={'status':'HOLD','upstreamCommit':lock['commit'],'scope':'isolated-pinning-bounded-v2','flags':FLAGS,'files':hashes,'completeArithmeticCertified':False,'boundedSchedulerCertified':False,'deploymentAllowed':False}
    (args.out/'adaptation.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'status':'HOLD','files':len(hashes),'disabledShortcuts':len(FLAGS)}))

if __name__=='__main__': main()
