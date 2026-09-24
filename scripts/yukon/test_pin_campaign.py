import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pin_campaign import campaign
from test_pin_reference import ReferenceBinding


class Campaign(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ReferenceBinding.setUpClass()
        cls.request = ReferenceBinding.req

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)/'run'
        self.plan = {'format':'qsb-pin-campaign-v1','binarySha256':'a'*64,'unfundedSynthetic':True,'requests':[copy.deepcopy(self.request)]}

    def test_single_use_and_no_credit(self):
        with patch('pin_campaign.run', return_value=ReferenceBinding.out) as run:
            campaign(self.plan, 'unused', self.out, 120)
            self.assertEqual(run.call_count,1)
            with self.assertRaises(FileExistsError): campaign(self.plan,'unused',self.out,120)
            self.assertEqual(run.call_count,1)
        self.assertFalse(json.loads((self.out/'bounded-stop.json').read_text())['rangeCreditGranted'])

    def test_failure_preserves_intent_no_retry(self):
        with patch('pin_campaign.run', side_effect=RuntimeError('lost result')) as run:
            with self.assertRaises(RuntimeError): campaign(self.plan,'unused',self.out,120)
            self.assertEqual(run.call_count,1)
        self.assertTrue((self.out/'000.intent.json').exists())
        self.assertFalse((self.out/'000.result.json').exists())

    def test_hit_stops_before_next_request(self):
        second=copy.deepcopy(self.request);second['range']['sequence']+=1
        self.plan['requests'].append(second)
        result={**ReferenceBinding.out,'candidates':[{'sequence':2147483648,'locktime':500000000,'recid':0}]}
        with patch('pin_campaign.run',return_value=result) as run:
            campaign(self.plan,'unused',self.out,120)
            self.assertEqual(run.call_count,1)
        self.assertFalse(json.loads((self.out/'stopped-for-verification.json').read_text())['cpuVerified'])

    def test_overlap_and_domain_rejected_before_compute(self):
        for changed in ('overlap','domain'):
            plan=copy.deepcopy(self.plan)
            if changed=='overlap':plan['requests'].append(copy.deepcopy(self.request))
            else:plan['requests'][0]['range']['locktimeCount']=1744600002-500000000
            with patch('pin_campaign.run') as run:
                with self.assertRaises(ValueError):campaign(plan,'unused',self.out,120)
                run.assert_not_called()

    def test_failed_status_stops(self):
        with patch('pin_campaign.run',return_value={**ReferenceBinding.out,'status':'interrupted'}) as run:
            with self.assertRaisesRegex(ValueError,'Incomplete'):campaign(self.plan,'unused',self.out,120)
            self.assertEqual(run.call_count,1)
        self.assertTrue((self.out/'000.result.json').exists())
        self.assertFalse((self.out/'bounded-stop.json').exists())

    def test_budget_stops_without_starting_next_range(self):
        with patch('pin_campaign.time.monotonic',side_effect=[0,21]),patch('pin_campaign.run') as run:
            campaign(self.plan,'unused',self.out,120)
            run.assert_not_called()
        self.assertEqual(json.loads((self.out/'bounded-stop.json').read_text())['completedRangeOutputs'],0)

if __name__=='__main__':unittest.main()
