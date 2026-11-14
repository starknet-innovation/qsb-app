"""Public deployed-workflow guard isolation; no AWS requests or credentials."""
import json
from copy import deepcopy
from unittest import TestCase, main
from unittest.mock import Mock, patch
from production_guard import checked_request, owned, read_rows, remember, chain, inventory, stopping, pause

class ProductionGuardTests(TestCase):
    def settings(self):
        return {'name':'qsb-pqb-v-012345abcdef','table':'qsb-app-records','pk':'OWNER#public','sk':'JOB#public','ledgerSk':'PUBLIC_VALIDATION#case',
            'owner':'public','jobId':'public','vaultId':'public-vault','manifestHash':'a'*64,'definition':'permanent:12','queue':'production',
            'workflow':'arn:aws:states:eu-west-2:123456789012:stateMachine:qsb-app-withdrawal',
            'rootExecution':'arn:aws:states:eu-west-2:123456789012:execution:qsb-app-withdrawal:public-case','stopAt':1000,'expiresAt':1900}
    def request(self):
        token='01234567-89ab-4cde-8fab-0123456789ab'
        return {'jobName':'qsb-'+token,'inputKey':'inputs/'+token+'.json','inputSha256':'b'*64,'definition':'permanent:12','queue':'production'}
    def job(self):
        r=self.request()
        return {'jobId':'paid-public','jobName':r['jobName'],'jobDefinition':r['definition'],'jobQueue':r['queue'],'status':'RUNNING',
            'tags':{'Project':'qsb-gpu','InputSha256':r['inputSha256'],'QsbRequest':r['jobName'][4:]},
            'container':{'environment':[{'name':'QSB_INPUT_KEY','value':r['inputKey']},{'name':'QSB_INPUT_SHA256','value':r['inputSha256']}]}}
    def test_ownership_requires_every_durable_identity_field(self):
        s=self.settings();r=self.request();self.assertTrue(owned(self.job(),[r],s))
        for field in ['jobName','jobDefinition','jobQueue','tag','environment','duplicate-environment']:
            j=self.job()
            if field in ['jobName','jobDefinition','jobQueue']:j[field]='foreign'
            if field=='tag':j['tags']['QsbRequest']='foreign'
            if field=='environment':j['container']['environment'][1]['value']='c'*64
            if field=='duplicate-environment':j['container']['environment']+=j['container']['environment'][:1]
            self.assertFalse(owned(j,[r],s),field)
    def test_request_cannot_repoint_to_other_data_or_compute(self):
        s=self.settings()
        for field,value in [('inputKey','wallet/private.json'),('queue','other'),('definition','other:2'),('inputSha256','bad'),('jobName','qsb-other')]:
            r=dict(self.request());r[field]=value
            with self.assertRaises(RuntimeError):checked_request(r,s)
    def test_registry_retains_requests_after_slots_are_cleared(self):
        ddb=Mock();s=self.settings();r=self.request();old={'records':[json.dumps(r,sort_keys=True)]}
        records=remember(ddb,s,{'job':{'parallelSlots':[]}},old)
        self.assertEqual(records,[r]);call=ddb.update_item.call_args.kwargs;self.assertEqual(call['Key']['sk']['S'],s['ledgerSk']);self.assertIn('manifestHash',call['ConditionExpression'])
    def test_wrong_manifest_fails_before_registry_write(self):
        from boto3.dynamodb.types import TypeSerializer
        ser=TypeSerializer().serialize;s=self.settings();ddb=Mock()
        public={'pk':s['pk'],'sk':s['sk'],'expiresAt':s['expiresAt'],'job':{'id':'public','owner':'public','vaultId':'public-vault','manifestHash':'foreign'}}
        ledger={'manifestHash':s['manifestHash'],'case':s['name']}
        ddb.get_item.side_effect=[{'Item':{k:ser(v) for k,v in public.items()}},{'Item':{k:ser(v) for k,v in ledger.items()}}]
        with self.assertRaisesRegex(RuntimeError,'fixture binding'):read_rows(ddb,s)
        ddb.update_item.assert_not_called()
    def test_history_access_is_not_used_and_chain_follows_only_proven_outputs(self):
        s=self.settings();states=Mock();states.exceptions.ExecutionDoesNotExist=type('Missing',(Exception,),{})
        child=s['rootExecution'].rsplit(':',1)[0]+':child'
        event={'owner':s['owner'],'jobId':s['jobId'],'revision':0}
        states.describe_execution.side_effect=[{'executionArn':s['rootExecution'],'input':json.dumps(event),'status':'SUCCEEDED','output':json.dumps({'ExecutionArn':child})},
            {'executionArn':child,'input':json.dumps(dict(event,polls=0)),'status':'SUCCEEDED','output':'{}'}]
        self.assertEqual(len(chain(states,s)),2);states.get_execution_history.assert_not_called()
        self.assertEqual([c.kwargs['executionArn'] for c in states.describe_execution.call_args_list],[s['rootExecution'],child])
    def test_cross_workflow_child_is_never_read(self):
        s=self.settings();states=Mock();states.exceptions.ExecutionDoesNotExist=type('Missing',(Exception,),{})
        states.describe_execution.return_value={'input':json.dumps({'owner':'public','jobId':'public','revision':0}),'status':'SUCCEEDED','output':json.dumps({'ExecutionArn':'arn:foreign'})}
        with self.assertRaisesRegex(RuntimeError,'chain'):chain(states,s)
        states.describe_execution.assert_called_once()
    def test_wrong_public_execution_identity_is_rejected(self):
        s=self.settings();states=Mock();states.exceptions.ExecutionDoesNotExist=type('Missing',(Exception,),{})
        states.describe_execution.return_value={'input':json.dumps({'owner':'another','jobId':'public','revision':0}),'status':'RUNNING'}
        with self.assertRaisesRegex(RuntimeError,'public fixture'):chain(states,s)
    def test_same_permanent_revision_foreign_job_is_never_owned(self):
        s=self.settings();batch=Mock();foreign=self.job();foreign['jobId']='another';foreign['jobName']='qsb-ffffffff-ffff-4fff-8fff-ffffffffffff'
        batch.get_paginator.return_value.paginate.side_effect=lambda **kw:[{'jobSummaryList':[{'jobId':'paid-public'},{'jobId':'another'}]}] if kw['jobStatus']=='RUNNING' else []
        batch.describe_jobs.return_value={'jobs':[self.job(),foreign]};jobs,other=inventory(batch,s,[self.request()]);self.assertEqual([x['jobId'] for x in jobs],['paid-public']);self.assertEqual(other,['another']);batch.submit_job.assert_not_called();batch.terminate_job.assert_not_called()
    def test_budget_and_expiry_stop_only_active_work(self):
        s=self.settings();v={'publicRow':{'job':{'status':'searching','gpuSubmissions':223}},'foreignActiveIds':[],'executions':[],'jobs':[]}
        self.assertFalse(stopping(v,s,999));self.assertTrue(stopping(v,s,1000));v['publicRow']['job']['gpuSubmissions']=224;self.assertTrue(stopping(v,s,999));v['publicRow']['job']['status']='awaiting_authorization';self.assertFalse(stopping(v,s,999))
    def test_pause_uses_exact_public_key_manifest_and_non_resumable_failure(self):
        ddb=Mock();s=self.settings();pause(ddb,s,'bounded stop');call=ddb.update_item.call_args.kwargs
        self.assertEqual(call['Key'],{'pk':{'S':s['pk']},'sk':{'S':s['sk']}});self.assertEqual(call['ExpressionAttributeValues'][':failed'],{'S':'failed'});self.assertEqual(call['ExpressionAttributeValues'][':hash'],{'S':s['manifestHash']});self.assertIn('#j.#id',call['ConditionExpression']);self.assertEqual(call['ExpressionAttributeNames']['#id'],'id')
    def test_orphan_collection_never_fetches_unmatched_bodies_and_rejects_bad_sha(self):
        import hashlib,io
        from datetime import datetime,timezone
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from production import Production
        base={'protocol':'pqb-v1','kernelCommit':'a'*40,'manifestHash':'b'*64,'stage':'pinning','attempt':0,'searchVersion':'pqb-ranked-v2','problemBase64':'YQ==','problemSha256':'c'*64}
        raw=json.dumps({'input':base},separators=(',',':')).encode();etag='"'+hashlib.md5(raw,usedforsecurity=False).hexdigest()+'"';own='inputs/01234567-89ab-4cde-8fab-0123456789ab.json'
        for corrupt in [False,True]:
            with self.subTest(corrupt=corrupt),TemporaryDirectory() as directory:
                c=object.__new__(Production);c.directory=Path(directory);c.state={'createdAt':1,'bucket':'shared','settings':{'manifestHash':base['manifestHash']}}
                (c.directory/'objects').mkdir();(c.directory/'objects'/'inputs__ffffffff-ffff-4fff-8fff-ffffffffffff.json.head.json').write_text(json.dumps({'VersionId':'ours','ETag':etag}));(c.directory/'preflight-input.json').write_text(json.dumps({'input':base}));(c.directory/'deployed-binding.json').write_text(json.dumps({'coordinatorEnv':{'MAX_JOB_GPU_SECONDS':'1800'}}))
                s3=Mock();c.client=Mock(return_value=s3);s3.get_paginator.return_value.paginate.return_value=[{'Contents':[{'Key':own,'ETag':etag,'LastModified':datetime.now(timezone.utc)}, {'Key':'inputs/ffffffff-ffff-4fff-8fff-ffffffffffff.json','ETag':'"foreign"','LastModified':datetime.now(timezone.utc)}]}]
                s3.get_object.return_value={'Body':io.BytesIO(b'wrong' if corrupt else raw),'VersionId':'ours'};s3.head_object.return_value={'VersionId':'ours'}
                if corrupt:
                    with self.assertRaisesRegex(RuntimeError,'hash mismatch'):c.collect_public_orphans(None)
                    self.assertFalse((c.directory/'objects'/own.replace('/','__')).exists())
                else:c.collect_public_orphans(None)
                s3.get_object.assert_called_once_with(Bucket='shared',Key=own,IfMatch=etag)
    def test_submission_between_row_read_and_batch_inventory_is_not_foreign(self):
        import production_guard
        s=self.settings();clients={x:Mock() for x in ['batch','dynamodb','stepfunctions']};public={'job':{'gpuSubmissions':1}}
        clients['batch'].describe_jobs.return_value={'jobs':[self.job()]}
        with patch.object(production_guard,'read_rows',side_effect=[(None,{}),(public,{})]),patch.object(production_guard,'remember',side_effect=[[],[self.request()]]),patch.object(production_guard,'inventory',return_value=([],['paid-public'])),patch.object(production_guard,'chain',return_value=[]):
            result=production_guard.observe(clients,s)
            self.assertEqual(result['foreignActiveIds'],[]);self.assertEqual(result['jobs'],[self.job()]);self.assertEqual(result['paidSubmissions'],1)
            clients['batch'].submit_job.assert_not_called();clients['batch'].terminate_job.assert_not_called()
    def test_deadline_and_explicit_stop_pause_before_failed_observation(self):
        import production_guard
        for event,now in [({'action':'stop'},1),({},1001),({},1)]:
            calls=[];clients={x:Mock() for x in ['batch','dynamodb','stepfunctions']}
            with self.subTest(event=event,now=now),patch.dict('os.environ',{'SETTINGS':json.dumps(self.settings())}),patch('boto3.client',side_effect=lambda name,**kw:clients[name]),patch.object(production_guard.time,'time',return_value=now),patch.object(production_guard,'pause',side_effect=lambda *args:calls.append('pause')),patch.object(production_guard,'observe',side_effect=lambda *args,**kw:(calls.append('observe'),(_ for _ in ()).throw(RuntimeError('read failed')))[1]):
                with self.assertRaisesRegex(RuntimeError,'read failed'):production_guard.handler(event,Mock())
                self.assertEqual(calls,['pause','observe','pause'] if event or now>1000 else ['observe','pause'])
    def test_final_verification_row_exports_all_search_templates(self):
        import os,subprocess
        from pathlib import Path
        from tempfile import TemporaryDirectory
        root=Path(__file__).resolve().parents[2]
        with TemporaryDirectory() as directory:
            case=Path(directory)
            for source,target in [('public-fixture.json','public-fixture.json'),('final-job.json','current-public-job.json')]:
                (case/target).write_bytes((root/'docs/pqb-production-validation'/source).read_bytes())
            result=subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','input-template',directory],cwd=root,env={**os.environ,'QSB_NETWORK':'mainnet'},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            stages={json.loads(p.read_text())['input']['stage'] for p in case.glob('input-template-*.json')}
            self.assertEqual(stages,{'pinning','round0','round1'})
    def test_reconciliation_recovers_only_sha_bound_removed_submission(self):
        import hashlib
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from production import Production
        with TemporaryDirectory() as directory:
            c=object.__new__(Production);c.directory=Path(directory);(c.directory/'objects').mkdir()
            c.state={'knownRequests':[],'createdAt':1,'queue':'production','name':self.settings()['name'],'settings':self.settings()}
            r=self.request();raw=json.dumps({'input':{'manifestHash':self.settings()['manifestHash']}}).encode();r['inputSha256']=hashlib.sha256(raw).hexdigest()
            (c.directory/'objects'/r['inputKey'].replace('/','__')).write_bytes(raw)
            (c.directory/'objects'/(r['inputKey'].replace('/','__')+'.head.json')).write_text(json.dumps({'VersionId':'ours'}))
            job=self.job();job['createdAt']=2000;job['status']='SUCCEEDED';job['container']['environment'][1]['value']=r['inputSha256'];job['tags']['InputSha256']=r['inputSha256']
            foreign=deepcopy(job);foreign['jobId']='foreign';foreign['container']['environment'][1]['value']='f'*64
            batch=Mock();batch.get_paginator.return_value.paginate.return_value=[{'jobSummaryList':[{'jobId':'paid-public'},{'jobId':'foreign'}]}];batch.describe_jobs.return_value={'jobs':[job,foreign]}
            c.client=Mock(return_value=batch);c.mutate=Mock()
            self.assertTrue(c.reconcile_completed_requests());kwargs=c.mutate.call_args.kwargs
            self.assertEqual(kwargs['Key']['pk']['S'],self.settings()['pk']);self.assertEqual(kwargs['ExpressionAttributeValues'][':records']['SS'],[json.dumps(r,sort_keys=True)])
            batch.submit_job.assert_not_called();batch.terminate_job.assert_not_called()
    def test_public_metrics_decode_without_losing_integer_identity(self):
        from production_guard import decode
        from decimal import Decimal
        self.assertEqual(decode({'N':'489.542'}),Decimal('489.542'));self.assertEqual(decode({'N':'224'}),224)

if __name__=='__main__':main()
