import {chromium} from 'file:///C:/Users/59244/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Browser plugin not available. Reuse the project's existing Playwright runtime.
// Read-only QA: no write API request is permitted by this script.
const folder=dirname(fileURLToPath(import.meta.url)),screens=resolve(folder,'截图'),base='http://127.0.0.1:4174';
await mkdir(screens,{recursive:true});
const report={date:new Date().toISOString(),url:base,browser:'Playwright Chromium; Browser plugin not available',flow:'Fresh anonymous design-preview entry → overview and read-only pages → local filter changes → login design',readOnly:true,checks:[],layouts:[],screenshots:[],pageErrors:[],consoleErrors:[],failedRequests:[],blockedWrites:[],limits:['No business writes, invitations, comments, or setup submissions.','No real screen-reader speech in this pass; full mutation and role regressions are covered by the separate isolated QA.']};
let browser,context,page;
function ok(name,value,details){report.checks.push({name,passed:Boolean(value),...(details===undefined?{}:{details})});if(!value)throw Error(name);}
async function settled(){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});}
async function openRoute(route,heading){await page.goto(base+'/#/'+route);await page.getByRole('heading',{name:heading,exact:true}).waitFor();await settled();ok(`${route}: page identity and meaningful content`,(await page.title()).includes('项目驾驶舱')&&(await page.locator('main').innerText()).length>30);ok(`${route}: no framework error overlay`,await page.locator('vite-error-overlay,nextjs-portal,[data-nextjs-dialog]').count()===0);}
async function geometry(name,width){
 const data=await page.evaluate(()=>{
  const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};};
  const sidebar=document.querySelector('.sidebar'),shown=sidebar&&getComputedStyle(sidebar).display!=='none',brand=shown?sidebar.querySelector('.brand strong'):document.querySelector('.mobile-top .brand strong'),icon=shown?sidebar.querySelector('a[href="#/settings"] svg'):document.querySelector('.mobile-top a[aria-label="设置"] svg'),sideStyle=shown?getComputedStyle(sidebar):null;
  return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,sidebar:shown?rect(sidebar):null,paddingLeft:shown?parseFloat(sideStyle.paddingLeft):null,paddingRight:shown?parseFloat(sideStyle.paddingRight):null,brand:brand?rect(brand):null,settingsIcon:icon?rect(icon):null};
 });
 report.layouts.push({page:name,width,...data});
 ok(`${width}px ${name}: no full-page horizontal overflow`,data.scrollWidth<=width+1&&data.bodyWidth<=width+1,data);
 if(data.sidebar&&data.brand)ok(`${width}px ${name}: complete brand remains inside sidebar padding`,data.brand.left>=data.sidebar.left+data.paddingLeft-1&&data.brand.right<=data.sidebar.right-data.paddingRight+1,{brand:data.brand,sidebar:data.sidebar});
 else if(data.brand)ok(`${width}px ${name}: mobile brand remains within viewport`,data.brand.left>=0&&data.brand.right<=width,data.brand);
 if(data.settingsIcon)ok(`${width}px ${name}: settings SVG is square`,data.settingsIcon.width>0&&Math.abs(data.settingsIcon.width-data.settingsIcon.height)<.1,data.settingsIcon);
}
async function screenshot(filename,fullPage=false){await settled();await page.screenshot({path:resolve(screens,filename),fullPage});report.screenshots.push(filename);}
async function decodedBackground(){return page.evaluate(async()=>{const picture=new Image();picture.src='/assets/login-cockpit.png';await picture.decode();if(!picture.naturalWidth||!picture.naturalHeight)throw Error('Login background did not decode');await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {width:picture.naturalWidth,height:picture.naturalHeight,decoded:true};});}
try{
 browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1600,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
 await context.route('**/api/**',async route=>{const request=route.request();if(!['GET','HEAD','OPTIONS'].includes(request.method())){report.blockedWrites.push({method:request.method(),url:request.url()});await route.abort('blockedbyclient');return;}await route.continue();});
 page=await context.newPage();page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(15000);page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});page.on('requestfailed',r=>report.failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
 await page.goto(base);await page.getByRole('heading',{name:'项目总览',exact:true}).waitFor();await settled();ok('Fresh anonymous 4174 entry opens overview without login',await page.locator('.auth-form').count()===0&&await page.locator('.project-card').count()>0);
 const cookies=await context.cookies();ok('Design preview uses its own HttpOnly cookie',cookies.some(c=>c.name==='cockpit_design_session'&&c.httpOnly)&&!cookies.some(c=>c.name==='cockpit_session'));
 const bootstrap=await (await page.request.get(base+'/api/bootstrap')).json();ok('Server explicitly marks the design preview',bootstrap.designPreview===true&&bootstrap.loginPreviewUrl==='/auth-preview');
 report.projectCount=await page.locator('.project-card').count();
 for(const width of [1600,1440,1024,768,390]){
  await page.setViewportSize({width,height:width===390?844:1000});
  for(const [route,heading] of [['overview','项目总览'],['projects','项目中心'],['tasks','团队任务'],['resources','项目资料'],['settings','成员与权限']]){
   await openRoute(route,heading);await geometry(heading,width);
   if(route==='overview'&&width===1600)await screenshot('22-最终桌面总览.png');
   if(route==='overview'&&width===390)await screenshot('23-最终手机总览.png',true);
  }
 }
 await page.setViewportSize({width:1440,height:1000});await openRoute('projects','项目中心');
 const state=await (await page.request.get(base+'/api/state')).json();
 const lifecycle=page.getByRole('button',{name:'生命周期筛选',exact:true});
 for(const phase of ['planned','active']){
  await lifecycle.click();await page.getByLabel(phase==='planned'?'待启动':'进行中',{exact:true}).check();await page.getByRole('button',{name:'完成选择',exact:true}).click();
  const expected=state.projects.filter(p=>p.lifecycle!=='archived'&&p.lifecycle===phase).length,actual=await page.locator('.project-card').count();ok(`Lifecycle ${phase} local filter displays authorized matching projects`,actual===Math.min(expected,12),{expected,actual});
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
 }
 ok('Lifecycle reset restores default current projects',await page.locator('.project-card').count()===Math.min(state.projects.filter(p=>p.lifecycle!=='archived').length,12));
 await openRoute('resources','项目资料');
 await page.getByLabel('搜索资料名称',{exact:true}).fill('只读复核不会存在的资料名_20261023');await page.getByRole('heading',{name:'还没有匹配的资料',exact:true}).waitFor();ok('Resources search displays a useful empty state',await page.getByText('上传文件或添加链接，资料权限会跟随所属项目。',{exact:true}).isVisible());await page.getByLabel('搜索资料名称',{exact:true}).fill('');
 await page.setViewportSize({width:1600,height:1000});await page.goto(base+'/auth-preview');await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();report.background=await decodedBackground();
 const login=await page.evaluate(()=>{const r=document.querySelector('.auth-form-wrap').getBoundingClientRect();return {visual:r.left,form:r.width,width:innerWidth,background:getComputedStyle(document.querySelector('.auth-scene-page')).backgroundImage};});report.login=login;
 ok('Login design retains 70 percent visual and 30 percent form',Math.abs(login.visual/login.width-.7)<.025&&Math.abs(login.form/login.width-.3)<.025,login);ok('Login production image is applied continuously',login.background.includes('/assets/login-cockpit.png'));ok('Login offers invite help without public registration',await page.getByRole('button',{name:'通过邀请加入',exact:true}).isVisible()&&await page.getByRole('button',{name:/注册/}).count()===0);await screenshot('24-最终登录设计.png');
 for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:width===390?844:1000});await decodedBackground();ok(`${width}px login: no full-page horizontal overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));ok(`${width}px login: account fields remain readable`,await page.getByLabel('邮箱',{exact:true}).isVisible()&&await page.getByLabel('密码',{exact:true}).isVisible());}
 await page.getByRole('link',{name:'返回演示',exact:true}).click();await page.getByRole('heading',{name:'项目总览',exact:true}).waitFor();ok('Return from login design directly opens preview',await page.locator('.auth-form').count()===0);
 const anonymous=await browser.newContext();try{const response=await anonymous.request.get('http://127.0.0.1:4173/api/bootstrap');const formal=await response.json();report.formalBootstrap={status:response.status(),initialized:formal.initialized,designPreview:Boolean(formal.designPreview)};ok('Anonymous formal 4173 remains uninitialized and not design preview',response.ok()&&formal.initialized===false&&!formal.designPreview);}finally{await anonymous.close();}
 ok('No business write requests attempted',report.blockedWrites.length===0);ok('No uncaught page errors',report.pageErrors.length===0);ok('No browser console errors',report.consoleErrors.length===0);
}catch(e){report.failure=String(e.stack||e);process.exitCode=1;if(page&&!page.isClosed()){report.failureText=(await page.locator('body').innerText()).slice(-4000);await page.screenshot({path:resolve(screens,'最终设计复核失败.png'),fullPage:true}).catch(()=>{});}}
finally{if(context)await context.close();if(browser)await browser.close();await writeFile(resolve(folder,'本机设计复核.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({checks:report.checks.length,passed:report.checks.filter(c=>c.passed).length,layouts:report.layouts.length,screenshots:report.screenshots,background:report.background,pageErrors:report.pageErrors,consoleErrors:report.consoleErrors,blockedWrites:report.blockedWrites,formalBootstrap:report.formalBootstrap,failure:report.failure},null,2));
