import test from 'node:test';
import assert from 'node:assert/strict';
import {RULES,TYPES,emptyBoard,createGame,legalMoves,applyMove,replayPath,cells,rotate,fits,spinType,motion,attackFor,clone,pendingCount} from '../src/engine.js';
import {PreviewSession,observe,knownState} from '../src/observation.js';

test('independent seeded streams produce reproducible seven-piece bags',()=>{
  const game=createGame();assert.deepEqual(game,createGame());assert.notDeepEqual(game.players[0].pieceRng,game.players[1].pieceRng);
  for(const p of game.players) assert.deepEqual([p.current,...p.queue].sort(),[...TYPES].sort());
});
test('open-board placement counts and every SRS path agree with coordinates',()=>{
  const expected={I:17,O:9,T:34,J:34,L:34,S:17,Z:17};
  for(const type of TYPES) {
    const g=createGame();g.players[0].current=type;
    const moves=legalMoves(g).filter(m=>!m.useHold);
    assert.equal(moves.length,expected[type],type);
    for(const m of moves) {
      const pos=replayPath(g.players[0].board,type,m.path);
      assert.deepEqual(cells(type,pos).sort((a,b)=>a[1]-b[1]||a[0]-b[0]),m.cells);
      assert.equal(fits(g.players[0].board,type,{...pos,y:pos.y+1}),false);
    }
  }
});
test('JLSTZ left wall, floor kick and I-specific left wall kick',()=>{
  const b=emptyBoard();
  assert.deepEqual(rotate(b,'T',{x:-1,y:8,r:1,kick:-1},-1),{x:0,y:8,r:0,kick:1});
  assert.deepEqual(rotate(b,'T',{x:3,y:22,r:0,kick:-1},1),{x:2,y:21,r:1,kick:2});
  assert.deepEqual(rotate(b,'I',{x:-2,y:8,r:1,kick:-1},-1),{x:0,y:8,r:0,kick:-1});
});
test('blocked kick tests fail without tunneling',()=>{
  const b=Array.from({length:24},()=>Array(10).fill('G'));
  const p={x:3,y:10,r:0,kick:-1};for(const [x,y]of cells('T',p))b[y][x]='.';
  assert.equal(rotate(b,'T',p,1),null);assert.equal(rotate(b,'T',p,-1),null);
});
test('sealed cavities never appear in reachable placements',()=>{
  const g=createGame();g.players[0].current='O';g.players[0].board[19]=Array(10).fill('G');
  const moves=legalMoves(g);assert(moves.length>0);assert(moves.every(m=>m.cells.every(([,y])=>y<19)));
});
test('T-spin fronts, mini, fifth kick, and zero-distance drop semantics',()=>{
  const b=emptyBoard(),p={x:3,y:21,r:0,kick:0};
  b[21][3]='G';b[21][5]='G';b[23][3]='G';
  assert.equal(spinType(b,'T',p),'full');
  b[21][5]='.';b[23][5]='G';assert.equal(spinType(b,'T',p),'mini');
  assert.equal(spinType(b,'T',{...p,kick:4}),'full');
  assert.equal(spinType(b,'T',{...p,kick:-1}),'none');
  assert.equal(motion(b,'T',p,'HD').kick,0);
  assert.equal(motion(emptyBoard(),'T',{...p,y:0},'HD').kick,-1);
});
test('reachable same-cell placements preserve distinct spin outcomes',()=>{
  const g=createGame();g.players[0].current='T';const b=g.players[0].board;
  b[21][3]='G';b[21][5]='G';b[23][3]='G';
  const moves=legalMoves(g).filter(m=>!m.useHold),groups=new Map();
  for(const move of moves) {const key=JSON.stringify(move.cells);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(move);}
  const pair=[...groups.values()].find(ms=>ms.some(m=>m.spin==='none')&&ms.some(m=>m.spin!=='none'));
  assert(pair,'A slide and a finishing rotation must remain separate candidates');
  for(const move of pair)assert.equal(applyMove(g,move).result.spin,move.spin);
});
test('attack table, B2B, REN, and additive perfect clear',()=>{
  assert.deepEqual(attackFor(RULES,4,'none',false,0,false),{attack:4,b2b:true});
  assert.equal(attackFor(RULES,4,'none',true,2,false).attack,6);
  assert.deepEqual(attackFor(RULES,1,'none',true,0,false),{attack:0,b2b:false});
  assert.deepEqual(attackFor(RULES,0,'full',true,-1,false),{attack:0,b2b:true});
  assert.equal(attackFor(RULES,2,'full',false,0,false).attack,4);
  assert.equal(attackFor(RULES,1,'mini',false,0,false).attack,0);
  assert.equal(attackFor(RULES,4,'none',true,100,true).attack,20);
});
function fourClear() {
  const g=createGame();g.players[0].current='I';
  for(let y=20;y<24;y++)g.players[0].board[y]=Array.from({length:10},(_,x)=>x===4?'.':'G');
  const move=legalMoves(g).find(m=>!m.useHold&&m.cells.every(([x])=>x===4));assert(move);return {g,move};
}
test('four-line clear, perfect clear, FIFO cancellation and immediate delivery',()=>{
  const {g,move}=fourClear();g.players[0].pending=[3,2];g.players[1].pending=[1];
  const result=applyMove(g,move);assert.equal(result.result.lines,4);assert.equal(result.result.perfectClear,true);
  assert.equal(result.result.attack,14);assert.equal(result.result.cancelled,5);assert.equal(result.result.sent,9);
  assert.deepEqual(result.state.players[0].pending,[]);assert.deepEqual(result.state.players[1].pending,[1,9]);
  assert.equal(result.state.players[0].stats.garbageRowsCleared,4);assert.equal(result.state.players[0].stats.garbageCellsCleared,36);
  assert.equal(g.locks,0);assert.deepEqual(g.players[0].pending,[3,2]);
});
test('line clear keeps uncancelled pending and preserves unconsumed hole RNG',()=>{
  const {g,move}=fourClear();g.players[0].pending=[20,2];const rng=clone(g.players[0].garbageRng);
  const {state,result}=applyMove(g,move);assert.deepEqual(state.players[0].pending,[6,2]);assert.equal(result.received,0);
  assert.deepEqual(state.players[0].garbageRng,rng);
});
test('nonclear raises all garbage once with reproducible holes',()=>{
  const g=createGame();g.players[0].pending=[2,1];const move=legalMoves(g)[0];
  const a=applyMove(g,move),b=applyMove(g,move);assert.deepEqual(a,b);assert.equal(a.result.received,3);assert.equal(a.result.holes.length,3);
  assert.equal(pendingCount(a.state.players[0]),0);assert.notDeepEqual(a.state.players[0].garbageRng,g.players[0].garbageRng);
  for(const row of a.state.players[0].board.slice(-3))assert.equal(row.filter(c=>c==='.').length,1);
});
test('empty and occupied HOLD each count as one lock and consume correct queue',()=>{
  const g=createGame(),p=g.players[0];const move=legalMoves(g).find(m=>m.useHold);
  const first=applyMove(g,move).state;assert.equal(first.locks,1);assert.equal(first.remaining,6);
  assert.equal(first.players[0].hold,p.current);assert.equal(first.players[0].current,p.queue[1]);
  const second=applyMove(first,legalMoves(first).find(m=>m.useHold)).state;
  assert.equal(second.players[0].hold,first.players[0].current);assert.equal(second.players[0].current,first.players[0].queue[0]);assert.equal(second.locks,2);
});
test('seventh lock changes actor and fixed lock limit draws',()=>{
  const g=createGame({maxLocks:1});g.remaining=1;
  const {state}=applyMove(g,legalMoves(g)[0]);assert.equal(state.active,1);assert.equal(state.remaining,7);assert.equal(state.status,'finished');assert.equal(state.winner,null);
});
test('spawn collision blocks HOLD rescue; garbage overflow loses before lock-limit draw',()=>{
  const g=createGame();for(const [x,y]of cells(g.players[0].current,{x:3,y:2,r:0}))g.players[0].board[y][x]='G';
  assert.deepEqual(legalMoves(g),[]);
  const other=createGame({maxLocks:1});other.players[0].pending=[24];
  const {state}=applyMove(other,legalMoves(other)[0]);assert.equal(state.status,'finished');assert.equal(state.winner,1);assert.equal(state.reason,'garbage-overflow');
});
test('path tampering cannot change a legal landing',()=>{
  const g=createGame(),move=legalMoves(g)[0];assert.throws(()=>applyMove(g,{...move,path:['HD']}),/mismatch/);
  assert.throws(()=>applyMove(g,{...move,path:['HD','L','HD']}),/exactly one/);
});
test('observation contains all rows but excludes private future and RNG',()=>{
  const g=createGame(),obs=observe(g),text=JSON.stringify(obs);
  assert.equal(obs.self.board.length,24);assert.equal(obs.opponent.board.length,24);assert.equal(obs.self.next.length,5);
  for(const field of ['pieceRng','garbageRng','seeds','bag','path'])assert(!text.includes(`"${field}"`));
  assert(!Object.hasOwn(obs.opponent,'next'));assert(!Object.hasOwn(obs.opponent,'current'));
});
test('preview is invariant under private information changes',()=>{
  const a=createGame(),b=clone(a);b.players[0].queue[5]='T';b.players[0].pieceRng.value=123;b.players[0].garbageRng.value=321;
  b.players[1].current='O';b.players[1].queue=['O','O'];b.players[1].bag=['Z'];b.seeds=[1,2];
  assert.deepEqual(knownState(a),knownState(b));
  const sa=new PreviewSession(a),sb=new PreviewSession(b),move=legalMoves(a)[0];assert.deepEqual(sa.run('root',move.id),sb.run('root',move.id));
  assert.deepEqual(a,createGame());
});
test('unknown garbage boundary consumes one transition and reveals no holes or board',()=>{
  const g=createGame();g.players[0].pending=[2];const s=new PreviewSession(g,1);
  const r=s.run('root',legalMoves(g)[0].id);assert.equal(r.boundary,'unknown-garbage');assert.equal(r.observation,null);assert(!Object.hasOwn(r.result,'holes'));
  assert.throws(()=>s.run('root',legalMoves(g)[0].id),/budget/);assert.equal(s.used,1);
});
test('preview stops at own turn boundary without observing opponent spawn',()=>{
  const g=createGame();g.remaining=1;const s=new PreviewSession(g);const r=s.run('root',legalMoves(g)[0].id);
  assert.equal(r.boundary,'turn-end');assert.deepEqual(r.observation.legalMoves,[]);assert.throws(()=>s.run(r.node,'m0000'),/terminal/);
});
test('unknown empty HOLD is excluded and final known piece can be placed',()=>{
  const g=knownState(createGame());g.players[0].queue=[];g.players[0].hold=null;
  assert(legalMoves(g).every(m=>!m.useHold));
  const s=new PreviewSession(g),r=s.run('root',legalMoves(g)[0].id);assert.equal(r.boundary,'unknown-next');assert(r.observation);assert.equal(r.observation.self.current,null);
});
test('representative reachable moves in irregular boards execute identically',()=>{
  for(let seed=1;seed<=5;seed++) {
    let g=createGame({seeds:[seed,seed+100]});
    for(let i=0;i<16&&g.status==='playing';i++) {
      const moves=legalMoves(g);if(!moves.length)break;
      for(const m of [moves[0],moves[Math.floor(moves.length/2)],moves.at(-1)])assert.doesNotThrow(()=>applyMove(g,m));
      g=applyMove(g,moves[(i*13+seed)%moves.length]).state;
    }
  }
});
