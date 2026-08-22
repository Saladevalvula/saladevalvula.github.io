from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
anchor = '    <script src="cmms-v2.js"></script>'
tag = '    <script src="dashboard-reporting.js"></script>'

if tag in text:
    print('Dashboard mensal já instalado no index.html')
elif anchor not in text:
    raise SystemExit('cmms-v2.js não encontrado no index.html')
else:
    text = text.replace(anchor, anchor + '\n' + tag, 1)
    p.write_text(text, encoding='utf-8', newline='\n')
    print('Dashboard mensal instalado no index.html')
