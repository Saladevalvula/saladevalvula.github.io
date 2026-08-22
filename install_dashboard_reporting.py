from pathlib import Path

p = Path('index.html')
text = p.read_text(encoding='utf-8')
anchor = '    <script src="cmms-v2.js"></script>'
report_tag = '    <script src="dashboard-reporting.js"></script>'
pdf_tag = '    <script src="dashboard-reporting-pdf.js"></script>'

if anchor not in text:
    raise SystemExit('cmms-v2.js não encontrado no index.html')

changed = False
if report_tag not in text:
    text = text.replace(anchor, anchor + '\n' + report_tag, 1)
    changed = True

if pdf_tag not in text:
    if report_tag not in text:
        raise SystemExit('dashboard-reporting.js não encontrado após instalação')
    text = text.replace(report_tag, report_tag + '\n' + pdf_tag, 1)
    changed = True

if changed:
    p.write_text(text, encoding='utf-8', newline='\n')
    print('Dashboard mensal e exportação PDF instalados no index.html')
else:
    print('Dashboard mensal e exportação PDF já instalados no index.html')
