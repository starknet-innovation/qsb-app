"""Wrap standalone CUDA statements in the locked candidate, not arbitrary C++."""
import re


def checked_cuda(source):
    # Preserve offsets while hiding comments and literals from the scanner.
    hidden = re.sub(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"',
                    lambda m: ''.join('\n' if c == '\n' else ' ' for c in m[0]),
                    source, flags=re.S)
    sites=[]
    for m in re.finditer(r'\bcuda[A-Za-z0-9_]+\s*\(', hidden):
        start=m.start();end=m.end();depth=1
        while depth:
            if end>=len(hidden):raise ValueError('Unclosed CUDA call')
            depth += (hidden[end]=='(')-(hidden[end]==')');end+=1
        after=hidden[end:].lstrip()
        if not after.startswith(';'):continue
        prefix=hidden[:start].rstrip()
        line=hidden[hidden.rfind('\n',0,start)+1:start].strip()
        # Existing assigned/conditional return checks remain unchanged.
        if prefix and prefix[-1] not in ';{}':
            if line or not prefix.splitlines()[-1].lstrip().startswith('#'):continue
        sites.append((start,end,source[start:end]))
    for start,end,call in reversed(sites):
        source=source[:start]+'QSB_CUDA('+call+')'+source[end:]
    return source,[call for _,_,call in sites]
