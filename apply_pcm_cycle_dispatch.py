# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
import requests

KEY=os.environ['FIREBASE_KEY']
PROJ=os.environ.get('FIREBASE_PROJ','sala-valvulas-ow-163b3')
ROOT=f'https://firestore.googleapis.com/v1/projects/{PROJ}/databases/(default)/documents'
MAX={'512':175,'513':175,'514':72}

def u(path): return f'{ROOT}/{path}?key={KEY}'
def s(v): return {'stringValue':str(v)}
def i(v): return {'integerValue':str(int(v))}
def b(v): return {'booleanValue':bool(v)}
def arr(vals): return {'arrayValue':{'values':vals}}
def ints(vals): return arr([i(v) for v in vals])
def strings(vals): return arr([s(v) for v in vals])
def dec(v):
    if 'stringValue' in v:return v['stringValue']
    if 'integerValue' in v:return int(v['integerValue'])
    if 'booleanValue' in v:return bool(v['booleanValue'])
    if 'arrayValue' in v:return [dec(x) for x in v.get('arrayValue',{}).get('values',[])]
    return None
def fields(doc): return {k:dec(v) for k,v in doc.get('fields',{}).items()}
def get(path): return requests.get(u(path),timeout=30)
def patch(path,fs):
    r=requests.patch(u(path),json={'fields':fs},timeout=30); r.raise_for_status(); return r

def main():
    src=sys.argv[1] if len(sys.argv)>1 else 'pcm_cycle_dispatch.json'
    dst=sys.argv[2] if len(sys.argv)>2 else 'pcm_cycle_status.json'
    cfg=json.loads(Path(src).read_text(encoding='utf-8'))
    if not cfg.get('enabled',False): return
    line=str(cfg['line']); done=[int(x) for x in cfg['completedValves']]; nxt=[int(x) for x in cfg['nextValves']]
    cm=str(cfg['completedMonth']); nm=str(cfg['nextMonth']); req=str(cfg.get('requestId',''))
    if line not in MAX or not done or not nxt: raise ValueError('configuração inválida')
    if done != list(range(done[0],done[-1]+1)) or nxt != list(range(nxt[0],nxt[-1]+1)): raise ValueError('blocos devem ser sequenciais')
    if nxt[0] != done[-1]+1: raise ValueError('próximo bloco deve continuar sequência')
    ts=datetime.now(timezone.utc).isoformat()

    old_path=f'maintenance_plans/{cm}-{line}'
    old_r=get(old_path); old_r.raise_for_status(); old=old_r.json(); of=fields(old)
    if [int(x) for x in (of.get('valves') or [])] != done: raise RuntimeError(f'plano atual divergente: {of.get("valves")}')
    old_fields=old.get('fields',{}).copy()
    old_fields['completedValves']=ints(done); old_fields['status']=s('concluido'); old_fields['updatedAt']=s(ts); old_fields['lastRequestId']=s(req)
    patch(old_path,old_fields)

    through=done[-1]
    cycle_path=f'maintenance_cycle_state/{line}'
    cycle_fields={
      'line':s(line),'lastCompletedValve':i(through),'completedThrough':i(through),'completedCount':i(through),'baselineCompletedCount':i(through),
      'sapCompletedValves':ints([]),'nextValve':i(nxt[0]),'cycleMax':i(MAX[line]),'source':s('chatgpt_pcm_completion'),
      'baselineOnly':b(True),'note':s(f'PCM concluído até V{through}; próximo bloco V{nxt[0]}–V{nxt[-1]} programado sem ordem SAP.'),
      'updatedAt':s(ts),'lastRequestId':s(req)
    }
    patch(cycle_path,cycle_fields)

    next_path=f'maintenance_plans/{nm}-{line}'
    nr=get(next_path)
    if nr.status_code==200:
        nf=fields(nr.json())
        if [int(x) for x in (nf.get('valves') or [])] != nxt: raise RuntimeError(f'já existe plano conflitante em {nm}: {nf.get("valves")}')
        created=nr.json().get('fields',{}).get('createdAt',s(ts))
    elif nr.status_code==404:
        created=s(ts)
    else: nr.raise_for_status()
    next_fields={
      'month':s(nm),'line':s(line),'targetCount':i(len(nxt)),'startValve':i(nxt[0]),'endValve':i(nxt[-1]),'valves':ints(nxt),
      'completedValves':ints([]),'linkedSapOrderIds':strings([]),'status':s('planejado'),'previousCompletedThrough':i(through),
      'source':s('chatgpt_pcm_schedule'),'createdAt':created,'updatedAt':s(ts),'lastRequestId':s(req)
    }
    patch(next_path,next_fields)

    oc=fields(get(old_path).json()); cc=fields(get(cycle_path).json()); nc=fields(get(next_path).json())
    if oc.get('status')!='concluido' or [int(x) for x in oc.get('completedValves',[])]!=done: raise RuntimeError('baixa do plano não confirmada')
    if int(cc.get('completedThrough',0))!=through or int(cc.get('nextValve',0))!=nxt[0]: raise RuntimeError('ciclo não confirmado')
    if [int(x) for x in nc.get('valves',[])]!=nxt or nc.get('status')!='planejado': raise RuntimeError('próximo plano não confirmado')
    out={'status':'verified','requestId':req,'requestedAt':cfg.get('requestedAt',''),'verifiedAt':datetime.now(timezone.utc).isoformat(),'line':line,'completedMonth':cm,'completedValves':done,'completedThrough':through,'nextMonth':nm,'nextValves':nxt,'nextValve':nxt[0],'linkedSapOrderIds':nc.get('linkedSapOrderIds',[]),'message':'Bloco PCM concluído e próxima revisão programada após releitura do Firebase.'}
    Path(dst).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__': main()
