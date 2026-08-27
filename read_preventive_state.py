# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
import requests

KEY=os.environ['FIREBASE_KEY']
PROJ=os.environ.get('FIREBASE_PROJ','sala-valvulas-ow-163b3')
ROOT=f'https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents'

def url(path): return f'{ROOT}/{path}?key={KEY}'
def dec(v):
    if 'stringValue' in v: return v['stringValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return float(v['doubleValue'])
    if 'booleanValue' in v: return bool(v['booleanValue'])
    if 'arrayValue' in v: return [dec(x) for x in v.get('arrayValue',{}).get('values',[])]
    return None
def fields(doc): return {k:dec(v) for k,v in doc.get('fields',{}).items()}

def main():
    req_path=sys.argv[1] if len(sys.argv)>1 else 'preventive_state_request.json'
    out_path=sys.argv[2] if len(sys.argv)>2 else 'preventive_state_status.json'
    req=json.loads(Path(req_path).read_text(encoding='utf-8'))
    if not req.get('enabled',False): return
    line=str(req.get('line','')).strip()
    r=requests.get(url(f'maintenance_cycle_state/{line}'),timeout=30)
    cycle=fields(r.json()) if r.status_code==200 else None
    pr=requests.get(f'{ROOT}/maintenance_plans?pageSize=100&key={KEY}',timeout=30)
    pr.raise_for_status()
    plans=[]
    for d in pr.json().get('documents',[]):
        f=fields(d)
        if str(f.get('line',''))==line:
            f['id']=d['name'].split('/')[-1]
            plans.append(f)
    plans.sort(key=lambda x:(str(x.get('month','')),str(x.get('plannedDate',''))), reverse=True)
    out={'status':'verified','line':line,'requestedAt':req.get('requestedAt',''),'verifiedAt':datetime.now(timezone.utc).isoformat(),'cycle':cycle,'plans':plans,'message':'Estado preventivo relido do Firebase.'}
    Path(out_path).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
