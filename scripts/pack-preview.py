#!/usr/bin/env python3
"""Package only generated native assets for Mac developer-tools preview."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import subprocess

root = Path(__file__).resolve().parents[1]
app = root / 'app/miniprogram'
checked = subprocess.run(['node', str(root / 'scripts/asset-inventory.cjs'), str(app)], capture_output=True, text=True)
if checked.returncode:
    raise SystemExit(checked.stderr.strip() or 'Asset inventory failed')
files = json.loads(checked.stdout)
meta = json.loads((app / 'build-meta.json').read_text())
if meta['mode'] != 'mock' or meta['target'] != 'test':
    raise SystemExit('This preview packager only accepts an explicit mock/test build.')
if not (app / 'app.js').is_file():
    raise SystemExit('Run npm run build first.')
output = root / 'dist' / 'OR_ADV-mock-preview.zip'
if output.parent.is_symlink() or output.is_symlink():
    raise SystemExit('Preview output cannot be a symbolic link.')
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for relative in files:
        archive.write(app / relative, 'OR_ADV-preview/' + relative)
    archive.writestr('先读我.txt', 'OR ADV 模拟内测版\n在 Mac 微信开发者工具导入 OR_ADV-preview 目录，点击预览，用开发者本人微信扫码。\n这是本机虚构数据，不共享到其他手机，不是已部署的云端内测版。\n所有角色切换仅在模拟模式可用。真实内测需先开通测试云环境。\n')
print(f'Created {output.relative_to(root)} ({output.stat().st_size:,} bytes); MOCK ONLY.')
