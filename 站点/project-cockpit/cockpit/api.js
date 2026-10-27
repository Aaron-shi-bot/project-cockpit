let csrf='';
const operations=new Map();
export function setCsrf(value){const next=value||'';if(next!==csrf)operations.clear();csrf=next;}
export async function api(path, options={}) {
  const {method='GET', body, signal, bootstrapToken}=options;
  const serialized=body===undefined?undefined:JSON.stringify(body),operationKey=method+' '+path+' '+(serialized||''),writing=method!=='GET';
  if(writing&&!operations.has(operationKey))operations.set(operationKey,crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''));
  const response=await fetch('/api'+path,{method,signal,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(writing?{'X-CSRF-Token':csrf,'X-Operation-Id':operations.get(operationKey)}:{}),...(method==='POST'&&path==='/setup'&&bootstrapToken?{'X-Bootstrap-Token':bootstrapToken}:{})},body:serialized});
  const data=await response.json().catch(()=>({error:'服务暂时无法响应，请重试。'}));
  if(response.ok||response.status>=400&&response.status<500)operations.delete(operationKey);
  if(!response.ok){const error=new Error(data.error||'操作失败，请重试。');error.status=response.status;error.code=data.code;error.details=data.details;throw error;}
  if(data.csrfToken)setCsrf(data.csrfToken);
  return data;
}
export function fileToPayload(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,mime:file.type||'application/octet-stream',base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file);});}
