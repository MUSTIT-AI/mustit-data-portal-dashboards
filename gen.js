// 랜딩 목록 생성기 — 사용법: node gen.js  (dashboards/ 스캔 → dashboards.json 갱신)
const fs=require('fs');const dir='dashboards';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.html'));
const pick=(s,re)=>{const m=s.match(re);return m?m[1].trim():null;};
const items=files.sort().map(f=>{let s='';try{s=fs.readFileSync(dir+'/'+f,'utf8')}catch(e){}
 const title=pick(s,/<meta\s+name=["']dash-title["']\s+content=["']([^"']+)["']/i)||pick(s,/<title>([\s\S]*?)<\/title>/i)||f.replace(/\.html$/,'');
 const desc=pick(s,/<meta\s+name=["']dash-desc["']\s+content=["']([^"']+)["']/i)||'';
 const icon=pick(s,/<meta\s+name=["']dash-icon["']\s+content=["']([^"']+)["']/i)||'📊';
 return {file:f,title,desc,icon};});
fs.writeFileSync('dashboards.json',JSON.stringify(items,null,2));
console.log('dashboards.json 갱신:',items.length,'개');
