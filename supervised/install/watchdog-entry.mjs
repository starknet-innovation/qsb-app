import {readFileSync,fstatSync,lstatSync,closeSync} from 'node:fs';
import {watch,provider,validateEnrollment} from './watchdog.mjs';
try{
 const id=process.argv[2];if(!/^[a-z0-9]{8,32}$/.test(id)||process.getuid()!==0)throw Error();
 const path='/etc/qsb/watchdogs/'+id+'.json';const s=lstatSync(path);if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.size>4096||!fstatSync(3).isFIFO())throw Error();
 const cfg=validateEnrollment(JSON.parse(readFileSync(path,'utf8')));if(cfg.endpoint!==id)throw Error();
 const key=readFileSync(3);closeSync(3);if(key.length>4096)throw Error();const api=provider(key.toString('utf8'));key.fill(0);
 const service=await watch(cfg,api),result=await service.finished;process.exitCode=result.absent?0:2;
}catch{console.error('Watchdog enrollment or cleanup unresolved');process.exitCode=2;}
