import {chromium} from 'file:///C:/Users/59244/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const folder=dirname(fileURLToPath(import.meta.url)),out=resolve(folder,'截图');await mkdir(out,{recursive:true});
const report={checks:[],errors:[],screenshots:[]},base='http://127.0.0.1:4174';
const browser=await chromium.launch({headless:true});
const ok=(name,value=true)=>{if(!value)throw Error(name);report.checks.push(name);};
let page;
async function decodedBackground(p){await p.evaluate(async()=>{const img=new Image();img.src='/assets/login-cockpit.png';await img.decode();await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});}
async function shot(name,fullPage=true){if(await page.locator('.auth-scene-page').count())await decodedBackground(page);await page.screenshot({path:resolve(out,name),fullPage});report.screenshots.push(name);}
try{
 const context=await browser.newContext({viewport:{width:1600,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.goto(base);await page.getByRole('heading',{name:'项目总览',exact:true}).waitFor();ok('全新无Cookie浏览器打开验收入口直接进入总览',await page.locator('.project-card').count()===6);ok('验收入口没有要求登录或注册',await page.locator('.auth-form').count()===0);
 const cookies=await context.cookies();ok('演示Cookie独立于正式工作区',cookies.some(c=>c.name==='cockpit_design_session'&&c.httpOnly)&&!cookies.some(c=>c.name==='cockpit_session'));
 ok('新品牌不含土星轨道图形',await page.locator('.brand ellipse').count()===0);await shot('02-桌面总览.png');
 await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByRole('heading',{name:'项目资料',exact:true}).waitFor();ok('资料中心直接可见样例文件',await page.getByText('接口说明.md',{exact:true}).count()>0);
 await page.getByRole('link',{name:'查看登录页',exact:true}).first().click();await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();ok('独立登录设计页可打开');
 const sizes=await page.evaluate(()=>{const box=document.querySelector('.auth-form-wrap').getBoundingClientRect();return {art:box.left,form:box.width,viewport:innerWidth};});report.desktopLayout=sizes;ok('桌面登录视觉与表单为7比3',Math.abs(sizes.art/sizes.viewport-.7)<.025&&Math.abs(sizes.form/sizes.viewport-.3)<.025);
 ok('桌面登录无页面横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));ok('提供通过邀请加入入口',await page.getByRole('button',{name:'通过邀请加入',exact:true}).isVisible());await shot('14-登录设计.png');
 await page.getByRole('button',{name:'通过邀请加入',exact:true}).click();ok('加入引导有具体可操作内容',await page.getByText(/邀请链接/).count()>0);
 const authState=await (await page.request.get(base+'/api/state')).json();const inviteResponse=await page.request.post(base+'/api/invitations',{headers:{Origin:base,'X-CSRF-Token':authState.csrfToken},data:{email:'review-invite-'+Date.now()+'@example.test',name:'设计流程验收'}});if(!inviteResponse.ok())throw Error('创建隔离邀请夹具失败');const invite=await inviteResponse.json();
 await page.getByRole('dialog').getByLabel('邀请链接',{exact:true}).fill(base+'/#/join?token='+encodeURIComponent(invite.token));await page.getByRole('button',{name:'打开邀请',exact:true}).click();await page.getByRole('heading',{name:'加入团队',exact:true}).waitFor();ok('粘贴真实邀请链接能进入接受邀请页面',await page.getByLabel('姓名',{exact:true}).isVisible()&&await page.getByLabel('邮箱',{exact:true}).inputValue()===invite.email);
 await page.getByRole('link',{name:'返回演示',exact:true}).click();await page.getByRole('heading',{name:'项目总览',exact:true}).waitFor();ok('查看登录设计后可以无密码返回演示');
 await page.goto(base+'/auth-preview');await page.getByLabel('邮箱',{exact:true}).fill('design-review@example.test');await page.getByLabel('密码',{exact:true}).fill('Review-Only-2026!');await page.getByRole('button',{name:'登录驾驶舱',exact:true}).click();await page.getByRole('heading',{name:'项目总览',exact:true}).waitFor();ok('新登录表单提交真实账号后正常进入总览');
 await page.setViewportSize({width:390,height:844});await shot('07-手机总览.png',false);await page.goto(base+'/auth-preview');await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();ok('390px登录无页面横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));ok('手机登录表单与返回演示可见',await page.getByLabel('邮箱',{exact:true}).isVisible()&&await page.getByRole('link',{name:'返回演示',exact:true}).isVisible());await shot('15-手机登录.png');
 await page.setViewportSize({width:1280,height:800});await page.goto(base+'/auth-preview');await page.getByRole('heading',{name:'欢迎回来',exact:true}).waitFor();ok('1280px登录无页面横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const clean=await browser.newContext({viewport:{width:1600,height:1000},locale:'zh-CN'}),formal=await clean.newPage();await formal.goto('http://127.0.0.1:4173');await formal.getByRole('heading',{name:'建立你的驾驶舱',exact:true}).waitFor();const b=await formal.request.get('http://127.0.0.1:4173/api/bootstrap'),data=await b.json();ok('正式入口仍是空库且不开放演示自动会话',!data.initialized&&!data.designPreview);await decodedBackground(formal);await formal.screenshot({path:resolve(out,'16-首次建立设计.png'),fullPage:true});report.screenshots.push('16-首次建立设计.png');await clean.close();
 ok('浏览器无未捕获错误',report.errors.length===0);await context.close();
}catch(e){report.failure=String(e.stack||e);if(page){report.body=(await page.locator('body').innerText()).slice(-5000);await shot('设计修订失败.png');}process.exitCode=1;}
finally{await browser.close();await writeFile(resolve(folder,'设计修订检查.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
