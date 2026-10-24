// This module contains no database credential. A parent process owns the TEST
// lease and permits only this fixture's verification, worker job and retirement.
async function parent(action,fixture,created){
 const origin=process.env.METER_FIXTURE_LIFECYCLE_URL,token=process.env.METER_FIXTURE_LIFECYCLE_TOKEN;
 if(!origin||!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)||!token)throw new Error('Missing parent TEST fixture lease channel.');
 const reply=await fetch(origin,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({action,fixtureId:fixture.fixtureId,created}),signal:AbortSignal.timeout(action==='process'?16*60_000:90_000)});
 if(!reply.ok)throw new Error(`Parent TEST fixture ${action} failed (${reply.status}).`);
 return reply.json();
}
export const verifyFixture=fixture=>parent('verify',fixture);
export const retireFixture=(fixture,created)=>parent('retire',fixture,created);
export const processCapture=(fixture,captureId)=>parent('process',fixture,{captureId});
