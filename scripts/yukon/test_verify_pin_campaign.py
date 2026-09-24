import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import test_pin_reference as fixture
from pin_campaign import save,digest
from verify_pin_campaign import check

class DownloadBinding(unittest.TestCase):
    def test_real_cpu_verifies_downloaded_empty_output_and_rejects_substitution(self):
        fixture.ReferenceBinding.setUpClass();f=fixture.ReferenceBinding
        plan={'format':'qsb-pin-campaign-v1','binarySha256':'a'*64,'unfundedSynthetic':True,'requests':[f.req]}
        with tempfile.TemporaryDirectory() as d,patch('verify_pin_campaign.FROZEN_BINARY','a'*64):
            d=Path(d);save(d/'plan.json',plan)
            save(d/'000.intent.json',{'planHash':digest(plan),'requestHash':digest(f.req),'attempt':0})
            self.assertEqual(check(plan,f.ctx,d)['unresolvedAttempts'],[0])
            record={'requestHash':digest(f.req),'output':f.out,'wallSeconds':1.0}
            save(d/'000.result.json',record)
            receipt=check(plan,f.ctx,d)
            self.assertEqual(receipt['completedRangeOutputs'],1)
            self.assertFalse(receipt['rangeCreditGranted'])
            bad=copy.deepcopy(record);bad['output']['range']['sequence']+=1
            (d/'000.result.json').write_text(json.dumps(bad))
            with self.assertRaises(ValueError):check(plan,f.ctx,d)

if __name__=='__main__':unittest.main()
