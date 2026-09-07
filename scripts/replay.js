import assert from 'node:assert/strict';
import {readRun,hashState} from '../src/match.js';
import {applyMove} from '../src/engine.js';
const id=process.argv[2];if(!id) throw Error('Usage: npm run replay -- RUN_ID');
const records=await readRun(id);let state=records[0].initialState,count=0;
assert.equal(hashState(state),records[0].initialHash);
for(const record of records.filter(r=>r.type==='decision')) {
  assert.equal(hashState(state),record.beforeHash);
  if(record.move&&!record.error) state=applyMove(state,record.move).state;
  if(record.error||record.state.status==='aborted') {
    state.status=record.state.status;state.winner=record.state.winner;state.reason=record.state.reason;
  }
  assert.deepEqual(state,record.state);assert.equal(hashState(state),record.afterHash);count++;
}
const end=records.findLast(r=>r.type==='end');
if(end) {
  if(end.status==='aborted'&&state.status==='playing') {state.status='aborted';state.reason='user-stop';state.winner=null;}
  assert.equal(hashState(state),end.stateHash);
  if(end.state)assert.deepEqual(state,end.state);
}
console.log(`Verified ${count} decisions: ${id}`);
