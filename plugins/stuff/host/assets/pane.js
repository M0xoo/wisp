(()=>{if(window.wisp&&window.wisp.tasks)return;const inPane=parent!==window;let n=0;const wait=new Map();const subs={};let ctx={where:inPane?'':'tab'};
const call=(method,...args)=>new Promise((ok,no)=>{if(!inPane)return no(new Error('Pin this app as a pane in wisp to use wisp.'+method+'().'));const id=++n;wait.set(id,{ok,no});parent.postMessage({wispPane:1,id,method,args},'*')});
addEventListener('message',(e)=>{if(e.source!==parent&&e.source!==parent.parent)return;const m=e.data||{};if(!m.wispPane)return;if(m.id&&wait.has(m.id)){const w=wait.get(m.id);wait.delete(m.id);m.error?w.no(new Error(m.error)):w.ok(m.result);return}
if(m.event==='context'){ctx=Object.freeze({...m.data});if(ctx.theme)document.documentElement.dataset.theme=ctx.theme}(subs[m.event]||[]).forEach((f)=>{try{f(m.data)}catch(err){console.error(err)}})});
const on=(ev,fn)=>{(subs[ev]=subs[ev]||[]).push(fn);if(ev==='tasks')call('tasks.watch').catch((err)=>console.warn(err.message));return()=>{subs[ev]=(subs[ev]||[]).filter((f)=>f!==fn)}};
window.wisp=Object.freeze({get context(){return ctx},on,
tasks:Object.freeze({list:()=>call('tasks.list'),get:(id)=>call('tasks.get',id),launch:(o)=>call('tasks.launch',o),followUp:(id,text)=>call('tasks.followUp',id,text),done:(id)=>call('tasks.done',id)}),
prs:Object.freeze({list:()=>call('prs.list')}),crew:Object.freeze({list:()=>call('crew.list')}),usage:Object.freeze({accounts:()=>call('usage.accounts')})});
if(inPane)parent.postMessage({wispPane:1,hello:1},'*');})();