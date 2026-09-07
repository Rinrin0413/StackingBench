import {clone,legalMoves,publicMove,pendingCount,applyMove} from './engine.js';

export function observe(game,moves=legalMoves(game),memo='',actor=game.active) {
  const visible=p=>({board:p.board.map(row=>row.join('')),hold:p.hold,b2b:p.b2b,ren:p.combo,pending:pendingCount(p)});
  const own=game.players[actor];
  return {schema:'stackingbench.observation.v1',coordinates:{origin:'top-left',x:'right',y:'down',width:10,height:24,hiddenRows:4,empty:'.'},
    self:{...visible(own),current:own.current,next:own.queue.slice(0,game.rules.nextCount)},opponent:visible(game.players[1-actor]),
    actor,active:game.active,remainingLocks:game.remaining,totalLocks:game.locks,status:game.status,winner:game.winner,
    last:game.last,memo,legalMoves:moves.map(publicMove)};
}
export function knownState(game) {
  const g=clone(game),actor=g.active;
  delete g.seeds;
  for(let i=0;i<2;i++) {
    const p=g.players[i];
    p.queue=i===actor?p.queue.slice(0,g.rules.nextCount):[];
    if(i!==actor) p.current=null;
    p.bag=[];p.pieceRng=null;p.garbageRng=null;
    p.pending=pendingCount(p)?[pendingCount(p)]:[];
  }
  return g;
}
export class PreviewSession {
  constructor(game,budget=32) {
    this.actor=game.active;this.budget=budget;this.used=0;
    this.nodes=new Map([['root',{state:knownState(game),moves:legalMoves(game),rootMove:null}]]);
    this.history=[];
  }
  run(nodeId,moveId) {
    if(this.used>=this.budget) throw Error('Preview transition budget exhausted');
    const node=this.nodes.get(nodeId);
    if(!node||node.boundary) throw Error('Unknown or terminal preview node');
    const move=node.moves.find(m=>m.id===moveId);
    if(!move) throw Error('Unknown move ID at that node');
    this.used++;
    const transition=applyMove(node.state,move,{simulation:true}),id=`n${this.used}`;
    const child={...transition,rootMove:node.rootMove??moveId,moves:transition.state&&!transition.boundary?legalMoves(transition.state):[]};
    this.nodes.set(id,child);
    const result={node:id,rootMove:child.rootMove,boundary:child.boundary,used:this.used,budget:this.budget,result:child.result,
      observation:child.state?observe(child.state,child.moves,'',this.actor):null};
    this.history.push({request:{node:nodeId,move:moveId},response:result});
    return result;
  }
}
