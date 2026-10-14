export const agentApi = `
let templates = [{ id:'reviewer', name:'Reviewer', description:'Review changes', systemPrompt:'Review evidence', domains:['开发'], projectId:null, modelBinding:{mode:'inherit'}, source:'user', builtin:false, enabled:true, policy:{permissionCeiling:'workspace-read',allowedTools:['file.read'],canDelegate:false} }];
window.roleSaves=[]; window.tree=[{ id:'delegate-1', parentRunId:'root-run', rootRunId:'root-run', childRunId:'child-run', childSessionId:'child-session', status:'completed', agentId:'agent-1', task:'Review task', agentInstance:{ name:'Review Agent',templateId:'reviewer',workspaceRoot:'/synthetic/project' }, execution:{depth:1,model:'review-model',providerId:'synthetic'}, structuredResult:{changedFiles:[]} }];
export async function listAgentTemplates(){return templates}
export async function saveAgentTemplate(input){ window.roleSaves.push(input); const template={...input,id:input.id??'new-role',source:input.projectId?'project':'user',builtin:false,policy:{permissionCeiling:input.permissionCeiling,allowedTools:input.allowedTools,canDelegate:input.canDelegate}}; templates=[template,...templates.filter(t=>t.id!==template.id)];return {template} }
export async function removeAgentTemplate(id){ templates=templates.filter(t=>t.id!==id);return {removed:true} }
export async function setAgentEnabled(id,enabled){templates=templates.map(t=>t.id===id?{...t,enabled}:t);return {agent:templates.find(t=>t.id===id)}}
export async function getDelegationTree(){return structuredClone(window.tree)}
export async function cancelDelegation(id){window.tree=window.tree.map(t=>t.id===id?{...t,status:'cancelled'}:t);return {accepted:true}}
`
export const providersApi = `export async function listProviderModels(){ return {models:[{model:'review-model',reasoningEffortSupported:true,reasoningOptions:[{value:'high',label:'高'}]}]} }`
export const projectsApi = `export async function listProjects(){return {projects:[{id:'project',name:'Project A'},{id:'other',name:'Project B'}]}}`
export const skillsApi = `window.savedSkills=[];window.skillQueries=[];
export async function listSkills(projectId){window.skillQueries.push(projectId);return {skills:[{id:projectId+'-skill'},...window.savedSkills.filter(skill=>!skill.projectId||skill.projectId===projectId)]}};export async function saveSkill(input){ window.savedSkills.push(input);return {plugin:{id:input.id}} }`
export const transportApi = `const listeners=new Set(); window.emitAgentEvent=event=>listeners.forEach(fn=>fn(event));window.listenerCount=()=>listeners.size;
export const transport={onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},request:async()=>({})};export const newRequestId=()=>crypto.randomUUID()`
export const sessionsApi = `export async function getSessionData(){return {session:{id:'child-session',projectId:'project'},messages:[{id:'assistant',runId:'child-run',role:'assistant',content:'Synthetic review result',reasoning:'',parts:[],status:'completed',createdAt:'2026-10-14T00:00:00Z',completedAt:'2026-10-14T00:00:01Z'}],runs:[{id:'child-run',model:'review-model',status:'completed',usage:null}],toolCalls:[],plans:[],runEvents:[],nextBefore:null}}`
