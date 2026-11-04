import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { sampleModelUsage } from '../model-collector.ts';
import { sampleCodexUsage } from '../codex-collector.ts';

test('Codex backfill, repeated counters, partial records, model switch and archival are idempotent', async () => {
 const dir=mkdtempSync(join(tmpdir(),'ct-codex-usage-'));
 try {
  mkdirSync(join(dir,'sessions')); mkdirSync(join(dir,'archived_sessions'));
  const config=join(dir,'config.json'), dbPath=join(dir,'usage.db'), file=join(dir,'sessions','test.jsonl');
  writeFileSync(config,JSON.stringify({owner:'owner',db:dbPath,dataDir:join(dir,'claude'),codexHome:dir}));
  const line=(type:string,payload:any)=>JSON.stringify({timestamp:'2026-11-04T12:34:00Z',type,payload})+'\n';
  const tokens=(input:number,output:number,cached:number)=>line('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:cached,reasoning_output_tokens:output/2}}});
  writeFileSync(file,line('session_meta',{id:'test'})+line('turn_context',{model:'gpt-6-astra'})+tokens(1000,100,800)+tokens(1000,100,800));
  await sampleModelUsage(config); await sampleCodexUsage(config); await sampleCodexUsage(config);
  const db=new Database(dbPath);
  expect(db.query('SELECT input,output,cache_read,total FROM cumulative').get()).toEqual({input:200,output:100,cache_read:800,total:1100});
  const tail=tokens(1500,150,1200);
  appendFileSync(file,line('turn_context',{model:'gpt-6.1-sol'})+tail.slice(0,-1));
  await sampleCodexUsage(config);
  expect((db.query('SELECT total FROM cumulative').get() as any).total).toBe(1100);
  appendFileSync(file,'\n'); await sampleCodexUsage(config);
  renameSync(file,join(dir,'archived_sessions','test.jsonl')); await sampleCodexUsage(config);
  expect(db.query('SELECT input,output,cache_read,total FROM cumulative').get()).toEqual({input:300,output:150,cache_read:1200,total:1650});
  expect(db.query('SELECT model,total FROM model_usage ORDER BY model').all()).toEqual([{model:'gpt-6-astra',total:1100},{model:'gpt-6.1-sol',total:550}]);
  expect((db.query('SELECT SUM(total) AS total FROM hourly').get() as any).total).toBe(1650);
  db.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});
