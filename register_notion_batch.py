# -*- coding: utf-8 -*-
import json, sys
from datetime import datetime, timezone
from pathlib import Path
from register_notion_page import register_page

def main():
    src=sys.argv[1] if len(sys.argv)>1 else 'maintenance_batch_dispatch.json'
    dst=sys.argv[2] if len(sys.argv)>2 else 'maintenance_batch_status.json'
    cfg=json.loads(Path(src).read_text(encoding='utf-8'))
    if not cfg.get('enabled',False): return
    results=[]
    try:
        for page_id in cfg.get('pageIds',[]):
            results.append(register_page(str(page_id)))
        out={'status':'verified','requestedAt':cfg.get('requestedAt',''),'verifiedAt':datetime.now(timezone.utc).isoformat(),'count':len(results),'items':results,'message':'Lote registrado e verificado no Firebase V2.'}
    except Exception as exc:
        out={'status':'failed','requestedAt':cfg.get('requestedAt',''),'verifiedAt':datetime.now(timezone.utc).isoformat(),'items':results,'error':str(exc)}
        Path(dst).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        raise
    Path(dst).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
