import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from pin_runtime import PROTOCOL
from pin_reference import reference,verify,fingerprint,prepare,execute,REFERENCE_LOCKTIME_MAX

class ReferenceBinding(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'worker/cpu'))
        from bitcoin_tx import QSBScriptBuilder,_valid_small_r_values
        from secp256k1 import encode_der_sig,G,N
        # Public synthetic commitments only: no HORS preimages or wallet material.
        b=QSBScriptBuilder(150,8,1,7,2,hash_mode='sha256')
        b.hors_commitments=[[hashlib.sha256(f'public-{r}-{i}'.encode()).digest()[:20] for i in range(150)] for r in range(2)]
        small=_valid_small_r_values()
        b.dummy_sigs=[[encode_der_sig(small[i%len(small)],i//len(small)+1,sighash=3) for i in range(150)] for _ in range(2)]
        sig=encode_der_sig(G[0]%N,1,sighash=1)
        state={'config':'A','hash_mode':'sha256','n':150,'t1s':8,'t1b':1,'t2s':7,'t2b':2,
          'hors_commitments':[[x.hex() for x in r] for r in b.hors_commitments],'dummy_sigs':[[x.hex() for x in r] for r in b.dummy_sigs],
          'pin_r':G[0]%N,'pin_s':1,'pin_sig':sig.hex(),'round_sigs':[{'r':G[0]%N,'s':s,'sig':encode_der_sig(G[0]%N,s,sighash=1).hex()} for s in (2,3)],
          'full_script_hex':b.build_full_script(sig,encode_der_sig(G[0]%N,2,sighash=1),encode_der_sig(G[0]%N,3,sighash=1)).hex()}
        cls.ctx={'publicStateJson':json.dumps(state),'manifest':{'funding':{'txid':'11'*32,'vout':0,'value':'100000'},'helper':{'txid':'22'*32,'vout':1,'value':'10000'},'outputValue':'90000','fee':'20000','outputScript':'0014'+'33'*20}}
        exported=reference({**cls.ctx,'action':'export','stage':'pinning'})
        cls.req={'protocol':PROTOCOL,'requestId':'unfunded-reference-test','manifestHash':fingerprint(cls.ctx['manifest']),'binarySha256':'a'*64,**exported,'range':{'sequence':2147483648,'sequenceCount':1,'locktime':500000000,'locktimeCount':1}}
        cls.out={k:cls.req[k] for k in ('protocol','requestId','manifestHash','binarySha256','parameterSha256','range')}
        cls.out.update(status='range-drained',candidates=[],verified=False,rangeCreditEligible=False,releaseStatus='HOLD')
    def test_real_export_binding(self):
        v=verify(self.req,self.out,self.ctx,'a'*64)
        self.assertTrue(v['referenceChecked']);self.assertFalse(v['rangeCreditEligible'])
    def test_reject_mismatched_result_context_and_parameters(self):
        for key,value in [('binarySha256','c'*64),('status','failed'),('requestId','other')]:
            out={**self.out,key:value}
            with self.assertRaises(ValueError):verify(self.req,out,self.ctx,'a'*64)
        ctx=copy.deepcopy(self.ctx);ctx['manifest']['outputScript']='51'
        with self.assertRaises(ValueError):verify(self.req,self.out,ctx,'a'*64)
        req={**self.req,'manifestHash':fingerprint(ctx['manifest'])};out={**self.out,'manifestHash':req['manifestHash']}
        with self.assertRaises(ValueError):verify(req,out,ctx,'a'*64)
    def test_real_negative_candidate(self):
        out={**self.out,'candidates':[{'sequence':2147483648,'locktime':500000000,'recid':0}]}
        with self.assertRaisesRegex(ValueError,'not reproduced'):verify(self.req,out,self.ctx,'a'*64)

    def test_reference_domain_inclusive_boundary(self):
        r={**self.req['range'],'locktime':REFERENCE_LOCKTIME_MAX//256*256,
           'locktimeCount':REFERENCE_LOCKTIME_MAX%256+1}
        req={**self.req,'range':r}
        self.assertEqual(prepare(req,self.ctx,'a'*64)['releaseStatus'],'HOLD')
        req['range']={**r,'locktimeCount':r['locktimeCount']+1}
        with patch('pin_runtime.run') as compute:
            with self.assertRaisesRegex(ValueError,'verifier locktime domain'):
                execute(req,self.ctx,'unused','a'*64)
            compute.assert_not_called()
        out={**self.out,'range':req['range']}
        with self.assertRaisesRegex(ValueError,'verifier locktime domain'):
            verify(req,out,self.ctx,'a'*64)

    def test_preflight_rejects_context_before_compute(self):
        ctx=copy.deepcopy(self.ctx);ctx['manifest']['outputScript']='51'
        with patch('pin_runtime.run') as compute:
            with self.assertRaises(ValueError):execute(self.req,ctx,'unused','a'*64)
            compute.assert_not_called()

    def test_handoff_keeps_failed_compute_unverified(self):
        for status in ('failed','interrupted'):
            out={**self.out,'status':status}
            with patch('pin_runtime.run',return_value=out),patch('pin_reference.verify') as check:
                receipt=execute(self.req,self.ctx,'unused','a'*64)
                check.assert_not_called()
                self.assertIsNone(receipt['reference']);self.assertFalse(receipt['rangeCreditEligible'])

    def test_complete_handoff_binds_real_reference_without_credit(self):
        with patch('pin_runtime.run',return_value=self.out):
            receipt=execute(self.req,self.ctx,'unused','a'*64)
        self.assertTrue(receipt['reference']['referenceChecked'])
        self.assertFalse(receipt['rangeCreditEligible'])

    def test_public_state_reconstruction_rejects_inconsistent_inputs(self):
        original=json.loads(self.ctx['publicStateJson'])
        mutations=[]
        def changed(edit):
            state=copy.deepcopy(original);edit(state);mutations.append(state)
        changed(lambda s:s.update(full_script_hex='51'))
        changed(lambda s:s['hors_commitments'][0].__setitem__(0,'00'*20))
        changed(lambda s:s.update(pin_s=s['pin_s']+1))
        changed(lambda s:s['round_sigs'][0].update(s=9))
        changed(lambda s:s['dummy_sigs'][0].__setitem__(1,s['dummy_sigs'][0][0]))
        changed(lambda s:s.update(t1b=True))
        changed(lambda s:s.update(hors_secrets=[]))
        changed(lambda s:s['hors_commitments'][0].pop())
        for state in mutations:
            with self.subTest(state_keys=list(state)),patch('pin_runtime.run') as compute:
                ctx={**self.ctx,'publicStateJson':json.dumps(state)}
                with self.assertRaisesRegex(ValueError,'CPU reference rejected'):
                    execute(self.req,ctx,'unused','a'*64)
                compute.assert_not_called()
