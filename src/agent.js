import {agentExecution} from './agent-identity.js';
import {performance} from 'node:perf_hooks';
import {clone,legalMoves} from './engine.js';
import {observe,PreviewSession} from './observation.js';
import {systemPrompt} from './players.js';

export class AgentTurn {
  constructor(game,config,memo,decisionId) {
    this.config=config;this.id=decisionId;this.started=performance.now();this.moves=legalMoves(game);this.errors=0;
    this.session=config.preview?new PreviewSession(game,config.transitions):null;
    this.previews=new Map();
    this.request={configuredExecution:agentExecution(config),protocol:`stackingbench.${config.type}-session.v1`,decisionId,
      prompt:systemPrompt(config,game.rules)+
        `\nYou are playing through an existing ${config.type==='agy'?'Antigravity CLI (agy)':'Codex'} session. Use only the agent observation and preview endpoints for this match. Do not read full run files, viewer APIs, seeds, engine state, or use a separate search program to select moves. Submit one root move with decisionId and moveId through the agent choose command. The host does not call a model or automatically wake this session.`,
      observation:observe(game,this.moves,memo),preview:{enabled:config.preview,budget:config.preview?config.transitions:0},
      context:`existing-${config.type}-session; full conversation and internal reasoning are not captured`};
  }
  check(input,keys) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('JSON object required');
    if(input.decisionId!==this.id)throw Error('Stale decisionId; observe the current position');
    if(Object.keys(input).some(k=>!keys.includes(k)))throw Error('Unexpected input property');
    if(typeof input.moveId!=='string')throw Error('moveId must be a string');
  }
  preview(input) {
    this.check(input,['decisionId','moveId','node','requestId']);
    if(!this.session)throw Error('Previews are disabled for this player');
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId))throw Error('preview requires a requestId (1-80 letters, digits, _ or -)');
    const request={decisionId:input.decisionId,moveId:input.moveId,node:input.node??'root',requestId:input.requestId};
    const cached=this.previews.get(input.requestId);
    if(cached) {
      if(JSON.stringify(cached.request)!==JSON.stringify(request))throw Error('requestId already used for a different preview');
      return clone(cached.response);
    }
    const response={decisionId:this.id,...this.session.run(request.node,request.moveId)};
    this.previews.set(input.requestId,{request,response});return clone(response);
  }
  decision(input) {
    this.check(input,['decisionId','moveId','memo','reason','agentModel','reasoningEffort']);
    const move=this.moves.find(m=>m.id===input.moveId);
    if(!move)throw Error('Unknown root moveId');
    for(const [key,max] of [['memo',240],['reason',400]])
      if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>max))throw Error(`${key} must be a string of at most ${max} characters`);
    const execution=agentExecution(this.config,input);
    return {execution,move:clone(move),memo:input.memo??'',reason:input.reason??'',
      metrics:{elapsedMs:performance.now()-this.started,pacingMs:0,transitions:this.session?.used??0,calls:0,
        promptTokens:null,completionTokens:null,usageMissing:1,invalidResponses:this.errors,cost:null,estimatedCostJpy:null},
      trace:{source:`${this.config.type}-session`,request:clone(this.request),response:clone(input),
        agentModel:{value:execution.model,provenance:execution.provenance.model},previews:clone(this.session?.history??[])}};
  }
}
