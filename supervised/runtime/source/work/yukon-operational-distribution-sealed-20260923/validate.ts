import {readFileSync} from 'node:fs';
import {validateEntry} from '../yukon-resource-session-locator-20260923/config';
try{validateEntry(JSON.parse(readFileSync(process.argv[2],'utf8')),process.argv[3]==='retire');console.log('Public configuration valid');}catch{process.stderr.write('Public configuration rejected\n');process.exitCode=2;}
