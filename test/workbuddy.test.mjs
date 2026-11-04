// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import net from 'node:net';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
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
  const child=spawn(process.execPath,config.args,{env:{...process.env,CODEBUDDY_CONFIG_DIR:join(dir,'config'),WORKBUDDY_CONFIG_DIR:join(dir,'config')},stdio:['pipe','pipe','pipe'],windowsHide:true});
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

test('desktop sidecar owns credential bootstrap and only the bridge session is closed', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'workbuddy-managed-'));
 const root=join(dir,'config'),hash=(s,n)=>createHash('sha1').update(s).digest('hex').slice(0,n);
 const instance=hash(root,12),uid=process.getuid?.(),base=join(dir,uid===undefined?'wb':'wb-'+hash(String(uid),6),instance);
 await mkdir(base,{recursive:true});
 const uuid='1234abcd',socketPath=process.platform==='win32'?'\\\\.\\pipe\\workbuddy-'+instance+'-sidecar-control-'+uuid:join(base,'sidecar-'+uuid+'.sock');
 await writeFile(join(base,'sidecar.pid'),JSON.stringify({pid:42,token:'desktop-identity',version:6,controlPipeUuid:uuid}));
 const backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url.endsWith('/connect'))return res.end(JSON.stringify({connectionId:'managed'}));let body='';req.on('data',c=>body+=c);req.on('end',()=>{const m=JSON.parse(body);res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}));});});
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 let created,killed,wrongIdentity=false,delayPing=false;
 const server=net.createServer(socket=>{socket.on('error',()=>{});createInterface({input:socket}).on('line',line=>{const m=JSON.parse(line);let result;
  if(m.method==='sidecar.ping')result={pid:42,token:wrongIdentity?'wrong-identity':'desktop-identity',version:6};
  if(m.method==='session.create'){created=m.params;result={sessionId:created.sessionId,pid:43,runtimeId:'owned-runtime',acpEndpoint:'http://127.0.0.1:'+backend.address().port+'/api/v1/acp'};}
  if(m.method==='session.kill'){killed=m.params;result={ok:true};}
  const reply=()=>socket.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
  if(m.method==='sidecar.ping'&&delayPing)setTimeout(reply,350);else reply();
 });});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
 t.after(async()=>{server.close();backend.close();await rm(dir,{recursive:true,force:true});});
 const config=workbuddyProcess({transport:'workbuddy-http',args:[join(dir,'bundled-cli')]});
 const child=spawn(process.execPath,config.args,{env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir,XDG_RUNTIME_DIR:'',CODEBUDDY_CONFIG_DIR:root,WORKBUDDY_CONFIG_DIR:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
 const exit=new Promise(resolve=>child.once('exit',resolve));
 const lines=createInterface({input:child.stdout});
 const response=new Promise(resolve=>lines.once('line',line=>resolve(JSON.parse(line))));
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');
 assert.deepEqual(await response,{jsonrpc:'2.0',id:1,result:{protocolVersion:1}});
 assert.equal(created.port,0);assert.equal(created.command,process.execPath);
 assert.deepEqual(created.args,[join(dir,'bundled-cli'),'--serve','--host','127.0.0.1']);
 child.stdin.end();await exit;
 assert.deepEqual(killed,{sessionId:created.sessionId,expectedRuntimeId:'owned-runtime'});
 wrongIdentity=true;created=undefined;killed=undefined;
 const rejected=spawn(process.execPath,config.args,{env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir,XDG_RUNTIME_DIR:'',CODEBUDDY_CONFIG_DIR:root,WORKBUDDY_CONFIG_DIR:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
 const rejectedExit=new Promise(resolve=>rejected.once('exit',resolve));
 const rejectedResponse=new Promise(resolve=>createInterface({input:rejected.stdout}).once('line',line=>resolve(JSON.parse(line))));
 rejected.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'initialize',params:{}})+'\n');
 assert.equal((await rejectedResponse).error.code,-32603);
 rejected.stdin.end();await rejectedExit;
 assert.equal(created,undefined);assert.equal(killed,undefined);
 wrongIdentity=false;delayPing=true;
 const cancelled=spawn(process.execPath,config.args,{env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir,XDG_RUNTIME_DIR:'',CODEBUDDY_CONFIG_DIR:root,WORKBUDDY_CONFIG_DIR:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
 const cancelledExit=new Promise(resolve=>cancelled.once('exit',resolve));
 cancelled.stdin.end(JSON.stringify({jsonrpc:'2.0',id:3,method:'initialize',params:{}})+'\n');
 await cancelledExit;
 assert.equal(created,undefined);assert.equal(killed,undefined);
});
