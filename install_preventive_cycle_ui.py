from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
anchor = '    <script src="cmms-v2.js"></script>'
tag = '    <script src="preventive-cycle-ui.js"></script>'

if tag in text:
    print('Visualização do ciclo preventivo já instalada.')
elif anchor not in text:
    raise SystemExit('cmms-v2.js não encontrado no index.html')
else:
    text = text.replace(anchor, anchor + '\n' + tag, 1)
    p.write_text(text, encoding='utf-8', newline='\n')
    print('Visualização do ciclo preventivo instalada.')
