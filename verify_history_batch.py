# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
import requests

KEY=os.environ['FIREBASE_KEY']
PROJ=os.environ.get('FIREBASE_PROJ','sala-valvulas-ow-163b3')
ROOT=f'https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents'
def u(path): return f'{ROOT}/{path}?key={KEY}'
def get(path): return requests.get(u(path),timeout=30)
def sval(fields,name): return fields.get(name,{}).get('stringValue','')
def arr(fields,name): return [x.get('stringValue','') for x in fields.get(name,{}).get('arrayValue',{}).get('values',[])]

def main():
    src=sys.argv[1] if len(sys.argv)>1 else 'history_verify_request.json'
    dst=sys.argv[2] if len(sys.argv)>2 else 'history_verify_status.json'
    cfg=json.loads(Path(src).read_text(encoding='utf-8'))
    if not cfg.get('enabled',False): return
    items=[]; ok=True
    for pid in cfg.get('pageIds',[]):
        ir=get(f'sync_index/{pid}')
        if ir.status_code!=200:
            items.append({'pageId':pid,'status':'missing_index'}); ok=False; continue
        f=ir.json().get('fields',{}); line=sval(f,'line'); valve=sval(f,'valve'); ids=[x for x in arr(f,'recordIds') if x]
        docs=[]; item_ok=bool(ids)
        for rid in ids:
            r=get(f'lines/{line}/valves/{valve}/history/{rid}')
            if r.status_code==200:
                hf=r.json().get('fields',{})
                docs.append({'recordId':rid,'subset':sval(hf,'subset'),'type':sval(hf,'type'),'status':sval(hf,'status'),'notionPageId':sval(hf,'notionPageId')})
                if sval(hf,'notionPageId')!=pid: item_ok=False
            else:
                docs.append({'recordId':rid,'missing':True}); item_ok=False
        items.append({'pageId':pid,'status':'verified' if item_ok else 'failed','line':line,'valve':valve,'records':docs})
        ok=ok and item_ok
    out={'status':'verified' if ok else 'partial','requestedAt':cfg.get('requestedAt',''),'verifiedAt':datetime.now(timezone.utc).isoformat(),'items':items,'message':'Históricos conferidos por sync_index e releitura dos documentos Firebase.'}
    Path(dst).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
