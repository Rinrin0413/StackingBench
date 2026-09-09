export const isAgentPlayer=type=>['codex','agy'].includes(type);
// Session metadata is supplied by the user or agent, never inferred from an API model selector.
export function agentModel(value) {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>160)throw Error('agentModel must be a string of at most 160 characters');
  return value.trim()||null;
}
export function reasoningEffort(value) {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string')throw Error('Invalid reasoningEffort');
  const effort=value.trim().toLowerCase();
  if(!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort))throw Error('Invalid reasoningEffort');
  return effort;
}
export function agentExecution(config,input={}) {
  const suppliedModel=Object.hasOwn(input,'agentModel'),suppliedEffort=Object.hasOwn(input,'reasoningEffort');
  const model=agentModel(suppliedModel?input.agentModel:config.agentModel);
  const effort=config.type==='agy'?null:reasoningEffort(suppliedEffort?input.reasoningEffort:config.reasoningEffort);
  return {model,reasoningEffort:effort,provenance:{model:model?(suppliedModel?'agent-reported':'user-configured'):'unknown',
    reasoningEffort:effort?(suppliedEffort?'agent-reported':'user-configured'):'unknown'}};
}
