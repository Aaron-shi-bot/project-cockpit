import {chromium} from 'file:///C:/Users/59244/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url)),base='http://127.0.0.1:4174',report={checks:[],errors:[]};
const browser=await chromium.launch({headless:true});
function ok(name,value=true){if(!value)throw Error(name);report.checks.push(name);}
async function login(p,email,password){p.on('dialog',d=>d.accept());p.on('pageerror',e=>report.errors.push(e.message));await p.goto(base);await p.getByLabel('邮箱',{exact:true}).fill(email);await p.locator('input[type=password]').fill(password);await p.locator('form button[type=submit]').click();await p.getByRole('heading',{name:'项目总览',exact:true}).waitFor();}
async function state(c){const r=await c.request.get(base+'/api/state');if(!r.ok())throw Error('读取测试夹具失败 '+r.status());return r.json();}
async function write(c,token,path,body){const r=await c.request.post(base+'/api'+path,{headers:{'X-CSRF-Token':token,Origin:base},data:body});if(!r.ok())throw Error('测试夹具写入失败 '+await r.text());return r.json();}
try{
 const c=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),p=await c.newPage();await login(p,'qa-owner@example.test','QA-browser-fixture-Only-92!');let s=await state(c);const project=s.projects.find(x=>x.name==='浏览器验收项目'),member=s.members.find(x=>x.email.startsWith('qa-viewer-')&&x.status==='active');if(!project||!member)throw Error('需先运行browser-flows，保留一位有效受邀成员');
 const renamed=await c.request.patch(base+'/api/members/'+member.id,{headers:{'X-CSRF-Token':s.csrfToken,Origin:base},data:{version:member.version,name:'多源授权验收人'}});if(!renamed.ok())throw Error(await renamed.text());
 for(const g of s.grants.filter(g=>g.projectId===project.id&&g.subjectType==='team'&&s.teams.some(t=>t.id===g.subjectId&&t.name.startsWith('撤权验收团队')))){const r=await c.request.delete(base+'/api/grants/'+g.id,{headers:{'X-CSRF-Token':s.csrfToken,Origin:base}});if(!r.ok())throw Error(await r.text());}
 const team=await write(c,s.csrfToken,'/teams',{name:'撤权验收团队 '+Date.now(),memberIds:[member.id]});await write(c,s.csrfToken,'/grants',{projectId:project.id,subjectType:'team',subjectId:team.id,role:'collaborator'});
 const resource=s.resources.find(r=>r.projectId===project.id&&r.kind==='file'),version=s.versions.find(v=>v.resourceId===resource.id),url=base+'/api/files/'+version.id;
 const c2=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN'}),v=await c2.newPage();await login(v,member.email,'QA-viewer-fixture-Only-92!');ok('直接只读加团队协作取最高权限',(await state(c2)).projects.find(x=>x.id===project.id).role==='collaborator');ok('撤权前缓存历史文件URL可下载',(await c2.request.get(url)).status()===200);
 await p.goto(base+'/#/settings');await p.reload();await p.getByRole('button',{name:'项目授权',exact:true}).click();await p.getByLabel('筛选授权项目',{exact:true}).selectOption(project.id);const direct=p.getByRole('row').filter({hasText:'多源授权验收人'});await direct.getByRole('button',{name:'撤销',exact:true}).click();await direct.waitFor({state:'hidden'});await v.reload();ok('手机撤直接来源后仍有团队协作权限',(await state(c2)).projects.find(x=>x.id===project.id).role==='collaborator');ok('尚有团队来源时历史文件仍可下载',(await c2.request.get(url)).status()===200);
 const teamRow=p.getByRole('row').filter({hasText:team.name});await teamRow.getByRole('button',{name:'撤销',exact:true}).click();await teamRow.waitFor({state:'hidden'});await v.reload();await v.getByRole('heading',{name:'项目总览',exact:true}).waitFor();ok('手机撤最后来源后旧页面不再显示项目',await v.locator('.project-card').count()===0);ok('旧历史下载URL撤权后拒绝',(await c2.request.get(url)).status()===404);ok('390px授权页无页面横向溢出',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.locator('.toast').waitFor({state:'hidden',timeout:7000});await p.screenshot({path:resolve(dir,'截图/13-手机项目撤权.png'),fullPage:true});await c2.close();await c.close();ok('无未捕获浏览器错误',report.errors.length===0);
}catch(e){report.failure=String(e.stack||e);process.exitCode=1;}
finally{await browser.close();await writeFile(resolve(dir,'浏览器权限检查.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
