export const isAgentPlayer=type=>['codex','agy','opencode','claude'].includes(type);
export const agentNames={codex:'Codex',agy:'Antigravity CLI (agy)',opencode:'OpenCode',claude:'Claude Code'};
export const agentDefaultModels={agy:'Gemini',opencode:'Model',claude:'Claude'};
export function rejectReasoningEffort(input) {
  if(Object.hasOwn(input,'reasoningEffort'))throw Error('reasoningEffort は廃止されました。推論レベルはモデル名（agentModel）に含めてください。');
}
// Session metadata is supplied by the user or agent, never inferred from an API model selector.
export function agentModel(value) {
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>160)throw Error('agentModel must be a string of at most 160 characters');
  return value.trim()||null;
}
export function agentExecution(config,input={}) {
  const suppliedModel=Object.hasOwn(input,'agentModel');
  const model=agentModel(suppliedModel?input.agentModel:config.agentModel);
  return {model,provenance:{model:model?(suppliedModel?'agent-reported':'user-configured'):'unknown'}};
}
