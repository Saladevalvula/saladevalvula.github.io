from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
prelude = '    <script src="cmms-v2-prelude.js"></script>'
main = '    <script src="cmms-v2.js"></script>'

changed = False
if prelude not in text:
    if '</body>' not in text:
        raise SystemExit('index.html sem </body>')
    text = text.replace('</body>', prelude + '\n' + main + '\n</body>', 1)
    changed = True
elif main not in text:
    text = text.replace(prelude, prelude + '\n' + main, 1)
    changed = True

# Corrige uma instalação antiga que tenha apenas cmms-v2.js.
if main in text and prelude not in text:
    text = text.replace(main, prelude + '\n' + main, 1)
    changed = True

# Garante uma única ocorrência de cada script e a ordem prelude -> principal.
while text.count(prelude) > 1:
    text = text.replace(prelude + '\n', '', 1)
while text.count(main) > 1:
    text = text.replace(main + '\n', '', 1)
if text.find(main) < text.find(prelude):
    text = text.replace(main + '\n', '', 1)
    text = text.replace(prelude, prelude + '\n' + main, 1)
    changed = True

if changed:
    p.write_text(text, encoding='utf-8', newline='\n')
    print('CMMS V2 instalado/ajustado no index.html')
else:
    print('CMMS V2 já instalado corretamente no index.html')
