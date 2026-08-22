from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
cmms_anchor = '    <script src="cmms-v2.js"></script>'
cycle_tag = '    <script src="preventive-cycle-ui.js"></script>'
mobile_tag = '    <script src="mobile-polish.js"></script>'
changed = False

if cycle_tag not in text:
    if cmms_anchor not in text:
        raise SystemExit('cmms-v2.js não encontrado no index.html')
    text = text.replace(cmms_anchor, cmms_anchor + '\n' + cycle_tag, 1)
    changed = True

if mobile_tag not in text:
    anchor = cycle_tag if cycle_tag in text else cmms_anchor
    text = text.replace(anchor, anchor + '\n' + mobile_tag, 1)
    changed = True

if changed:
    p.write_text(text, encoding='utf-8', newline='\n')
    print('Visualização preventiva e acabamento mobile instalados.')
else:
    print('Visualização preventiva e acabamento mobile já instalados.')
