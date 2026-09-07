// Pure, serialized state transitions. Coordinates use positive y downward.
export const RULES = Object.freeze({version: 1, width: 10, height: 24, hidden: 4,
  locksPerTurn: 7, maxLocks: 280, nextCount: 5,
  normal: [0,0,1,2,4], full: [0,2,4,6], mini: [0,0,1,6],
  combo: [0,0,1,1,2,2,3,3,4,4,5], b2bBonus: 1, perfectClear: 10});
export const TYPES = ['I','J','L','O','S','T','Z'];
const BASE = {I:[[0,1],[1,1],[2,1],[3,1]], J:[[0,0],[0,1],[1,1],[2,1]],
  L:[[2,0],[0,1],[1,1],[2,1]], O:[[1,0],[2,0],[1,1],[2,1]],
  S:[[1,0],[2,0],[0,1],[1,1]], T:[[1,0],[0,1],[1,1],[2,1]], Z:[[0,0],[1,0],[1,1],[2,1]]};
export const SHAPES = Object.fromEntries(TYPES.map(t => {
  const rotations = [BASE[t]];
  for (let r=1;r<4;r++) rotations.push(t==='O' ? BASE.O : rotations[r-1].map(([x,y])=>[(t==='I'?3:2)-y,x]));
  return [t,rotations];
}));
// Published SRS tables use y upward; rotate() converts to board coordinates.
const JLSTZ = {
  '0>1':[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]], '1>0':[[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '1>2':[[0,0],[1,0],[1,-1],[0,2],[1,2]], '2>1':[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '2>3':[[0,0],[1,0],[1,1],[0,-2],[1,-2]], '3>2':[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '3>0':[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]], '0>3':[[0,0],[1,0],[1,1],[0,-2],[1,-2]]};
const I_KICKS = {
  '0>1':[[0,0],[-2,0],[1,0],[-2,-1],[1,2]], '1>0':[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '1>2':[[0,0],[-1,0],[2,0],[-1,2],[2,-1]], '2>1':[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '2>3':[[0,0],[2,0],[-1,0],[2,1],[-1,-2]], '3>2':[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '3>0':[[0,0],[1,0],[-2,0],[1,-2],[-2,1]], '0>3':[[0,0],[-1,0],[2,0],[-1,2],[2,-1]]};

export const emptyBoard = () => Array.from({length:RULES.height},()=>Array(RULES.width).fill('.'));
export const clone = value => structuredClone(value);
export function random(stream) {
  let x=stream.value>>>0;
  x^=x<<13; x^=x>>>17; x^=x<<5;
  stream.value=x>>>0;
  return stream.value/4294967296;
}
function stream(seed) { return {value:(seed>>>0)||0x9e3779b9}; }
function refill(p) {
  while(p.queue.length<6) {
    if(!p.bag.length) {
      p.bag=[...TYPES];
      for(let i=6;i>0;i--) { const j=Math.floor(random(p.pieceRng)*(i+1)); [p.bag[i],p.bag[j]]=[p.bag[j],p.bag[i]]; }
    }
    p.queue.push(p.bag.shift());
  }
}
export function takeNext(p, simulation=false) {
  if(!simulation) refill(p);
  const piece=p.queue.shift()??null;
  if(!simulation) refill(p);
  return piece;
}
export function createGame({seeds=[12345,67890], first=0, maxLocks=RULES.maxLocks}={}) {
  if(!Array.isArray(seeds)||seeds.length!==2||seeds.some(x=>!Number.isInteger(x)||x<1||x>0xffffffff)) throw Error('Two nonzero uint32 seeds required');
  if(![0,1].includes(first)||!Number.isInteger(maxLocks)||maxLocks<1||maxLocks>100000) throw Error('Invalid first/maxLocks');
  const players=seeds.map(seed=>{
    const p={board:emptyBoard(),current:null,hold:null,queue:[],bag:[],pieceRng:stream(seed),garbageRng:stream(seed^0xa5a5a5a5),
      pending:[],b2b:false,combo:-1,stats:{locks:0,lines:0,attack:0,sent:0,cancelled:0,received:0,garbageCellsCleared:0,garbageRowsCleared:0}};
    p.current=takeNext(p); return p;
  });
  return {rules:{...clone(RULES),maxLocks},seeds:[...seeds],players,active:first,remaining:RULES.locksPerTurn,locks:0,status:'playing',winner:null,last:null};
}
export function cells(piece, position) { return SHAPES[piece][position.r].map(([x,y])=>[x+position.x,y+position.y]); }
export function fits(board,piece,position) { return cells(piece,position).every(([x,y])=>x>=0&&x<10&&y>=0&&y<24&&board[y][x]==='.'); }
export const spawn = () => ({x:3,y:2,r:0,kick:-1});
export function rotate(board,piece,position,direction) {
  if(piece==='O') return null;
  const r=(position.r+direction+4)%4;
  const tests=(piece==='I'?I_KICKS:JLSTZ)[`${position.r}>${r}`];
  for(let i=0;i<tests.length;i++) {
    const [dx,dy]=tests[i], next={x:position.x+dx,y:position.y-dy,r,kick:piece==='T'?i:-1};
    if(fits(board,piece,next)) return next;
  }
  return null;
}
export function motion(board,piece,position,op) {
  if(op==='CW'||op==='CCW') return rotate(board,piece,position,op==='CW'?1:-1);
  if(op==='HD') {
    let next={...position};
    while(fits(board,piece,{...next,y:next.y+1})) next={...next,y:next.y+1,kick:-1};
    return next;
  }
  const offset={L:[-1,0],R:[1,0],D:[0,1]}[op];
  if(!offset) throw Error('Unknown operation');
  const next={...position,x:position.x+offset[0],y:position.y+offset[1],kick:-1};
  return fits(board,piece,next)?next:null;
}
export function spinType(board,piece,position) {
  if(piece!=='T'||position.kick<0) return 'none';
  const cx=position.x+1,cy=position.y+1;
  const blocked=(x,y)=>x<0||x>=10||y<0||y>=24||board[y][x]!=='.';
  const corners=[blocked(cx-1,cy-1),blocked(cx+1,cy-1),blocked(cx+1,cy+1),blocked(cx-1,cy+1)];
  if(corners.filter(Boolean).length<3) return 'none';
  const front=[[0,1],[1,2],[2,3],[3,0]][position.r];
  return (front.every(i=>corners[i])||position.kick===4)?'full':'mini';
}
function reachable(board,piece,useHold) {
  const initial=spawn();
  if(!fits(board,piece,initial)) return [];
  const nodes=[{p:initial,parent:-1,op:null}], seen=new Set(), landings=new Map();
  const key=p=>`${p.x},${p.y},${p.r},${p.kick}`;
  seen.add(key(initial));
  function path(index) {
    const result=['HD'];
    while(nodes[index].parent!==-1) { result.push(nodes[index].op); index=nodes[index].parent; }
    return result.reverse();
  }
  for(let i=0;i<nodes.length;i++) {
    const p=nodes[i].p, landing=motion(board,piece,p,'HD');
    const occupied=cells(piece,landing).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
    const spin=spinType(board,piece,landing), k=`${useHold?1:0}:${occupied.map(c=>c.join(',')).join(';')}:${spin}`;
    if(!landings.has(k)) landings.set(k,{piece,useHold,cells:occupied,spin,position:landing,path:path(i),key:k});
    for(const op of ['L','R','D','CW','CCW']) {
      const next=motion(board,piece,p,op);
      if(next&&!seen.has(key(next))) { seen.add(key(next)); nodes.push({p:next,parent:i,op}); }
    }
  }
  return [...landings.values()];
}
export function legalMoves(game) {
  if(game.status!=='playing') return [];
  const p=game.players[game.active];
  if(!p.current||!fits(p.board,p.current,spawn())) return [];
  const moves=reachable(p.board,p.current,false), held=p.hold??p.queue[0];
  if(held) moves.push(...reachable(p.board,held,true));
  moves.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  return moves.map((m,i)=>({...m,id:`m${String(i).padStart(4,'0')}`}));
}
export function publicMove(m) { return {id:m.id,hold:m.useHold,piece:m.piece,cells:m.cells,rotation:m.position.r,lastRotationKick:m.position.kick,spin:m.spin}; }
export const pendingCount = p => p.pending.reduce((a,n)=>a+n,0);
export function attackFor(rules,lines,spin,previousB2b,combo,perfectClear) {
  const difficult=lines>0&&(lines===4||spin!=='none');
  const base=rules[spin==='none'?'normal':spin][lines]??0;
  return {attack:lines===0?0:base+(difficult&&previousB2b?rules.b2bBonus:0)+rules.combo[Math.min(combo,rules.combo.length-1)]+(perfectClear?rules.perfectClear:0),
    b2b:lines===0?previousB2b:difficult};
}
function lose(g,actor,reason) { g.status='finished';g.winner=1-actor;g.reason=reason; }
export function replayPath(board,piece,path) {
  let pos=spawn();
  if(!fits(board,piece,pos)) throw Error('Spawn collision');
  if(path.at(-1)!=='HD'||path.slice(0,-1).includes('HD')) throw Error('Path must end with exactly one hard drop');
  for(const op of path) { pos=motion(board,piece,pos,op); if(!pos) throw Error('Unreachable path'); }
  return pos;
}
export function applyMove(game,move,{simulation=false}={}) {
  if(game.status!=='playing') throw Error('Game is not playing');
  const g=clone(game), actor=g.active,p=g.players[actor],opponent=g.players[1-actor];
  if(!p.current||!fits(p.board,p.current,spawn())) throw Error('Active spawn collision');
  let piece=p.current;
  if(move.useHold) {
    piece=p.hold??takeNext(p,simulation);
    if(!piece) throw Error('Unknown hold piece');
    p.hold=p.current;
  }
  if(piece!==move.piece) throw Error('Move piece mismatch');
  const pos=replayPath(p.board,piece,move.path);
  const occupied=cells(piece,pos).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  if(JSON.stringify(occupied)!==JSON.stringify(move.cells)||spinType(p.board,piece,pos)!==move.spin) throw Error('Move/path mismatch');
  let spin=spinType(p.board,piece,pos);
  for(const [x,y] of occupied) p.board[y][x]=piece;
  const removed=p.board.filter(row=>row.every(c=>c!=='.')),lines=removed.length;
  if(spin==='mini'&&lines===3) spin='full';
  const garbageCells=removed.flat().filter(c=>c==='G').length,garbageRows=removed.filter(row=>row.includes('G')).length;
  p.board=p.board.filter(row=>row.some(c=>c==='.'));
  while(p.board.length<24) p.board.unshift(Array(10).fill('.'));
  const perfectClear=lines>0&&p.board.every(row=>row.every(c=>c==='.'));
  p.combo=lines?p.combo+1:-1;
  const score=attackFor(g.rules,lines,spin,p.b2b,p.combo,perfectClear); p.b2b=score.b2b;
  let outgoing=score.attack,cancelled=0;
  while(outgoing>0&&p.pending.length) {
    const n=Math.min(outgoing,p.pending[0]);outgoing-=n;cancelled+=n;p.pending[0]-=n;
    if(p.pending[0]===0) p.pending.shift();
  }
  if(outgoing) opponent.pending.push(outgoing);
  const received=lines===0?pendingCount(p):0;
  if(simulation&&received>0) return {state:null,boundary:'unknown-garbage',result:{actor,lines,spin,attack:score.attack,cancelled,sent:outgoing,received}};
  const holes=[]; let overflow=false;
  for(let i=0;i<received;i++) {
    if(p.board.shift().some(c=>c!=='.')) overflow=true;
    const hole=Math.floor(random(p.garbageRng)*10);holes.push(hole);
    p.board.push(Array.from({length:10},(_,x)=>x===hole?'.':'G'));
  }
  if(received) p.pending=[];
  for(const [key,value] of Object.entries({locks:1,lines,attack:score.attack,sent:outgoing,cancelled,received,garbageCellsCleared:garbageCells,garbageRowsCleared:garbageRows})) p.stats[key]+=value;
  g.locks++;g.remaining--;
  p.current=takeNext(p,simulation);
  g.last={actor,moveId:move.id,piece,hold:move.useHold,lines,spin,perfectClear,attack:score.attack,cancelled,sent:outgoing,received,holes,garbageCells,garbageRows};
  if(overflow||p.board.slice(0,g.rules.hidden).some(row=>row.some(c=>c!=='.'))) lose(g,actor,overflow?'garbage-overflow':'lock-out');
  let boundary=null;
  if(g.status==='playing') {
    if(g.remaining===0) {
      g.active=1-actor;g.remaining=g.rules.locksPerTurn;
      if(simulation) boundary='turn-end';
    }
    if(!boundary) {
      const next=g.players[g.active];
      if(!next.current) boundary='unknown-next';
      else if(!fits(next.board,next.current,spawn())) lose(g,g.active,'block-out');
    }
  }
  if(g.status==='playing'&&g.locks>=g.rules.maxLocks) {g.status='finished';g.winner=null;g.reason='lock-limit';}
  if(g.status!=='playing') boundary='terminal';
  return {state:g,result:g.last,boundary};
}
