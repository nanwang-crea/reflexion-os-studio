export const agentApi = `
let templates = [{ id:'reviewer', name:'Reviewer', description:'Review changes', systemPrompt:'Review evidence', domains:['开发'], projectId:null, modelBinding:{mode:'inherit'}, source:'user', builtin:false, enabled:true, policy:{permissionCeiling:'workspace-read',allowedTools:['file.read'],canDelegate:false} }];
window.setRoleTemplates=items=>{templates=items};
window.roleBulkRemovals=[];window.roleBulkSaves=[];window.roleSaves=[]; window.tree=[{ id:'delegate-1', parentRunId:'root-run', rootRunId:'root-run', childRunId:'child-run', childSessionId:'child-session', status:'completed', agentId:'agent-1', task:'Review task', agentInstance:{ name:'Review Agent',templateId:'reviewer',workspaceRoot:'/synthetic/project' }, execution:{depth:1,model:'review-model',providerId:'synthetic'}, structuredResult:{changedFiles:[]} }];
export async function exportAgentTeam(input){window.teamExports=(window.teamExports??[]).concat(input);return {path:input.directory+'/team.reflexion-team.json',roleCount:input.templateIds.length}}
export async function importAgentTeam(archive,projectId){const imported=archive.roles.map((role,i)=>({...role,id:'imported-'+i,projectId,enabled:false,builtin:false,modelBinding:{mode:'inherit'},policy:{permissionCeiling:role.permissionCeiling,allowedTools:role.allowedTools,canDelegate:role.canDelegate}}));templates=[...templates,...imported];window.importedTeam={archive,projectId};return {templates:imported,teamId:archive.teamId}}
export async function previewAgentRolePackage(data,projectId){window.packagePreview={data,projectId};return window.packageFixture}
export async function importAgentRolePackage(data,projectId,digest){window.packageImported={data,projectId,digest};return {template:{id:'zip-role'}}}
export async function exportAgentTemplate(id,directory){return {path:directory+'/shared.reflexion-role.json'}}
export async function listAgentTemplates(){return templates}
export async function saveAgentTemplate(input){ window.roleSaves.push(input); const template={...input,id:input.id??'new-role',source:input.projectId?'project':'user',builtin:false,policy:{permissionCeiling:input.permissionCeiling,allowedTools:input.allowedTools,canDelegate:input.canDelegate}}; templates=[template,...templates.filter(t=>t.id!==template.id)];return {template} }
export async function bulkUpdateAgentTemplates(input){
 if(window.failBulk) throw new Error('Synthetic bulk failure');
 window.roleBulkSaves.push(input);
 const ids=input.targets.map(t=>t.id),patch=input.patch;
 templates=templates.map(t=>!ids.includes(t.id)?t:{...t,...('projectId' in patch?{projectId:patch.projectId}:{}),...('enabled' in patch?{enabled:patch.enabled}:{}),updatedAt:new Date().toISOString(),policy:{...t.policy,...('permissionCeiling' in patch?{permissionCeiling:patch.permissionCeiling}:{}),...('allowedTools' in patch?{allowedTools:patch.allowedTools,canDelegate:patch.canDelegate}:{})}});
 return {templates:templates.filter(t=>ids.includes(t.id))}
}
export async function removeAgentTemplates(input){if(window.failBulkDelete)throw new Error('Synthetic bulk delete failure');window.roleBulkRemovals.push(input);const removedIds=input.targets.map(item=>item.id);templates=templates.filter(role=>!removedIds.includes(role.id));return {removedIds}}
export async function removeAgentTemplate(id){ templates=templates.filter(t=>t.id!==id);return {removed:true} }
export async function setAgentEnabled(id,enabled){templates=templates.map(t=>t.id===id?{...t,enabled}:t);return {agent:templates.find(t=>t.id===id)}}
export async function getDelegationTree(){return structuredClone(window.tree)}
export async function cancelDelegation(id){window.tree=window.tree.map(t=>t.id===id?{...t,status:'cancelled'}:t);return {accepted:true}}
`
export const providersApi = `export async function listProviderModels(){ return {models:[{model:'review-model',reasoningEffortSupported:true,reasoningOptions:[{value:'high',label:'高'}]}]} }`
export const projectsApi = `export async function listProjects(){return {projects:[{id:'project',name:'Project A'},{id:'other',name:'Project B'}]}}`
export const skillsApi = `window.savedSkills=[];window.skillQueries=[];
export async function listSkills(projectId){window.skillQueries.push(projectId);return {skills:[{id:projectId+'-skill',name:'Report helper',description:'Report guidance'},...window.savedSkills.filter(skill=>!skill.projectId||skill.projectId===projectId)]}};export async function saveSkill(input){ window.savedSkills.push(input);return {plugin:{id:input.id}} }`
export const transportApi = `const listeners=new Set(); window.emitAgentEvent=event=>listeners.forEach(fn=>fn(event));window.listenerCount=()=>listeners.size;
export const transport={onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},request:async()=>({})};export const newRequestId=()=>crypto.randomUUID()`
export const sessionsApi = `export async function getSessionData(){return {session:{id:'child-session',projectId:'project'},messages:[{id:'assistant',runId:'child-run',role:'assistant',content:'Synthetic review result',reasoning:'',parts:[],status:'completed',createdAt:'2026-10-14T00:00:00Z',completedAt:'2026-10-14T00:00:01Z'}],runs:[{id:'child-run',model:'review-model',status:'completed',usage:null}],toolCalls:[],plans:[],runEvents:[],nextBefore:null}}`

export const settingsApi = `import {AgentSettingsSchema} from '@reflexion-os-studio/contracts';
let settings=AgentSettingsSchema.parse(Object.fromEntries(['maxTurns','reflectionThreshold','requestRetries','requestTimeoutSec','maxRunTimeoutSec','maxRunTotalTokens','maxToolCalls','maxContinuationTurns','maxDepth','maxChildRuns','maxParallelChildren','maxChildTimeoutSec','maxChildTotalTokens'].map(key=>[key,null])));
window.runtimeSettingsSaves=[];
export async function getAgentSettings(){return {settings}}
export async function updateAgentSettings(input){settings=AgentSettingsSchema.parse(input);window.runtimeSettingsSaves.push(settings);return {settings}}
`
