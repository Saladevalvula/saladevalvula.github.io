from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
tag = '    <script src="cmms-v2.js"></script>'
if tag in text:
    print('CMMS V2 já instalado no index.html')
else:
    if '</body>' not in text:
        raise SystemExit('index.html sem </body>')
    text = text.replace('</body>', tag + '\n</body>', 1)
    p.write_text(text, encoding='utf-8', newline='\n')
    print('CMMS V2 instalado no index.html')
