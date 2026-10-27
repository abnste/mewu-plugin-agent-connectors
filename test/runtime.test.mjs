// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {codexEffort,runCodex} from '../adapters.mjs';
import {html} from '../view.mjs';

test('reasoning choices come from the actual selected model, including case matching',()=>{
  const models=[{id:'other',default:true,efforts:['high']},{id:'selected',efforts:['low','CustomMode']}];
  assert.equal(codexEffort(models,{model:'selected',effort:' Low '}),'low');
  assert.equal(codexEffort(models,{model:'selected',effort:'custommode'}),'CustomMode');
  assert.equal(codexEffort(models,{effort:''}),undefined);
  assert.throws(()=>codexEffort(models,{model:'selected',effort:'high'}),error=>error.publicMessage===error.message);
  assert.throws(()=>codexEffort([{id:'selected',efforts:[]}],{model:'selected',effort:'low'}),/思考程度/);
});

function fixture(){
  const messages=[],queue=[];let closed=0;
  return {messages,closed:()=>closed,ctx:{events:{emit:async()=>{}},processes:{
    open:async()=>({id:'process',cwd:'/workspace'}),close:async()=>{closed++;},read:async()=>queue.shift(),
    write:async(_,m)=>{messages.push(m);let result;
      if(m.method==='initialize')result={};
      if(m.method==='account/read')result={requiresOpenaiAuth:false};
      if(m.method==='model/list')result={data:[{model:'selected',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
      if(m.method==='config/read')result={config:{}};
      if(m.method==='thread/start')result={thread:{id:'thread'}};
      if(m.method==='turn/start'){
        assert.equal(m.params.effort,'low');result={turn:{id:'turn'}};
        queue.push({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',delta:'ok'}});
        queue.push({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
      }
      if(result)queue.push({id:m.id,result});
    }
  }}};
}
test('a capitalized choice reaches the official wire as its advertised ID',async()=>{
  const f=fixture();const answer=await runCodex(f.ctx,{executable:'/agent',args:[],model:'selected',effort:'Low'},{task:'test'});
  assert.equal(answer.content,'ok');assert.equal(f.closed(),1);
  assert.equal(f.messages.filter(m=>m.method==='turn/start').length,1);
});
test('unsupported effort fails before creating a thread or sending a prompt',async()=>{
  const f=fixture();await assert.rejects(runCodex(f.ctx,{executable:'/agent',args:[],model:'selected',effort:'impossible'},{task:'test'}),/思考程度/);
  assert.equal(f.closed(),1);assert.equal(f.messages.some(m=>['thread/start','turn/start'].includes(m.method)),false);
});
test('machine-readable fields do not enable automatic capitalization',()=>{
  for(const match of html.matchAll(/<(?:input|textarea)\b[^>]*>/g))assert.match(match[0],/autocapitalize="off"/);
});
