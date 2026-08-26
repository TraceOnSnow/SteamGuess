#!/usr/bin/env python3
"""Import independent AI difficulty candidates into catalog SQLite."""
from __future__ import annotations
import argparse, json
from datetime import datetime, timezone
from pathlib import Path
from scripts.catalog.database import connect, initialize

def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def level(score): return 'beginner' if score < 15 else 'easy' if score < 25 else 'normal' if score < 50 else 'hard' if score < 75 else 'hell'
def main():
 p=argparse.ArgumentParser()
 p.add_argument('--db',default='data/catalog/catalog.sqlite')
 p.add_argument('--candidates',default='data/analysis/difficulty-ai-v3/deepseek-v4-flash-candidates.json')
 p.add_argument('--source-path',default='data/analysis/difficulty-ai-v3/deepseek-v4-flash-candidates.json')
 args=p.parse_args()
 payload=json.loads(Path(args.candidates).read_text(encoding='utf-8'))
 rows=payload.get('evaluations',[])
 model=str(payload.get('model') or 'unknown'); prompt=str(payload.get('rubricVersion') or 'unknown'); evaluated=now()
 db=connect(Path(args.db)); initialize(db)
 imported=0
 try:
  for row in rows:
   appid=int(row['appId']); score=row['score']
   if type(score) is not int or not 0<=score<=100 or row.get('level')!=level(score): raise ValueError(f'invalid candidate {appid}')
   db.execute('''INSERT INTO difficulty_ai_candidates(appid,score,level,confidence,reason,eligible,exclusion_reason,review_priority,model,prompt_version,evaluated_at,source_path)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(appid) DO UPDATE SET score=excluded.score,level=excluded.level,confidence=excluded.confidence,reason=excluded.reason,eligible=excluded.eligible,exclusion_reason=excluded.exclusion_reason,review_priority=excluded.review_priority,model=excluded.model,prompt_version=excluded.prompt_version,evaluated_at=excluded.evaluated_at,source_path=excluded.source_path''',
   (appid,score,row['level'],float(row['confidence']),str(row['reason']),int(bool(row['eligible'])),row.get('exclusionReason'),row['reviewPriority'],model,prompt,evaluated,args.source_path)); imported+=1
  db.commit()
 finally: db.close()
 print(f'imported={imported} db={args.db}')
if __name__=='__main__': main()
