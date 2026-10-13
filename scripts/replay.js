import assert from 'node:assert/strict';
import {streamRun,hashState} from '../src/match.js';
import {applyMove} from '../src/engine.js';
if(process.argv[2]==='--')process.argv.splice(2,1);
const id=process.argv[2];if(!id) throw Error('Usage: pnpm run replay -- RUN_ID');
let state,count=0;
for await(const record of streamRun(id)) {
  if(!state) {state=record.initialState;assert.equal(hashState(state),record.initialHash);continue;}
  if(record.type==='end') {
    if(record.status==='aborted'&&state.status==='playing') {state.status='aborted';state.reason='user-stop';state.winner=null;}
    assert.equal(hashState(state),record.stateHash);
    if(record.state)assert.deepEqual(state,record.state);
    continue;
  }
  if(record.type!=='decision')continue;
  assert.equal(hashState(state),record.beforeHash);
  if(record.move&&!record.error) state=applyMove(state,record.move).state;
  if(record.error||record.state.status==='aborted') {
    state.status=record.state.status;state.winner=record.state.winner;state.reason=record.state.reason;
  }
  assert.deepEqual(state,record.state);assert.equal(hashState(state),record.afterHash);count++;
}
assert(state,'Missing run header');
console.log(`Verified ${count} decisions: ${id}`);
