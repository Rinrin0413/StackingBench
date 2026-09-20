import {OPENAI_CHAT_PROTOCOL,TYPESAFE_PROTOCOL,capabilityDefaultsForModel} from './connections.js';

const STANDARD_FIELDS=new Set(['model','messages','temperature','max_tokens','max_completion_tokens','stream','response_format','reasoning_effort','chat_template_kwargs']);

export function portableActionSchema({preview=false}={}) {
  const properties={action:{type:'string',enum:['choose','preview']},move:{type:'string'}};
  const required=['action','move'];
  if(preview) properties.node={type:'string'};
  // Optional memo/reason fields deliberately stay out of the strict wire
  // schema. The StackingBench parser still accepts and records them when a
  // provider returns them, so this is a dialect projection, not a contract
  // change. In particular, no empty-string normalization is imposed here.
  return {type:'object',properties,required,additionalProperties:false};
}

function clone(value) {return value===undefined?undefined:structuredClone(value);}

function mergeExtensions(body,config) {
  const profile=config.connection;
  if(!profile)return body;
  for(const [key,value] of Object.entries(profile.requestDefaults??{})) {
    if(STANDARD_FIELDS.has(key.toLowerCase()))throw new Error(`Connection request default cannot override ${key}`);
    if(Object.hasOwn(body,key))throw new Error(`Connection request default conflicts with ${key}`);
    body[key]=clone(value);
  }
  const routing=config.routingPolicy??profile.routingPolicy;
  if(routing!==null&&routing!==undefined) {
    if(Object.hasOwn(body,'provider'))throw new Error('Connection routing policy is duplicated');
    body.provider=clone(routing);
  }
  return body;
}

export function responseFormatFor(config,actionSchema) {
  if(config.responseFormat==='plain')return undefined;
  if(config.responseFormat==='json')return {type:'json_object'};
  if(config.responseFormat!=='schema')throw new Error(`Unsupported response format: ${config.responseFormat}`);
  // Preserve the existing llama.cpp wire shape. Other OpenAI-compatible
  // dialects use the standard json_schema envelope and the smaller portable
  // projection above.
  if(config.connection?.id==='local-llamacpp'||config.provider==='llamacpp')return {type:'json_object',schema:clone(actionSchema)};
  if(config.connection&&capabilityDefaultsForModel(config.connection,config.modelId??config.model).jsonSchemaWire==='json_object-schema')return {type:'json_object',schema:clone(actionSchema)};
  return {type:'json_schema',json_schema:{name:'stackingbench_action',strict:true,schema:portableActionSchema({preview:config.type==='llm-preview'})}};
}

export function responseFormatPolicy(config) {
  if(config.connection?.protocol===TYPESAFE_PROTOCOL||config.responseFormat==='choice')return {mode:'typesafe-choice'};
  if(config.responseFormat==='plain')return {mode:'plain-json-instruction'};
  if(config.responseFormat==='json')return {mode:'json-object'};
  if(config.responseFormat==='schema') {
    const preview=config.type==='llm-preview';
    if(config.connection?.id==='local-llamacpp'||config.provider==='llamacpp')return {mode:'json-object-schema',schema:'action-schema-v1',preview};
    if(config.connection&&capabilityDefaultsForModel(config.connection,config.modelId??config.model).jsonSchemaWire==='json_object-schema')return {mode:'json-object-schema',schema:'action-schema-v1',preview};
    return {mode:'json-schema',schema:'portable-action-v1',strict:true,preview};
  }
  throw new Error(`Unsupported response format: ${config.responseFormat}`);
}

export function reasoningParameters(config) {
  if(config.thinking==='server-default')return {};
  const profile=config.connection;
  const capabilities=profile?capabilityDefaultsForModel(profile,config.modelId??config.model):{};
  const wire=profile?.reasoningWire??capabilities.reasoningWire;
  if(wire==='chat_template_kwargs') {
    if(config.thinking!=='off')throw new Error(`Reasoning level ${config.thinking} cannot be represented by chat_template_kwargs`);
    return {chat_template_kwargs:profile?.id==='sakura-ai'&&config.model==='preview/Kimi-K2.6'?{thinking:false}:{enable_thinking:false}};
  }
  if(wire==='reasoning_effort'&&['low','medium','high'].includes(config.thinking))return {reasoning_effort:config.thinking};
  if(wire==='reasoning_effort'&&config.thinking==='off'&&capabilities.reasoningOffValue!==undefined)return {reasoning_effort:capabilities.reasoningOffValue};
  // Unknown generic connections must not receive guessed provider-specific
  // parameters. Validation may reject a policy that needs a wire mapping.
  throw new Error(`Reasoning policy ${config.thinking} is not supported by the configured connection`);
}

export function buildChatRequest(config,messages,actionSchema,availableTokens) {
  const body={model:config.model,messages:clone(messages),temperature:config.temperature,max_tokens:Math.min(config.maxTokens,availableTokens),stream:false};
  const responseFormat=responseFormatFor(config,actionSchema);
  if(responseFormat)body.response_format=responseFormat;
  Object.assign(body,reasoningParameters(config));
  return mergeExtensions(body,config);
}

export function buildTypeSafeRequest(config,game,observation,instructions,criteria) {
  return {model:config.model,state:{rules:game.rules,observation},questions:{move:{type:'choice',instructions,criteria}}};
}

export function extractContent(data) { return data?.choices?.[0]?.message?.content; }
export function extractFinishReason(data) { return data?.choices?.[0]?.finish_reason; }
export function extractUsage(data) {
  if(data?.usage&&Number.isFinite(data.usage.prompt_tokens)&&Number.isFinite(data.usage.completion_tokens))return data.usage;
  if(data?.usage&&Number.isFinite(data.usage.input_tokens)&&Number.isFinite(data.usage.output_tokens))return {prompt_tokens:data.usage.input_tokens,completion_tokens:data.usage.output_tokens};
  return null;
}

function safeRoutingMetadata(value,depth=0) {
  if(depth>5)return undefined;
  if(typeof value==='string')return value.length<=300&&!value.includes('://')&&!value.includes('@')?value:undefined;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value==='boolean')return value;
  if(Array.isArray(value)) {const values=value.slice(0,20).map(item=>safeRoutingMetadata(item,depth+1)).filter(item=>item!==undefined);return values.length?values:undefined;}
  if(value&&typeof value==='object') {
    const result={};for(const [key,item] of Object.entries(value).slice(0,30)) {if(/provider|route|model|status|region|id|endpoint|available|selected|attempt|generation[_ ]?time|is[_-]?byok|requested|strategy|summary|total/i.test(key)&&!/token|secret|password|credential|authorization|api[-_]?key|url|host/i.test(key)){const safe=safeRoutingMetadata(item,depth+1);if(safe!==undefined)result[key]=safe;}}
    return Object.keys(result).length?result:undefined;
  }
  return undefined;
}

export function observedRoutingMetadata(data) {
  const observed={};
  for(const key of ['provider','provider_name','providerName','upstream_provider','upstreamProvider','route','routing']) {
    const value=safeRoutingMetadata(data?.[key]);if(value!==undefined)observed[key]=value;
  }
  for(const key of ['openrouter','openrouter_metadata','routing_metadata']) {
    const value=safeRoutingMetadata(data?.[key]);if(value!==undefined)observed[key]=value;
  }
  for(const [key,value] of Object.entries(data?.__transportMeta?.headers??{})) {
    const safe=safeRoutingMetadata(value);if(safe!==undefined)observed[`header:${key}`]=safe;
  }
  return Object.keys(observed).length?{status:'observed',metadata:observed}:{status:'unknown',reason:'response-did-not-report-routing'};
}

export function protocolFor(profile) {
  if(profile.protocol===OPENAI_CHAT_PROTOCOL||profile.protocol===TYPESAFE_PROTOCOL)return profile.protocol;
  throw new Error(`Unsupported protocol: ${profile.protocol}`);
}
