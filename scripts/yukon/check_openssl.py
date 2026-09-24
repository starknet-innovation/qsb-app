"""Check only OpenSSL APIs whose documented failure return is zero/null."""
import re

CHECKED = frozenset('''BN_new BN_CTX_new BN_bin2bn BN_lebin2bn BN_copy BN_one
BN_set_word BN_lshift BN_rshift BN_add_word BN_sub_word BN_mul_word BN_sub
BN_mul BN_nnmod BN_mod_mul BN_mod_sqr BN_mod_exp BN_mod_sub
EC_GROUP_new_by_curve_name EC_GROUP_get_order EC_GROUP_get_curve_GFp
EC_POINT_new EC_POINT_dup EC_POINT_copy EC_POINT_add EC_POINT_dbl EC_POINT_invert
EC_POINT_mul EC_POINT_get_affine_coordinates_GFp EC_POINT_set_affine_coordinates_GFp
EC_POINTs_make_affine SHA256_Init'''.split())


def checked_openssl(source):
    hidden=re.sub(r'/\*.*?\*/|//[^\n]*|"(?:\\.|[^"\\])*"',
                  lambda m: ''.join('\n' if c=='\n' else ' ' for c in m[0]),source,flags=re.S)
    sites=[]
    for m in re.finditer(r'\b('+'|'.join(sorted(CHECKED))+r')\s*\(',hidden):
        end=m.end();depth=1
        while depth:
            if end>=len(hidden):raise ValueError('Unclosed OpenSSL call')
            depth+=(hidden[end]=='(')-(hidden[end]==')');end+=1
        sites.append((m.start(),end,m[1]))
    # Insert at boundaries rather than replace ranges, preserving nested calls.
    edits=[]
    for start,end,name in sites:
        edits += [(start,'qsb_ssl_checked('),(end,', "'+name+'")')]
    for pos,insert in sorted(edits,reverse=True):source=source[:pos]+insert+source[pos:]
    return source,[name for _,_,name in sites]
