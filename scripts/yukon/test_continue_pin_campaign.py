import copy
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import test_pin_reference as fixture
from pin_campaign import save
from continue_pin_campaign import continuation

class Continue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):fixture.ReferenceBinding.setUpClass()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.previous=self.root/'previous';self.previous.mkdir()
        a=copy.deepcopy(fixture.ReferenceBinding.req);b=copy.deepcopy(a);b['range']['sequence']+=1
        self.plan={'format':'qsb-pin-campaign-v1','binarySha256':'a'*64,'unfundedSynthetic':True,'requests':[a,b]}
        self.receipt={'completedRangeOutputs':1,'unresolvedAttempts':[],'validCandidateFound':False,'contextHash':'b'*64}
        save(self.previous/'bounded-stop.json',{'completedRangeOutputs':1,'rangeCreditGranted':False,'cpuVerified':False,'releaseStatus':'HOLD'})
    def test_only_unattempted_tail_and_exclusive_destination(self):
        with patch('continue_pin_campaign.check',return_value=self.receipt):
            got=continuation(self.plan,fixture.ReferenceBinding.ctx,self.previous,self.root/'next')
            self.assertEqual(got['remainingRequests'],1);self.assertFalse(got['dispatchAuthorized'])
            with self.assertRaises(FileExistsError):continuation(self.plan,fixture.ReferenceBinding.ctx,self.previous,self.root/'next')
    def test_uncertainty_hit_and_exhaustion_block(self):
        for patch_value in ({'unresolvedAttempts':[1]},{'validCandidateFound':True},{'completedRangeOutputs':2}):
            with patch('continue_pin_campaign.check',return_value={**self.receipt,**patch_value}):
                with self.assertRaises(ValueError):continuation(self.plan,fixture.ReferenceBinding.ctx,self.previous,self.root/'next')
            self.assertFalse((self.root/'next').exists())
    def test_completed_tail_overlap_blocks(self):
        self.plan['requests'][1]['range']['sequence']-=1
        with patch('continue_pin_campaign.check',return_value=self.receipt):
            with self.assertRaisesRegex(ValueError,'Overlapping'):continuation(self.plan,fixture.ReferenceBinding.ctx,self.previous,self.root/'next')
    def test_contradictory_stop_blocks(self):
        save(self.previous/'stopped-for-verification.json',{})
        with patch('continue_pin_campaign.check',return_value=self.receipt):
            with self.assertRaisesRegex(ValueError,'stop cleanly'):continuation(self.plan,fixture.ReferenceBinding.ctx,self.previous,self.root/'next')

if __name__=='__main__':unittest.main()
