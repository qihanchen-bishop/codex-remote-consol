import { Marked } from './vendor/marked.mjs';
import DOMPurify from './vendor/purify.mjs';

const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parser = new Marked({gfm:true,breaks:true,renderer:{
  html({text}) { return escape(text); },
  // External images are links; uploaded images have a separate authenticated
  // preview route. Markdown cannot trigger remote tracking/image downloads.
  image({href,text}) { return `<a href="${escape(href)}">${escape(text || '查看图片')}</a>`; },
}});

export function renderMarkdown(text, onCopy = () => {}) {
  const node=document.createElement('div');node.className='rich-text';
  const fragment=DOMPurify.sanitize(parser.parse(String(text || '')),{
    RETURN_DOM_FRAGMENT:true,
    ALLOWED_TAGS:['p','br','h1','h2','h3','h4','h5','h6','strong','em','del','s','blockquote','ul','ol','li','hr','pre','code','a','table','thead','tbody','tr','th','td','input'],
    ALLOWED_ATTR:['href','title','class','start','align','type','checked','disabled'],
    ALLOW_DATA_ATTR:false,
  });
  node.append(fragment);
  for(const link of node.querySelectorAll('a')) {
    const href=link.getAttribute('href') || '';
    if(/^(https?:|mailto:)/i.test(href)) { link.target='_blank';link.rel='noopener noreferrer'; }
    else { if(href)link.title=href;link.removeAttribute('href'); }
  }
  for(const input of node.querySelectorAll('input')){input.type='checkbox';input.disabled=true;input.tabIndex=-1;}
  for(const table of node.querySelectorAll('table')){const wrap=document.createElement('div');wrap.className='table-scroll';table.replaceWith(wrap);wrap.append(table);}
  for(const pre of node.querySelectorAll('pre')) {
    const code=pre.querySelector('code');
    const wrapper=document.createElement('div');wrapper.className='code-block';
    const label=document.createElement('div');label.className='code-label';
    const language=[...(code?.classList || [])].find(c=>c.startsWith('language-'))?.slice(9) || 'CODE';
    const title=document.createElement('span');title.textContent=language;
    const copy=document.createElement('button');copy.type='button';copy.textContent='复制';copy.onclick=()=>onCopy(code?.textContent || pre.textContent);
    label.append(title,copy);pre.replaceWith(wrapper);wrapper.append(label,pre);
  }
  return node;
}
