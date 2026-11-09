import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appRoutes, type AppCtx } from '../app-server';
const root = mkdtempSync(join(tmpdir(), 'chat-reliability-'));
const project = join(root, 'projects', 'fixture');
const cwd = join(root, 'archived-cwd');
const ctx = { allowed: () => true, cors: () => ({}), publicDir: root, dataDir: join(root,'projects'), historyHide: [], hideProjectDirs: [], defaultCwd: root, downloadRoots: [root], models: [], moreModels: [], guest: true, favoritesFile: join(root,'favs.json'), titlesFile: join(root,'titles.json'), autoTitlesFile: join(root,'auto.json'), readsFile: join(root,'reads.json'), mcpFile: join(root,'mcp.json'), claudeDir: root } as AppCtx;
async function call(path: string, init?: RequestInit) { return (await appRoutes(new Request('http://local'+path, init), path.split('?')[0], ctx))!; }
beforeAll(() => {
  mkdirSync(project, { recursive: true }); mkdirSync(cwd);
  for (let i=0; i<205; i++) writeFileSync(join(project,`fixture-${i}.jsonl`), JSON.stringify({type:'user', uuid:crypto.randomUUID(), cwd, timestamp: new Date(Date.now()-i*1000).toISOString(), message:{role:'user',content:i===204?'old message with "escaped needle"':'ordinary conversation '+i}})+'\n');
  writeFileSync(ctx.titlesFile, JSON.stringify({'fixture-203':'Ancient renamed title'}));
});
afterAll(() => rmSync(root,{recursive:true,force:true}));
test('search reaches content and renamed titles beyond the former 200-chat cap', async () => {
  for (const [q,id] of [['"escaped needle"','fixture-204'],['Ancient renamed','fixture-203']]) {
    let offset=0; const ids:string[]=[];
    for(let page=0;page<210;page++) {
      const r=await call(`/app/api/search?q=${encodeURIComponent(q)}&offset=${offset}`); expect(r.status).toBe(200);
      const d=await r.json(); ids.push(...d.results.map((h:any)=>h.sessionId));
      if(!d.hasMore) break; expect(d.nextOffset).toBeGreaterThan(offset); offset=d.nextOffset;
    }
    expect(ids).toContain(id);
  }
});
async function upload(text:string, name='sample.txt', extra:Record<string,string>={}) {
  const form=new FormData(); form.append('file',new File([text],name)); form.append('id','fixture-204');
  for(const [k,v] of Object.entries(extra)) form.append(k,v);
  return call('/app/api/upload',{method:'POST',body:form});
}
test('historical uploads use the chat cwd and preserve earlier same-name files',async()=>{
  const a=await (await upload('first')).json(), b=await (await upload('second')).json();
  expect(a.path).toStartWith(join(cwd,'uploads')); expect(a.path).not.toBe(b.path);
  expect(await Bun.file(a.path).text()).toBe('first'); expect(await Bun.file(b.path).text()).toBe('second');
  const r=await call(`/app/api/download?id=fixture-204&path=${encodeURIComponent(a.path+':42')}`);
  expect(r.status).toBe(200); expect(await r.text()).toBe('first');
});
test('chunk retries preserve bytes and retrying the final response returns the same file', async()=>{
  const uploadId=crypto.randomUUID();
  expect((await upload('abc','chunks.txt',{uploadId,offset:'0'})).status).toBe(200);
  const opts={uploadId,offset:'3',done:'1'};
  const a=await (await upload('def','chunks.txt',opts)).json();
  const b=await (await upload('def','chunks.txt',opts)).json();
  expect(b.path).toBe(a.path); expect(await Bun.file(a.path).text()).toBe('abcdef');
  expect((await upload('gap','gap.txt',{uploadId:crypto.randomUUID(),offset:'3'})).status).toBe(409);
});
test('downloads still reject paths outside allowed roots',async()=>{
  expect((await call('/app/api/download?path=/etc/passwd')).status).toBe(403);
});

test('history search replaces cached attachment scaffolding with the request', async () => {
  const id = 'fixture-attachment';
  writeFileSync(join(project, id + '.jsonl'), [
    {type:'user', uuid:crypto.randomUUID(), cwd, message:{role:'user',content:'Attached files:\n/tmp/photo.png\n\nDesign robot buttons'}},
    {type:'summary', summary:'Attached files: /tmp/photo.png'},
    {type:'assistant', message:{role:'assistant',content:[{type:'text',text:'<title>Attached files</title>Here you go.'}]}}
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const response = await call('/app/api/search?q=Design%20robot%20buttons');
  const data = await response.json();
  expect(data.results.find((row:any) => row.sessionId === id)?.title).toBe('Design robot buttons');
});
