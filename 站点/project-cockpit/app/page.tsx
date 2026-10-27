'use client';

import {useEffect,useState} from 'react';
import App from '../cockpit/App';
import {Brand} from '../cockpit/ui';

export default function CockpitPage(){
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);
  if(!mounted)return <div className="loading-screen" role="status"><Brand/><div className="spinner"/><p>正在打开你的项目驾驶舱…</p></div>;
  return <App/>;
}
