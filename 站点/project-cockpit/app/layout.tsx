import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import '../cockpit/styles.css';

export const metadata:Metadata={
  title:'项目驾驶舱',
  description:'用清晰的项目总览、团队任务、里程碑和资料管理，与团队一起稳步推进项目。',
  icons:{icon:'/assets/brand.svg'},
  robots:{index:false,follow:false},
};

export default function RootLayout({children}:{children:ReactNode}){
  return <html lang="zh-CN"><body>{children}</body></html>;
}
