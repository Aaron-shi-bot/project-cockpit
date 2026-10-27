import React,{createContext,useCallback,useContext,useEffect,useState} from 'react';
import {api,setCsrf} from './api';
import {Brand,Icon,Button,ErrorNotice,Field,Modal,EventTimeZone,fmtTime} from './ui';
import {Overview,Projects,ProjectDetail,Tasks,Resources} from './pages';
import {Settings} from './settings';
import {EntityForm} from './forms';
export const Workspace=createContext(null);
export const useWorkspace=()=>useContext(Workspace);
const emptyState={projects:[],tasks:[],milestones:[],risks:[],updates:[],resources:[],versions:[],members:[],teams:[],grants:[],audit:[]};
function route(){const raw=location.hash.slice(1)||'/overview';const [path,search]=raw.split('?');return {path,params:new URLSearchParams(search||'')};}
function stillHasWriteAccess(snapshot,path,body,previous){
 if(!snapshot?.user)return false;
 const manager=['owner','admin'].includes(snapshot.user.workspaceRole);
 if(/^\/(members|teams|invitations)(\/|$)/.test(path)){
  if(!manager)return false;
  const member=path.startsWith('/members/')&&snapshot.members.find(item=>item.id===path.split('/')[2]);
  return !member||snapshot.user.workspaceRole==='owner'||member.workspaceRole==='member'&&!body?.password&&(!body?.workspaceRole||body.workspaceRole==='member');
 }
 let projectId=body?.projectId;
 const match=path.match(/^\/(projects|tasks|milestones|risks|resources)\/([^/]+)/);
 if(match){const [,collection,id]=match;projectId=collection==='projects'?id:(snapshot[collection]?.find(item=>item.id===id)||previous?.[collection]?.find(item=>item.id===id))?.projectId;}
 if(!projectId)return true;
 const project=snapshot.projects.find(item=>item.id===projectId);
 if(!project||project.role==='viewer')return false;
 if(project.role==='maintainer')return true;
 if(/^\/projects\//.test(path)||path==='/grants'||path.startsWith('/milestones'))return false;
 if(match?.[1]==='tasks'){
  const task=snapshot.tasks.find(item=>item.id===match[2]);
  return Boolean(task&&(task.assigneeId===snapshot.user.id||!task.assigneeId&&task.createdBy===snapshot.user.id));
 }
 if(match?.[1]==='resources'){
  const resource=snapshot.resources.find(item=>item.id===match[2]);
  return Boolean(resource&&resource.createdBy===snapshot.user.id&&!body?.restoreVersionId&&!body?.deleted);
 }
 return true;
}
export default function App(){
 const [locationState,setLocationState]=useState(route),[boot,setBoot]=useState(null),[state,setState]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[authNotice,setAuthNotice]=useState(''),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[refreshed,setRefreshed]=useState(null);
 const navigate=useCallback(path=>{location.hash=path;window.scrollTo({top:0});},[]);
 const refresh=useCallback(async()=>{try{const data=await api('/state');setCsrf(data.csrfToken);setState({...emptyState,...data});setRefreshed(new Date());setError('');return data;}catch(e){if([401,403,404].includes(e.status)){setState(null);setCsrf('');}throw e;}},[]);
 useEffect(()=>{const handler=()=>{setLocationState(route());setForm(null);};window.addEventListener('hashchange',handler);return()=>window.removeEventListener('hashchange',handler);},[]);
 useEffect(()=>{const controller=new AbortController();(async()=>{try{const bootstrap=await api('/bootstrap',{signal:controller.signal});setBoot(bootstrap);if(bootstrap.initialized)await refresh();}catch(e){if(e.status!==401&&e.name!=='AbortError')setError(e.message);}finally{if(!controller.signal.aborted)setLoading(false);}})();return()=>controller.abort();},[refresh]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),5500);return()=>clearTimeout(timer);},[notice]);
 useEffect(()=>{if(!state)return;const handle=()=>refresh().catch(e=>setError(e.message));window.addEventListener('focus',handle);return()=>window.removeEventListener('focus',handle);},[state?.user?.id,refresh]);
 const mutate=async(path,body,method='POST')=>{let result;try{result=await api(path,{method,body});}catch(e){if(e.code==='REAUTH_REQUIRED')throw e;if([401,403,404,409].includes(e.status)){const latest=await refresh().catch(()=>null);if(e.status===401||[403,404].includes(e.status)&&!stillHasWriteAccess(latest,path,body,state))setForm(null);}throw e;}try{await refresh();setNotice('已保存');}catch(e){if(e.status===401&&body?.password&&(path==='/me'||path==='/members/'+state?.user.id)){setForm(null);setNotice('');setError('');setAuthNotice('密码已更新，请使用新密码重新登录。');navigate('/login');}else{setNotice('保存成功');setError('内容已保存，暂时无法刷新，请重试刷新数据。');}}return result;};
 const act=async(fn,success)=>{setBusy(true);try{const result=await fn();if(success)setNotice(success);return result;}catch(e){setError(e.message);}finally{setBusy(false);}};
 const logout=()=>act(async()=>{await api('/logout',{method:'POST'});setState(null);setCsrf('');navigate('/login');});
 const loadDemo=()=>{if(window.confirm('导入 6 个虚构项目、93 条任务的演示数据？示例将明确标记，可以删除；不会导入真实业务。'))act(()=>mutate('/demo',{}),'演示数据已导入');};
 const forceAuthPreview=['/auth-preview','/login-preview'].includes(location.pathname);
 const value={...emptyState,...state,refresh,mutate,navigate,openForm:setForm,setNotice,act,busy,loadDemo,limits:boot?.limits};
 if(loading)return <div className="loading-screen"><Brand/><div className="spinner"/><p>正在打开你的项目驾驶舱…</p></div>;
 if(!state||forceAuthPreview)return <Auth boot={boot} designPreview={Boolean(boot?.designPreview)} error={error} notice={authNotice} onReady={async()=>{setBoot({...boot,initialized:true});await refresh();setAuthNotice('');if(forceAuthPreview)location.assign('/');else navigate('/overview');}} locationState={locationState}/>;
 const nav=[['home','总览','/overview'],['folder','项目','/projects'],['task','任务','/tasks'],['file','资料','/resources']];
 const path=locationState.path,projectId=path.startsWith('/projects/')?path.split('/')[2]:null;
 return <EventTimeZone.Provider value={state.user.timeZone||'Asia/Shanghai'}><Workspace.Provider value={value}><div className="app-shell"><aside className="sidebar"><Brand/><nav aria-label="主导航">{nav.map(([icon,label,url])=><a key={url} href={'#'+url} className={(path===url||(url==='/projects'&&projectId))?'selected':''}><Icon name={icon} size={25}/><span>{label}</span></a>)}</nav><div className="sidebar-bottom"><a href="#/settings" className={path==='/settings'?'selected':''}><Icon name="settings" size={25}/><span>设置</span></a>{boot?.designPreview?<a className="user-switch preview-switch" href={boot.loginPreviewUrl||'/auth-preview'}><Icon name="lock" size={17}/><span>查看登录页</span></a>:<button className="user-switch" onClick={logout} title="退出登录"><span className="mini-avatar">{state.user.name?.slice(0,1)}</span><span>退出</span><Icon name="logout" size={16}/></button>}</div></aside><main className="main-content"><div className="mobile-top"><Brand/>{boot?.designPreview&&<a className="preview-mobile-link" href={boot.loginPreviewUrl||'/auth-preview'}>查看登录页</a>}<a className="icon-button" href="#/settings" aria-label="设置"><Icon name="settings"/></a></div>{error&&<div className="global-error"><ErrorNotice error={error}/><Button variant="subtle" icon="refresh" onClick={()=>act(refresh,'已刷新')}>刷新数据</Button><button className="icon-button" aria-label="关闭提示" onClick={()=>setError('')}><Icon name="close"/></button></div>}{path==='/overview'?<Overview/>:path==='/projects'?<Projects/>:projectId?<ProjectDetail id={projectId}/>:path==='/tasks'?<Tasks initialProject={locationState.params.get('project')||''} initialAssignee={locationState.params.get('assignee')||''} initialView={locationState.params.get('view')||'all'}/>:path==='/resources'?<Resources initialProject={locationState.params.get('project')||''}/>:path==='/settings'?<Settings/>:<Overview/>}<footer className="app-footer"><span>项目驾驶舱 · {state.user.name}{boot?.designPreview&&<> · 设计演示 <a className="preview-entry" href={boot.loginPreviewUrl||'/auth-preview'}>查看登录页 <Icon name="arrow" size={12}/></a></>}</span><span>数据更新于 {fmtTime(refreshed,state.user.timeZone||'Asia/Shanghai')}</span></footer></main><nav className="mobile-nav" aria-label="移动导航">{nav.map(([icon,label,url])=><a key={url} href={'#'+url} className={(path===url||(url==='/projects'&&projectId))?'selected':''}><Icon name={icon}/><span>{label}</span></a>)}</nav>{notice&&<div className="toast" role="status"><Icon name="check"/>{notice}</div>}{form&&<EntityForm key={form.kind+(form.item?.id||'new')+(form.item?.version||'')} {...form} onClose={()=>setForm(null)}/>}</div></Workspace.Provider></EventTimeZone.Provider>;
}
function Auth({boot,error:outerError,notice,onReady,locationState,designPreview=false}){
 const token=locationState.params.get('token');const isJoin=locationState.path==='/join'&&token;const setup=boot&&!boot.initialized&&!isJoin;
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[invitation,setInvitation]=useState(null),[joinHelp,setJoinHelp]=useState(false),[invitationLink,setInvitationLink]=useState(''),[joinError,setJoinError]=useState('');
 useEffect(()=>{const controller=new AbortController();setError('');setInvitation(null);if(isJoin)api('/invitations?token='+encodeURIComponent(token),{signal:controller.signal}).then(data=>{if(controller.signal.aborted)return;setInvitation(data);setName(data.name||'');setEmail(data.email||'');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[isJoin,token]);
 const submit=async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{await api(setup?'/setup':isJoin?'/join':'/login',{method:'POST',body:setup?{name,email,password}:isJoin?{token,name,password}:{email,password}});await onReady();}catch(e){setError(e.message);}finally{setBusy(false);}};
 const openInvitation=e=>{e.preventDefault();try{const value=invitationLink.trim(),url=new URL(value,location.href),params=new URLSearchParams(url.hash.includes('?')?url.hash.split('?')[1]:url.search);const invitationToken=params.get('token')||(/^[a-zA-Z0-9_-]{20,256}$/.test(value)?value:'');if(!invitationToken)throw new Error('没有找到邀请信息，请复制管理员给你的完整邀请链接。');location.hash='/join?token='+encodeURIComponent(invitationToken);setJoinHelp(false);setJoinError('');setError('');}catch(e){setJoinError(e.message||'请填写有效的邀请链接。');}};
 return <><div className="auth-page auth-scene-page">
  <header className="auth-header"><Brand/></header>
  {designPreview&&<a href="/" className="auth-return-demo button outline"><Icon name="arrow" size={17}/>返回演示</a>}
  <div className="auth-scene-copy"><h1>让每个项目<br/>都有清晰的方向</h1></div>
  <main className="auth-form-wrap"><form className="auth-form" onSubmit={submit}>
   <h2>{setup?'建立你的驾驶舱':isJoin?'加入团队':'欢迎回来'}</h2>
   <p className="auth-description">{setup?'创建平台所有者账号，随后邀请你的团队。':isJoin?invitation?`你受邀以${invitation.workspaceRole==='admin'?'管理员':'成员'}身份加入团队。`:'正在验证邀请…':'登录账号，与团队一起继续推进项目。'}</p>
   <ErrorNotice error={error||outerError}/>
   {notice&&<div className="callout" role="status">{notice}</div>}
   {isJoin&&invitation&&<div className="callout invitation-scope"><strong>本次邀请范围</strong><p>工作区身份：{invitation.workspaceRole==='admin'?'管理员':'成员'}</p>{invitation.projectName?<p>项目「{invitation.projectName}」 · {{maintainer:'项目维护者',collaborator:'协作成员',viewer:'只读成员'}[invitation.projectRole]||'指定角色'}</p>:<p>仅加入工作区；项目内容需另行授权。</p>}<small>接受后按此范围加入；邮箱与收件身份由邀请链接指定。</small></div>}
   {(setup||isJoin)&&<Field label="姓名"><input required value={name} onChange={e=>setName(e.target.value)} maxLength={60} autoComplete="name" placeholder="你的姓名"/></Field>}
   <Field label="邮箱"><input required type="email" value={email} onChange={e=>setEmail(e.target.value)} readOnly={Boolean(isJoin)} autoComplete="username" placeholder="name@example.com"/></Field>
   <Field label={setup||isJoin?'设置密码':'密码'} hint={setup||isJoin?'至少 10 位，请使用独立且不易猜测的密码。':undefined}><input type="password" required minLength={setup||isJoin?10:1} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={setup||isJoin?'new-password':'current-password'} placeholder={setup||isJoin?'至少 10 位':'输入密码'}/></Field>
   <Button type="submit" disabled={busy||isJoin&&!invitation}>{busy?'正在处理…':setup?'创建平台':isJoin?'接受邀请并加入':'登录驾驶舱'}<Icon name="arrow" size={18}/></Button>
   {!setup&&!isJoin&&<div className="auth-join-line"><span>还没有账号？</span><button type="button" className="text-button" onClick={()=>{setJoinHelp(true);setJoinError('');}}>通过邀请加入 <Icon name="chevron" size={16}/></button></div>}
   {setup&&<p className="auth-footnote">首次建立后，使用这个账号管理成员与项目。</p>}
   {isJoin&&<><p className="auth-footnote">邀请仅授权指定的工作区与项目范围。</p><a className="text-button auth-back" href="#/login">已有账号，返回登录 <Icon name="arrow" size={17}/></a></>}
  </form></main>
  <footer className="auth-scene-footer">项目驾驶舱 · 与团队一起，稳步抵达目标</footer>
 </div>{joinHelp&&<Modal title="通过邀请加入" onClose={()=>setJoinHelp(false)}><form onSubmit={openInvitation} className="invite-help-form"><p>请向平台管理员获取专属邀请链接。打开链接后，填写姓名并设置密码，就可以加入获邀的团队和项目。</p><Field label="邀请链接"><textarea value={invitationLink} onChange={e=>setInvitationLink(e.target.value)} placeholder="粘贴管理员发给你的完整邀请链接" required rows={3}/></Field><ErrorNotice error={joinError}/><Button type="submit" icon="arrow">打开邀请</Button><small>还没有链接？请联系你所在团队的平台管理员。</small></form></Modal>}</>;
}
