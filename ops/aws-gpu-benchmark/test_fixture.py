import json,tempfile,unittest
from pathlib import Path
from prepare import prepare
class FixtureTest(unittest.TestCase):
    def test_public_deterministic_unfunded_fixture(self):
        with tempfile.TemporaryDirectory() as a,tempfile.TemporaryDirectory() as b:
            self.assertEqual(prepare(a),prepare(b))
            event=json.loads((Path(a)/'event.json').read_text())
            state=json.loads(event['publicStateJson'])
            self.assertNotIn('hors_secrets',state)
            self.assertTrue(all(set(r)=={'r','s','sig'} for r in state['round_sigs']))
            self.assertEqual(event['manifest']['funding']['txid'],'11'*32)
            self.assertFalse(json.loads((Path(a)/'fixture.json').read_text())['funded'])
