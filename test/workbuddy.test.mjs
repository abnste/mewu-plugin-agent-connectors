// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {workbuddyProcess} from '../workbuddy.mjs';

test('desktop bridge forwards unary JSON results/errors and streaming SSE', {timeout:15000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'workbuddy-bridge-'));
  const cli=join(dir,'cli.cjs');
  await writeFile(cli,`
    const http=require('node:http');
    http.createServer((req,res)=>{
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.url.endsWith('/connect'))return res.end(JSON.stringify({connectionId:'test'}));
      if(req.headers['acp-connection-id']!=='test'){res.writeHead(400);return res.end();}
      let body='';req.on('data',c=>body+=c);req.on('end',()=>{
        const m=JSON.parse(body);
        if(m.method==='session/prompt'){
          res.setHeader('Content-Type','text/event-stream');
          res.write('event: message\\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{text:'ok'}})+'\\n\\n');
          return res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})+'\\n\\n');
        }
        if(m.method==='invalid')return res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown method'}}));
        res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}));
      });
    }).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
  `);
  const config=workbuddyProcess({transport:'workbuddy-http',args:[cli]});
  const child=spawn(process.execPath,config.args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const lines=createInterface({input:child.stdout});
  t.after(async()=>{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));await rm(dir,{recursive:true,force:true});});
  const queue=[],pending=[];
  lines.on('line',line=>{const value=JSON.parse(line);const next=pending.shift();if(next)next(value);else queue.push(value);});
  const read=()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>pending.push(resolve));
  const send=(id,method)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params:{}})+'\n');
  send(1,'initialize');
  assert.deepEqual(await read(),{jsonrpc:'2.0',id:1,result:{protocolVersion:1}});
  send(2,'session/prompt');
  assert.equal((await read()).method,'session/update');
  assert.deepEqual(await read(),{jsonrpc:'2.0',id:2,result:{stopReason:'end_turn'}});
  send(3,'invalid');
  assert.deepEqual(await read(),{jsonrpc:'2.0',id:3,error:{code:-32601,message:'Unknown method'}});
});
