// Codex rollouts use cumulative counters. Persist the cursor AND counters atomically
// with the aggregates so duplicate token_count notifications and retries cannot add twice.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { walkJsonl } from './transcripts.ts';

export async function sampleCodexUsage(configPath: string) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const root = cfg.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const db = openDb(cfg.db);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS codex_offsets (
      user TEXT NOT NULL, session TEXT NOT NULL, offset INTEGER NOT NULL,
      counters TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY(user, session));`);
    const get = db.query('SELECT * FROM codex_offsets WHERE user=? AND session=?');
    const save = db.query('INSERT OR REPLACE INTO codex_offsets VALUES (?, ?, ?, ?, ?)');
    const upHour = db.query(`INSERT INTO hourly(user,hour_utc,input,output,cache_creation,cache_read,total) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user,hour_utc) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,
      cache_creation=cache_creation+excluded.cache_creation,cache_read=cache_read+excluded.cache_read,total=total+excluded.total`);
    const upCum = db.query(`INSERT INTO cumulative(user,input,output,cache_creation,cache_read,total) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,
      cache_creation=cache_creation+excluded.cache_creation,cache_read=cache_read+excluded.cache_read,total=total+excluded.total`);
    const upModel = db.query(`INSERT INTO model_usage(user,minute_utc,model,input,output,cache_creation,cache_read,total) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user,minute_utc,model) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,
      cache_creation=cache_creation+excluded.cache_creation,cache_read=cache_read+excluded.cache_read,total=total+excluded.total`);
    for (const path of [...walkJsonl(join(root,'sessions')), ...walkJsonl(join(root,'archived_sessions'))]) {
      const bytes = readFileSync(path);
      const end = bytes.lastIndexOf(10) + 1;
      if (!end) continue;
      let header: any;
      try { header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()); } catch { continue; }
      const id = header.type === 'session_meta' && header.payload?.id;
      if (!id) continue;
      // Session id survives archival/rename. Forked transcripts may repeat history;
      // cumulative high-water counters prevent repeated snapshots within a session.
      db.transaction(() => {
        const state: any = get.get(cfg.owner,id);
        if (state && end <= state.offset) return;
        let counters = state ? JSON.parse(state.counters) : {};
        let model = state?.model || 'unknown';
        const models = new Set<string>();
        let last: string | null = null;
        for (const line of bytes.subarray(state?.offset || 0,end).toString().split('\n')) {
          let r: any; try { r=JSON.parse(line); } catch { continue; }
          if (r.type === 'turn_context' && r.payload?.model) model=r.payload.model;
          if (r.type !== 'event_msg' || r.payload?.type !== 'token_count') continue;
          const t=r.payload.info?.total_token_usage;
          if (!t || !Number.isFinite(Date.parse(r.timestamp))) continue;
          const delta: any = {};
          for (const k of ['input_tokens','output_tokens','cached_input_tokens','cache_write_input_tokens']) {
            const v=Number(t[k] || 0);
            if (!Number.isSafeInteger(v) || v < 0) throw new Error('Invalid Codex counter');
            delta[k]=Math.max(0,v-(counters[k] || 0));
            counters[k]=Math.max(v,counters[k] || 0);
          }
          const cr=delta.cached_input_tokens, cc=delta.cache_write_input_tokens;
          // Cached tokens are included in input; reasoning is included in output.
          const input=Math.max(0,delta.input_tokens-cr-cc), output=delta.output_tokens;
          const total=input+output+cc+cr;
          if (!total) continue;
          const iso=new Date(r.timestamp).toISOString();
          upHour.run(cfg.owner,iso.slice(0,13),input,output,cc,cr,total);
          upCum.run(cfg.owner,input,output,cc,cr,total);
          upModel.run(cfg.owner,iso.slice(0,16),model,input,output,cc,cr,total);
          models.add(model);
          if (!last || iso > last) last=iso;
        }
        save.run(cfg.owner,id,end,JSON.stringify(counters),model);
        const meta: any = db.query('SELECT * FROM meta WHERE user=?').get(cfg.owner);
        for (const m of JSON.parse(meta?.models || '[]')) models.add(m);
        if (meta?.last_activity && (!last || meta.last_activity > last)) last=meta.last_activity;
        db.query('INSERT OR REPLACE INTO meta(user,sessions,models,last_activity) VALUES(?,?,?,?)')
          .run(cfg.owner,(meta?.sessions || 0)+(state ? 0 : 1),JSON.stringify([...models].sort()),last);
      })();
    }
  } finally { db.close(); }
}
