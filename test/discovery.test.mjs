import test from 'node:test';
import assert from 'node:assert/strict';
import {detectProfile,resolveConfig,profiles} from '../profiles.mjs';
const profile=profiles.find(p=>p.id==='workbuddy');
function context(platform,exe,script){return {processes:{resolve:async(candidates,files)=>{
 if(files)return {platform,executables:exe?[exe]:[],files:script?[script]:[]};
 return {platform,executables:candidates.length?['/bin/codebuddy']:[]};
}}};}
test('desktop bundle wins over a separately logged-in PATH CLI',async()=>{
 const value=await detectProfile(context('windows','C:/Programs/WorkBuddy/WorkBuddy.exe','C:/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy'),profile);
 assert.equal(value.transport,'workbuddy-http');assert.equal(value.launchMode,'auto');
});
test('never pair executable with a script from another installation',async()=>{
 const value=await detectProfile(context('windows','C:/A/WorkBuddy.exe','C:/B/resources/cli/bin/codebuddy'),profile);
 assert.equal(value.transport,undefined);assert.equal(value.executable,'/bin/codebuddy');
});
test('automatic desktop-to-CLI switch clears desktop transport and injected environment',async()=>{
 const value=await resolveConfig(context('linux'),{launchMode:'auto',executable:'old',transport:'workbuddy-http',env:{ELECTRON_RUN_AS_NODE:'1',CODEBUDDY_CONFIG_DIR:'old',CUSTOM:'keep'}},profile);
 assert.equal(value.transport,'stdio');assert.deepEqual(value.env,{CUSTOM:'keep'});
});
test('manual executable and environment stay untouched',async()=>{
 const value={launchMode:'manual',executable:'chosen',env:{CUSTOM:'keep'}};
 assert.equal(await resolveConfig(context('linux'),value,profile),value);
});
