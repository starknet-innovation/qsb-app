"""Create a reviewable production-predicate adaptation of the pinned challenge.

Not a verified release. Compile and differentially test before mainnet use.
GPLv3 notices and the entire candidate include tree are retained.
"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'worker/build'
SOURCE = ROOT / 'vendor/challenge/candidates'

def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Search scheduler source changed: ' + old[:80])
    return text.replace(old, new)

def replace_body(text, name, body):
    start = text.index('{', text.index(name + '('))
    depth, end = 1, start + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[:start] + '{\n' + body + '\n}' + text[end:]

for track in ('pinning', 'subset'):
    destination = BUILD / track
    shutil.copytree(SOURCE / track, destination, dirs_exist_ok=True)
    files = list(destination.rglob('*.cu'))
    patched = 0
    for file in files:
        text = file.read_text()
        if '__device__ int gpu_bench_valid(' not in text:
            continue
        text = replace_body(text, 'gpu_bench_valid', '    return gpu_is_valid_der(h, 32);')
        text = replace_body(text, 'gpu_bench_valid_words', '''    uint8_t digest[32];
    for (int i = 0; i < 8; ++i) {
        digest[4*i] = (uint8_t)(hs[i] >> 24);
        digest[4*i+1] = (uint8_t)(hs[i] >> 16);
        digest[4*i+2] = (uint8_t)(hs[i] >> 8);
        digest[4*i+3] = (uint8_t)hs[i];
    }
    return gpu_is_valid_der(digest, 32);''')
        if track == 'pinning':
            old = 'for (uint32_t seq = SEQ_MIN + effective_id; ; seq += effective_total)'
            if text.count(old) != 2:
                raise RuntimeError('Pinning loop changed; review bounded-range adaptation')
            text = text.replace(old, 'for (uint64_t seq64 = (uint64_t)SEQ_MIN + effective_id; seq64 < (uint64_t)SEQ_MIN + seq_count; seq64 += effective_total)')
            text = text.replace('seq64 += effective_total) {', 'seq64 += effective_total) {\n        uint32_t seq = (uint32_t)seq64;')
            text = once(text, '    uint32_t lt_range = LT_MAX - LT_MIN;', '''    uint64_t seq_count = 16;
    uint64_t work_lt_start = LT_MIN, work_lt_count = LT_MAX - LT_MIN;
    for (int i = 1; i < argc; ++i) {
        if (!strncmp(argv[i], "lt_start=", 9)) work_lt_start = strtoull(argv[i]+9, NULL, 10);
        if (!strncmp(argv[i], "lt_count=", 9)) work_lt_count = strtoull(argv[i]+9, NULL, 10);
        if (!strncmp(argv[i], "seq_count=", 10)) seq_count = strtoull(argv[i]+10, NULL, 10);
    }
    if (!seq_count || seq_count > 16 || (uint64_t)SEQ_MIN + seq_count > 0x100000000ULL ||
        work_lt_start < LT_MIN || work_lt_start >= LT_MAX || !work_lt_count ||
        work_lt_count > (uint64_t)LT_MAX - work_lt_start) return 2;
    LT_MIN = (uint32_t)work_lt_start;
    uint32_t lt_range = (uint32_t)work_lt_count;''')
        else:
            text = once(text, '    int easy = 0;', '''    uint64_t work_start = 0, work_count = 0;
    bool ranked_work = false;
    for (int i = 1; i < argc; ++i) {
        if (!strncmp(argv[i], "rank_start=", 11)) { work_start = strtoull(argv[i]+11, NULL, 10); ranked_work = true; }
        if (!strncmp(argv[i], "rank_count=", 11)) work_count = strtoull(argv[i]+11, NULL, 10);
    }
    int easy = 0;''')
            # Work ranks always describe C(150,9), never the benchmark's reduced
            # epoch families. Retain the previously validated generic math.
            text = text.replace('if (tile_path == NULL && eff_total == 1 && !easy && !calibrate', 'if (!ranked_work && tile_path == NULL && eff_total == 1 && !easy && !calibrate')
            text = text.replace('if (!se_mode && tile_path == NULL', 'if (!ranked_work && !se_mode && tile_path == NULL')
            text = once(text, '        uint64_t enum_base = 0;', '        uint64_t enum_base = ranked_work ? work_start : 0;')
            text = once(text, '        uint64_t span = epoch_mode ? per_epoch : global_total;', '''        uint64_t span = epoch_mode ? per_epoch : global_total;
        if (ranked_work) {
            if (!work_count || work_start >= span || work_count > span - work_start || epoch_mode) return 2;
            span = work_start + work_count;
        }''')
            text = once(text, '    cudaSetDevice(gpu_index);', '''    if (ranked_work && (total_gpus_override != 1 || global_offset != 0 || tile_path || easy || calibrate || !single_hash)) return 2;
    cudaSetDevice(gpu_index);''')
        file.write_text('// QSB Vault adaptation: production DER gate, CPU recovery verification required.\n' + text)
        patched += 1
    if patched == 0:
        raise RuntimeError(f'No gate found in {track}')
print('Prepared production DER gates. GPU equivalence is still required.')
