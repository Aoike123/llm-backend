import {createElement as h} from 'react';

const shapes={
  key:[['circle',{cx:8,cy:8,r:4}],['path',{d:'m11 11 9 9m-4-4 3-3m-6 0 3-3'}]],
  trash:[['path',{d:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'}]],
  chevron:[['path',{d:'m8 10 4 4 4-4'}]],
  external:[['path',{d:'M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4'}]],
  follow:[['path',{d:'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7'}]],
  plus:[['path',{d:'M12 5v14M5 12h14'}]],
  minus:[['path',{d:'M5 12h14'}]],
  close:[['path',{d:'m6 6 12 12M18 6 6 18'}]],
  copy:[['rect',{x:8,y:8,width:11,height:11,rx:2}],['path',{d:'M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3'}]],
  check:[['path',{d:'m5 12 4 4L19 6'}]],
  filter:[['path',{d:'M4 6h16M7 12h10M10 18h4'}]],
  collapse:[['path',{d:'m7 10 5 5 5-5M5 20h14'}]],
  terminal:[['rect',{x:3,y:4,width:18,height:16,rx:3}],['path',{d:'m7 9 3 3-3 3M13 15h4'}]],
  activity:[['path',{d:'M3 12h4l3-7 4 14 3-7h4'}]],
  settings:[['path',{d:'M4 7h16M4 17h16'}],['circle',{cx:9,cy:7,r:3}],['circle',{cx:15,cy:17,r:3}]],
  tasks:[['rect',{x:5,y:4,width:14,height:17,rx:2}],['path',{d:'M9 4V2h6v2M9 10h6M9 15h6'}]],
  restart:[['path',{d:'M20 11a8 8 0 1 0-2.3 6M20 4v7h-7'}]],
};
export function Icon({name,className=''}){
  return h('svg',{className:'ui-icon '+className,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},(shapes[name]??shapes.chevron).map(([tag,props],key)=>h(tag,{...props,key})));
}
export function ActionButton({variant='secondary',icon,className='',children,...props}){
  return h('button',{type:'button',...props,className:`ui-action ui-action-${variant} ${className}`},icon&&h(Icon,{name:icon}),children);
}
